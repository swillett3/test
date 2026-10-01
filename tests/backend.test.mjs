// Integration test of site/js/backend-firebase.js against the Firebase emulators (Firestore + Auth), with the real rules.
// Uses the npm build of the same SDK version the site loads from the CDN (firebase@10.12.2).
// Run: npm run test:emulator
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import * as appMod from "firebase/app";
import * as fs from "firebase/firestore";
import * as au from "firebase/auth";
import { createBackend } from "../site/js/backend-firebase.js";
import { studentProjection } from "../site/js/model.js";

const PROJECT = "demo-crisis-sim";
const HOST = "127.0.0.1";
const emulator = { host: HOST, firestorePort: 8080, authPort: 9099 };
const config = { apiKey: "demo-key", authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: "demo" };
const sdk = [appMod, fs, au];
let env;
let n = 0;

const make = (label) => createBackend({ sdk, config, emulator, appName: `${label}-${++n}` });
async function adminBackend(email = "sam_willett@berkeley.edu") {
  const b = await make("admin");
  const auth = au.getAuth(appMod.getApp(`admin-${n}`));
  // The Auth emulator accepts an unsigned Google ID token; the user gets sign_in_provider "google.com" like a real Google sign-in.
  await au.signInWithCredential(auth, au.GoogleAuthProvider.credential(JSON.stringify({ sub: "g-" + email, email, email_verified: true })));
  return b;
}
async function studentBackend() {
  const b = await make("student");
  await b.signInStudent();
  return b;
}
/** Wait for the first callback value matching pred. */
function next(watch, pred = () => true, ms = 8000) {
  return new Promise((res, rej) => {
    let unsub = () => {};
    const t = setTimeout(() => (unsub(), rej(new Error("timed out waiting for snapshot"))), ms);
    unsub = watch(
      (v, meta) => {
        if (pred(v, meta)) {
          clearTimeout(t);
          setTimeout(() => unsub(), 0);
          res({ v, meta });
        }
      },
      (e) => (clearTimeout(t), rej(e)),
    );
  });
}
const authEmu = (path, init = {}) =>
  fetch(`http://${HOST}:9099${path}`, { ...init, headers: { Authorization: "Bearer owner", "Content-Type": "application/json", ...(init.headers || {}) } });
async function authUsers() {
  const r = await authEmu(`/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { method: "POST", body: "{}" });
  const j = await r.json();
  return j.userInfo || [];
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { host: HOST, port: 8080, rules: readFileSync(new URL("../site/firestore.rules", import.meta.url), "utf8") },
  });
});
after(async () => {
  await env.cleanup();
  await Promise.all(appMod.getApps().map((a) => appMod.deleteApp(a)));
});
beforeEach(async () => {
  await env.clearFirestore();
  await authEmu(`/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
});

const item = (id, extra = {}) => ({ id, channel: "inbox", kind: "email", from: "A", subject: "S " + id, body: "B " + id, audience: { roles: "ALL", teams: "ALL" }, ...extra });

test("admin: script import, merge-save of one item, delete one item (FieldPath + deleteField)", async () => {
  const b = await adminBackend();
  await b.importScript({ R01: item("R01"), R02: item("R02"), "S19-22-13": item("S19-22-13") }, { title: "T" });
  let { v } = await next(b.watchScript, (s) => Object.keys(s.items).length === 3);
  assert.equal(v.meta.title, "T");
  await b.saveScriptItem({ ...item("R02"), subject: "edited" });
  ({ v } = await next(b.watchScript, (s) => s.items.R02 && s.items.R02.subject === "edited"));
  assert.ok(v.items.R01 && v.items["S19-22-13"], "merge kept the other items");
  await b.deleteScriptItem("S19-22-13");
  ({ v } = await next(b.watchScript, (s) => !s.items["S19-22-13"]));
  assert.deepEqual(Object.keys(v.items).sort(), ["R01", "R02"]);
});

test("admin: config and control are merged, not replaced", async () => {
  const b = await adminBackend();
  await b.saveConfig({ title: "X", teams: [{ id: "1", name: "Team 1" }] });
  await b.saveConfig({ simStart: 123 });
  const { v } = await next(b.watchConfig, (c) => c.simStart === 123);
  assert.equal(v.title, "X");
  assert.equal(v.teams.length, 1);
  await b.saveControl({ autoRelease: true });
  assert.equal((await next(b.watchControl, (c) => c.autoRelease === true)).v.autoRelease, true);
});

test("release is atomic, skips existing keys and honours onlyIfNew", async () => {
  const b = await adminBackend();
  const e = (id, key = id, onlyIfNew = true) => ({ key, onlyIfNew, entry: studentProjection(item(id), { releasedAt: 1 }) });
  assert.deepEqual(await b.release([e("R01"), e("R02")]), ["R01", "R02"]);
  assert.deepEqual(await b.release([e("R01"), e("R03")]), ["R03"], "R01 already there");
  assert.deepEqual(await b.release([e("R02", "R02~t1")]), [], "onlyIfNew blocks a second copy");
  assert.deepEqual(await b.release([e("R02", "R02~t2", false)]), ["R02~t2"], "targeted re-release allowed");
  const { v } = await next(b.watchFeed, (f) => Object.keys(f).length === 4);
  assert.equal(v["R02~t2"].sourceId, "R02");
});

