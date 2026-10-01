// Firestore backend. Data layout (see firestore.rules):
//   public/config    { title, company, simStart, firstReleaseDelayMin, teams[], roles[] }      read: anyone
//   public/feed      { items: { <key>: "<json of released item>" } }                          read: anyone
//   private/script   { items: { <id>: "<json of script item>" }, meta }                       admins only
//   private/control  { autoRelease }                                                          admins only
//   responses/<id>   { team, role, kind, text, replyTo?, name?, uid, createdAt, handled? }   create: any signed-in; read: admins
// Items are stored as JSON strings inside one document so 50 students cost one read per update, not one per item.

import { FIREBASE_CONFIG } from "./config.js";

const V = "10.12.2";
const BASE = `https://www.gstatic.com/firebasejs/${V}`;

function parseItems(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    try {
      const o = typeof v === "string" ? JSON.parse(v) : v;
      if (o && typeof o === "object") out[k] = o;
    } catch {
      /* skip a corrupt entry rather than break the feed */
    }
  }
  return out;
}

export async function createBackend() {
  const [appMod, fs, au] = await Promise.all([
    import(`${BASE}/firebase-app.js`),
    import(`${BASE}/firebase-firestore.js`),
    import(`${BASE}/firebase-auth.js`),
  ]);
  const app = appMod.initializeApp(FIREBASE_CONFIG);
  const db = fs.getFirestore(app);
  const auth = au.getAuth(app);

  const ref = {
    config: fs.doc(db, "public", "config"),
    feed: fs.doc(db, "public", "feed"),
    script: fs.doc(db, "private", "script"),
    control: fs.doc(db, "private", "control"),
    responses: fs.collection(db, "responses"),
  };

  const toUser = (u) => (u ? { uid: u.uid, email: u.email || null, isAnonymous: u.isAnonymous } : null);

  function watchDoc(r, map, cb, err, withMeta) {
    return fs.onSnapshot(
      r,
      { includeMetadataChanges: !!withMeta },
      (snap) => cb(map(snap.exists() ? snap.data() : null), { fromCache: snap.metadata.fromCache }),
      (e) => err && err(e),
    );
  }

  return {
    kind: "firebase",

    onAuth(cb) {
      return au.onAuthStateChanged(auth, (u) => cb(toUser(u)));
    },
    currentUser() {
      return toUser(auth.currentUser);
    },
    async signInStudent() {
      if (auth.currentUser) return toUser(auth.currentUser);
      const c = await au.signInAnonymously(auth);
      return toUser(c.user);
    },
    async signInAdmin() {
      const p = new au.GoogleAuthProvider();
      p.setCustomParameters({ prompt: "select_account" });
      const c = await au.signInWithPopup(auth, p);
      return toUser(c.user);
    },
    signOut() {
      return au.signOut(auth);
    },

    watchConfig(cb, err) {
      return watchDoc(ref.config, (d) => d || {}, cb, err);
    },
    watchFeed(cb, err) {
      return watchDoc(ref.feed, (d) => parseItems(d && d.items), cb, err, true);
    },
    watchScript(cb, err) {
      return watchDoc(ref.script, (d) => ({ items: parseItems(d && d.items), meta: (d && d.meta) || null }), cb, err);
    },
    watchControl(cb, err) {
      return watchDoc(ref.control, (d) => d || {}, cb, err);
    },
    watchResponses(cb, err) {
      const q = fs.query(ref.responses, fs.orderBy("createdAt", "desc"), fs.limit(2000));
      return fs.onSnapshot(
        q,
        (snap) =>
          cb(
            snap.docs.map((d) => {
              const x = d.data({ serverTimestamps: "estimate" });
              return { id: d.id, ...x, createdAt: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : Date.now() };
            }),
          ),
        (e) => err && err(e),
      );
    },

    saveConfig(patch) {
      return fs.setDoc(ref.config, patch, { merge: true });
    },
    saveControl(patch) {
      return fs.setDoc(ref.control, patch, { merge: true });
    },
    importScript(items, meta) {
      const enc = {};
      for (const [k, v] of Object.entries(items)) enc[k] = JSON.stringify(v);
      return fs.setDoc(ref.script, { items: enc, meta });
    },
    saveScriptItem(item) {
      return fs.setDoc(ref.script, { items: { [item.id]: JSON.stringify(item) } }, { merge: true });
    },
    deleteScriptItem(id) {
      return fs.updateDoc(ref.script, new fs.FieldPath("items", id), fs.deleteField());
    },

    /** entries: [{key, entry, onlyIfNew}]. Atomic; skips keys already present and, with onlyIfNew, items already released. */
    async release(entries) {
      return fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref.feed);
        const cur = parseItems(snap.exists() ? snap.data().items : {});
        const released = new Set(Object.values(cur).map((e) => e.sourceId));
        const add = {};
        const keys = [];
        for (const e of entries) {
          if (cur[e.key] || add[e.key]) continue;
          if (e.onlyIfNew && released.has(e.entry.sourceId)) continue;
          add[e.key] = JSON.stringify(e.entry);
          keys.push(e.key);
        }
        if (keys.length) tx.set(ref.feed, { items: add }, { merge: true });
        return keys;
      });
    },
    async updateFeedEntry(key, entry) {
      return fs.updateDoc(ref.feed, new fs.FieldPath("items", key), JSON.stringify(entry));
    },
    async retract(key) {
      return fs.updateDoc(ref.feed, new fs.FieldPath("items", key), fs.deleteField());
    },
    clearFeed() {
      return fs.setDoc(ref.feed, { items: {} });
    },

    submitResponse(r) {
      return fs.addDoc(ref.responses, { ...r, createdAt: fs.serverTimestamp() });
    },
    markResponse(id, patch) {
      return fs.updateDoc(fs.doc(db, "responses", id), patch);
    },
    async deleteAllResponses() {
      let n = 0;
      for (;;) {
        const snap = await fs.getDocs(fs.query(ref.responses, fs.limit(400)));
        if (snap.empty) return n;
        const b = fs.writeBatch(db);
        snap.docs.forEach((d) => b.delete(d.ref));
        await b.commit();
        n += snap.size;
      }
    },

    /** Signs in as an anonymous "student" in a separate app instance and probes the live security rules. */
    async selfCheck() {
      const PROBE_TIMEOUT_MS = 10000;
      const withTimeout = (p) =>
        Promise.race([
          Promise.resolve().then(p),
          new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timed out after 10 s"), { code: "timeout" })), PROBE_TIMEOUT_MS)),
        ]);
      const name = "selfcheck-" + Date.now();
      const app2 = appMod.initializeApp(FIREBASE_CONFIG, name);
      const db2 = fs.getFirestore(app2);
      const auth2 = au.getAuth(app2);
      const results = [];
      const fail = (label, e) => results.push({ label, expect: "ok", got: "error: " + ((e && (e.code || e.message)) || e), ok: false });
      const probe = async (label, expect, fn) => {
        try {
          await withTimeout(fn);
          results.push({ label, expect, got: "allowed", ok: expect === "allowed" });
        } catch (e) {
          const denied = e && (e.code === "permission-denied" || /permission/i.test(e.message || ""));
          results.push({ label, expect, got: denied ? "denied" : "error: " + (e.code || e.message), ok: expect === "denied" && denied });
        }
      };
      let createdId = null;
      let anonUser = null;
      try {
        const cred = await withTimeout(() => au.signInAnonymously(auth2));
        anonUser = cred.user;
        const uid = anonUser.uid;
        const resp = (extra) => ({ team: "0", role: "CEO", kind: "question", text: "Security self-check (safe to ignore)", uid, createdAt: fs.serverTimestamp(), ...extra });
        await probe("Student can read the released feed", "allowed", () => fs.getDoc(fs.doc(db2, "public", "feed")));
        await probe("Student can read team list and start time", "allowed", () => fs.getDoc(fs.doc(db2, "public", "config")));
        await probe("Student cannot read the unreleased script", "denied", () => fs.getDoc(fs.doc(db2, "private", "script")));
        await probe("Student cannot change the unreleased script", "denied", () =>
          fs.setDoc(fs.doc(db2, "private", "script"), { items: { hack: "{}" } }, { merge: true }),
        );
        await probe("Student cannot read auto-release control", "denied", () => fs.getDoc(fs.doc(db2, "private", "control")));
        await probe("Student cannot add items to the feed", "denied", () =>
          fs.setDoc(fs.doc(db2, "public", "feed"), { items: { hack: "{}" } }, { merge: true }),
        );
        await probe("Student cannot change the start time", "denied", () => fs.setDoc(fs.doc(db2, "public", "config"), { simStart: 1 }, { merge: true }));
        await probe("Student can send a response", "allowed", async () => {
          const r = await fs.addDoc(fs.collection(db2, "responses"), resp());
          createdId = r.id;
        });
        await probe("Student cannot send a response as someone else", "denied", () => fs.addDoc(fs.collection(db2, "responses"), resp({ uid: "not-me" })));
        await probe("Student cannot send a response already marked handled", "denied", () => fs.addDoc(fs.collection(db2, "responses"), resp({ handled: true })));
        if (createdId) {
          await probe("Student cannot mark their own response handled", "denied", () => fs.updateDoc(fs.doc(db2, "responses", createdId), { handled: true }));
          await probe("Student cannot read back a single response", "denied", () => fs.getDoc(fs.doc(db2, "responses", createdId)));
        } else {
          results.push({ label: "Student cannot mark or read back a response (skipped: no response was created)", expect: "denied", got: "not run", ok: false });
        }
        await probe("Student cannot read other teams' responses", "denied", () => fs.getDocs(fs.query(fs.collection(db2, "responses"), fs.limit(1))));
        await probe("Student cannot send an oversized response", "denied", () => fs.addDoc(fs.collection(db2, "responses"), resp({ text: "x".repeat(4001) })));
      } catch (e) {
        results.push({ label: "Anonymous sign-in (enable it under Authentication → Sign-in method)", expect: "allowed", got: "error: " + (e.code || e.message), ok: false });
      }

      // Remove the temporary anonymous user so self-checks don't pile up accounts.
      if (anonUser) {
        try {
          await withTimeout(() => anonUser.delete());
        } catch (e) {
          fail("Clean-up: delete the temporary anonymous user", e);
        }
      }

      // Email/Password sign-in must be off: otherwise anyone could create an account with a facilitator's address
      // (unverified, so the rules still refuse it, but there is no reason to leave the door there).
      try {
        const addr = `selfcheck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
        const c = await withTimeout(() => au.createUserWithEmailAndPassword(auth2, addr, "Sc-" + Math.random().toString(36).slice(2) + "-9x"));
        results.push({ label: "Email/Password sign-in is disabled (turn it off under Authentication → Sign-in method)", expect: "auth/operation-not-allowed", got: "account created", ok: false });
        try {
          await withTimeout(() => c.user.delete());
        } catch (e) {
          fail("Clean-up: delete the test Email/Password account " + addr, e);
        }
      } catch (e) {
        const ok = e && e.code === "auth/operation-not-allowed";
        results.push({ label: "Email/Password sign-in is disabled", expect: "auth/operation-not-allowed", got: (e && (e.code || e.message)) || String(e), ok });
      }

      try {
        await au.signOut(auth2);
      } catch {}
      try {
        await appMod.deleteApp(app2);
      } catch (e) {
        fail("Clean-up: close the self-check connection", e);
      }
      if (createdId) {
        try {
          await withTimeout(() => fs.deleteDoc(fs.doc(db, "responses", createdId)));
        } catch (e) {
          fail("Clean-up: delete the self-check response (delete it from the Responses tab)", e);
        }
      }
      return results;
    },
  };
}
