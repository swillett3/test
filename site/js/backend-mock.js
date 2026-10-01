// In-browser stand-in for Firestore, used by the automated tests and for rehearsing on one computer.
// It stores everything in localStorage (so every tab in the same browser shares it) and enforces
// the same access rules as firestore.rules, so the tests catch a page that asks for data it shouldn't.

import { ADMIN_EMAILS } from "./config.js";
import { LIMITS } from "./model.js";

const P = "csim-mock:";
const USER_KEY = "csim-mock-user";
const listeners = new Map(); // path -> Set(fn)

function read(path) {
  try {
    const v = localStorage.getItem(P + path);
    return v == null ? null : JSON.parse(v);
  } catch {
    return null;
  }
}
function write(path, value) {
  if (value == null) localStorage.removeItem(P + path);
  else localStorage.setItem(P + path, JSON.stringify(value));
  notify(path);
}
function notify(path) {
  for (const fn of listeners.get(path) || []) setTimeout(fn, 0);
}
window.addEventListener("storage", (e) => {
  if (e.key && e.key.startsWith(P)) notify(e.key.slice(P.length));
});
function listen(path, fn) {
  if (!listeners.has(path)) listeners.set(path, new Set());
  listeners.get(path).add(fn);
  setTimeout(fn, 0);
  return () => listeners.get(path).delete(fn);
}

const denied = () => Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
const wait = (v) => new Promise((r) => setTimeout(() => r(v), 15));

export async function createBackend() {
  let user = null;
  try {
    user = JSON.parse(sessionStorage.getItem(USER_KEY) || "null");
  } catch {}
  const authCbs = new Set();
  const setUser = (u) => {
    user = u;
    if (u) sessionStorage.setItem(USER_KEY, JSON.stringify(u));
    else sessionStorage.removeItem(USER_KEY);
    for (const cb of authCbs) setTimeout(() => cb(user), 0);
  };
  const isAdmin = () => !!(user && user.email && ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(user.email.toLowerCase()));
  const needAdmin = () => {
    if (!isAdmin()) throw denied();
  };

  function watch(path, map, cb, err, adminOnly) {
    return listen(path, () => {
      if (adminOnly && !isAdmin()) return err && err(denied());
      cb(map(read(path)), { fromCache: false });
    });
  }

  const api = {
    kind: "mock",
    onAuth(cb) {
      authCbs.add(cb);
      setTimeout(() => cb(user), 0);
      return () => authCbs.delete(cb);
    },
    currentUser() {
      return user;
    },
    async signInStudent() {
      if (user) return user;
      setUser({ uid: "anon-" + Math.random().toString(36).slice(2, 10), email: null, isAnonymous: true });
      return wait(user);
    },
    async signInAdmin() {
      const email = new URLSearchParams(location.search).get("mockEmail") || ADMIN_EMAILS[0];
      setUser({ uid: "g-" + email, email, isAnonymous: false });
      return wait(user);
    },
    async signOut() {
      setUser(null);
    },

    watchConfig: (cb, err) => watch("public/config", (d) => d || {}, cb, err),
    watchFeed: (cb, err) => watch("public/feed", (d) => (d && d.items) || {}, cb, err),
    watchScript: (cb, err) => watch("private/script", (d) => ({ items: (d && d.items) || {}, meta: (d && d.meta) || null }), cb, err, true),
    watchControl: (cb, err) => watch("private/control", (d) => d || {}, cb, err, true),
    watchResponses: (cb, err) =>
      watch(
        "responses",
        (d) => Object.entries(d || {}).map(([id, r]) => ({ id, ...r })).sort((a, b) => b.createdAt - a.createdAt),
        cb,
        err,
        true,
      ),

    async saveConfig(patch) {
      needAdmin();
      write("public/config", { ...(read("public/config") || {}), ...patch });
      return wait();
    },
    async saveControl(patch) {
      needAdmin();
      write("private/control", { ...(read("private/control") || {}), ...patch });
      return wait();
    },
    async importScript(items, meta) {
      needAdmin();
      write("private/script", { items: JSON.parse(JSON.stringify(items)), meta });
      return wait();
    },
    async saveScriptItem(item) {
      needAdmin();
      const s = read("private/script") || { items: {}, meta: null };
      s.items[item.id] = JSON.parse(JSON.stringify(item));
      write("private/script", s);
      return wait();
    },
    async deleteScriptItem(id) {
      needAdmin();
      const s = read("private/script") || { items: {}, meta: null };
      delete s.items[id];
      write("private/script", s);
      return wait();
    },
    async release(entries) {
      needAdmin();
      const f = read("public/feed") || { items: {} };
      const released = new Set(Object.values(f.items).map((e) => e.sourceId));
      const keys = [];
      for (const e of entries) {
        if (f.items[e.key]) continue;
        if (e.onlyIfNew && released.has(e.entry.sourceId)) continue;
        f.items[e.key] = JSON.parse(JSON.stringify(e.entry));
        keys.push(e.key);
      }
      if (keys.length) write("public/feed", f);
      return wait(keys);
    },
    async updateFeedEntry(key, entry) {
      needAdmin();
      const f = read("public/feed") || { items: {} };
      if (!f.items[key]) return wait(false); // retracted meanwhile: don't bring it back
      f.items[key] = JSON.parse(JSON.stringify(entry));
      write("public/feed", f);
      return wait(true);
    },
    async retract(key) {
      needAdmin();
      const f = read("public/feed") || { items: {} };
      delete f.items[key];
      write("public/feed", f);
      return wait();
    },
    async clearFeed() {
      needAdmin();
      write("public/feed", { items: {} });
      return wait();
    },
    async submitResponse(r) {
      if (!user) throw denied();
      const allowed = ["team", "role", "kind", "text", "replyTo", "name", "uid"];
      const ok =
        Object.keys(r).every((k) => allowed.includes(k)) &&
        r.uid === user.uid &&
        typeof r.text === "string" && r.text.length > 0 && r.text.length <= LIMITS.text &&
        typeof r.team === "string" && r.team.length <= LIMITS.team &&
        typeof r.role === "string" && r.role.length <= LIMITS.role &&
        typeof r.kind === "string" && r.kind.length <= LIMITS.kind &&
        (r.replyTo == null || (typeof r.replyTo === "string" && r.replyTo.length <= LIMITS.replyTo)) &&
        (r.name == null || (typeof r.name === "string" && r.name.length <= LIMITS.name));
      if (!ok) throw denied();
      const all = read("responses") || {};
      const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      all[id] = { ...r, createdAt: Date.now() };
      write("responses", all);
      return wait({ id });
    },
    async markResponse(id, patch) {
      needAdmin();
      const all = read("responses") || {};
      if (!all[id]) throw Object.assign(new Error("No such response"), { code: "not-found" });
      all[id] = { ...all[id], ...patch };
      write("responses", all);
      return wait();
    },
    async deleteAllResponses() {
      needAdmin();
      const n = Object.keys(read("responses") || {}).length;
      write("responses", {});
      return wait(n);
    },
    async selfCheck() {
      return [{ label: "Test mode: the security self-check only runs against your real Firebase project.", expect: "—", got: "—", ok: true }];
    },
    /** Test helper: wipe everything this mock stores. */
    resetAll() {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(P))
        .forEach((k) => localStorage.removeItem(k));
      ["public/config", "public/feed", "private/script", "private/control", "responses"].forEach(notify);
    },
  };
  return api;
}