test("two facilitator consoles releasing the same items at once produce one copy each", async () => {
  const a = await adminBackend("sam_willett@berkeley.edu");
  const c = await adminBackend("amy.chan@berkeley.edu");
  const batch = ["R01", "R02", "R03"].map((id) => ({ key: id, onlyIfNew: true, entry: studentProjection(item(id)) }));
  const [ka, kc] = await Promise.all([a.release(batch), c.release(batch)]);
  assert.deepEqual([...ka, ...kc].sort(), ["R01", "R02", "R03"], "each key released by exactly one console");
  const { v } = await next(a.watchFeed, (f) => Object.keys(f).length >= 3);
  assert.equal(Object.keys(v).length, 3);
});

test("edit and retract a feed entry whose key contains '~'", async () => {
  const b = await adminBackend();
  await b.release([{ key: "R05~abc", entry: studentProjection(item("R05")) }, { key: "R06", entry: studentProjection(item("R06")) }]);
  await b.updateFeedEntry("R05~abc", { ...studentProjection(item("R05")), subject: "fixed" });
  let { v } = await next(b.watchFeed, (f) => f["R05~abc"] && f["R05~abc"].subject === "fixed");
  await b.retract("R05~abc");
  ({ v } = await next(b.watchFeed, (f) => !f["R05~abc"]));
  assert.deepEqual(Object.keys(v), ["R06"]);
  await b.clearFeed();
  await next(b.watchFeed, (f) => Object.keys(f).length === 0);
});

test("student: anonymous sign-in, sees public docs, is refused private ones, can send a response", async () => {
  const admin = await adminBackend();
  await admin.saveConfig({ title: "Live" });
  await admin.release([{ key: "R01", entry: studentProjection(item("R01")) }]);
  const s = await studentBackend();
  assert.equal(s.currentUser().isAnonymous, true);
  assert.equal((await next(s.watchConfig)).v.title, "Live");
  const { v, meta } = await next(s.watchFeed, (f) => !!f.R01);
  assert.equal(typeof meta.fromCache, "boolean");
  assert.equal(v.R01.body, "B R01");
  await assert.rejects(next(s.watchScript), /permission/i);
  await assert.rejects(next(s.watchControl), /permission/i);
  await assert.rejects(next(s.watchResponses), /permission/i);
  await assert.rejects(s.release([{ key: "X", entry: {} }]), /permission/i);

  await s.submitResponse({ team: "1", role: "CEO", kind: "statement", text: "Our statement", uid: s.currentUser().uid });
  const { v: list } = await next(admin.watchResponses, (l) => l.length === 1 && l[0].createdAt > 0);
  assert.equal(list[0].text, "Our statement");
  assert.equal(typeof list[0].createdAt, "number");
  await admin.markResponse(list[0].id, { handled: true });
  await next(admin.watchResponses, (l) => l[0] && l[0].handled === true);
  await assert.rejects(s.markResponse(list[0].id, { handled: false }), /permission/i);
  assert.equal(await admin.deleteAllResponses(), 1);
});

test("deleteAllResponses pages through more than one batch", async () => {
  const admin = await adminBackend();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const b = fs.writeBatch(db);
    for (let i = 0; i < 450; i++) b.set(fs.doc(db, "responses", "r" + i), { team: "1", role: "CEO", kind: "statement", text: "x", uid: "u", createdAt: fs.Timestamp.now() });
    await b.commit();
  });
  assert.equal(await admin.deleteAllResponses(), 450);
});

test("selfCheck: probes the rules from a second app instance and cleans up after itself", async () => {
  const admin = await adminBackend();
  await admin.saveConfig({ title: "x" });
  await admin.release([]);
  const before = (await authUsers()).length;
  const res = await admin.selfCheck();
  const bad = res.filter((r) => !r.ok);
  // The Auth emulator always allows Email/Password sign-up, so that one row must fail here (on the real project it must pass).
  assert.deepEqual(bad.map((r) => r.label), ["Email/Password sign-in is disabled (turn it off under Authentication → Sign-in method)"], JSON.stringify(bad, null, 1));
  for (const label of [
    "Student cannot change the unreleased script",
    "Student cannot mark their own response handled",
    "Student cannot read back a single response",
  ])
    assert.ok(res.some((r) => r.label === label && r.ok), label);
  assert.ok(!res.some((r) => /^Clean-up/.test(r.label)), "no clean-up failures");
  assert.equal((await authUsers()).length, before, "temporary anonymous and email users were deleted");
  const { v } = await next(admin.watchResponses);
  assert.equal(v.length, 0, "self-check response deleted");
  assert.ok(!appMod.getApps().some((a) => a.name.startsWith("selfcheck-")), "second app instance closed");
});
