// Security-rules tests: every allow and deny in site/firestore.rules, run against the Firestore emulator.
// Run: npm run test:rules   (starts the emulator, runs this file, stops the emulator)
import test, { before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, limit, serverTimestamp, Timestamp } from "firebase/firestore";

const PROJECT = "demo-crisis-sim";
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync(new URL("../site/firestore.rules", import.meta.url), "utf8") },
  });
});
after(() => env && env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "public", "config"), { title: "x", simStart: null });
    await setDoc(doc(db, "public", "feed"), { items: {} });
    await setDoc(doc(db, "public", "other"), { secret: true });
    await setDoc(doc(db, "private", "script"), { items: {} });
    await setDoc(doc(db, "private", "control"), { autoRelease: false });
    await setDoc(doc(db, "responses", "r1"), { team: "1", role: "CEO", kind: "question", text: "hi", uid: "stu", createdAt: Timestamp.now() });
    await setDoc(doc(db, "elsewhere", "x"), { a: 1 });
  });
});

// ---------- identities ----------
const google = (email, extra = {}) => ({ email, email_verified: true, firebase: { sign_in_provider: "google.com", identities: {} }, ...extra });
const who = {
  nobody: () => env.unauthenticatedContext().firestore(),
  student: () => env.authenticatedContext("stu", { firebase: { sign_in_provider: "anonymous", identities: {} } }).firestore(),
  sam: () => env.authenticatedContext("sam", google("sam_willett@berkeley.edu")).firestore(),
  amy: () => env.authenticatedContext("amy", google("amy.chan@berkeley.edu")).firestore(),
  samUpper: () => env.authenticatedContext("sam2", google("Sam_Willett@Berkeley.EDU")).firestore(),
  // Each of these is one condition short of a facilitator.
  otherGoogle: () => env.authenticatedContext("eve", google("eve@berkeley.edu")).firestore(),
  unverified: () => env.authenticatedContext("u1", google("sam_willett@berkeley.edu", { email_verified: false })).firestore(),
  noVerifiedClaim: () => {
    const t = google("sam_willett@berkeley.edu");
    delete t.email_verified;
    return env.authenticatedContext("u2", t).firestore();
  },
  passwordProvider: () =>
    env.authenticatedContext("u3", { email: "sam_willett@berkeley.edu", email_verified: true, firebase: { sign_in_provider: "password", identities: {} } }).firestore(),
  otherProvider: () =>
    env.authenticatedContext("u4", { email: "amy.chan@berkeley.edu", email_verified: true, firebase: { sign_in_provider: "github.com", identities: {} } }).firestore(),
  customToken: () => env.authenticatedContext("u5", { email: "sam_willett@berkeley.edu", email_verified: true }).firestore(), // provider "custom"
  anonWithEmail: () =>
    env.authenticatedContext("u6", { email: "sam_willett@berkeley.edu", email_verified: true, firebase: { sign_in_provider: "anonymous", identities: {} } }).firestore(),
  googleNoEmail: () => env.authenticatedContext("u7", { firebase: { sign_in_provider: "google.com", identities: {} } }).firestore(),
};
const ADMINS = ["sam", "amy", "samUpper"];
const NON_ADMINS = ["nobody", "student", "otherGoogle", "unverified", "noVerifiedClaim", "passwordProvider", "otherProvider", "customToken", "anonWithEmail", "googleNoEmail"];

// ---------- public/{config,feed} ----------
for (const w of [...ADMINS, ...NON_ADMINS]) {
  test(`public/config and public/feed readable by ${w}`, async () => {
    await assertSucceeds(getDoc(doc(who[w](), "public", "config")));
    await assertSucceeds(getDoc(doc(who[w](), "public", "feed")));
  });
  test(`other public/* docs not readable by ${w}`, async () => {
    await assertFails(getDoc(doc(who[w](), "public", "other")));
    await assertFails(getDocs(collection(who[w](), "public")));
  });
}
for (const w of ADMINS) {
  test(`public writes allowed for ${w}`, async () => {
    const db = who[w]();
    await assertSucceeds(setDoc(doc(db, "public", "config"), { simStart: 1 }, { merge: true }));
    await assertSucceeds(setDoc(doc(db, "public", "feed"), { items: { a: "{}" } }, { merge: true }));
    await assertSucceeds(deleteDoc(doc(db, "public", "other")));
  });
}
for (const w of NON_ADMINS) {
  test(`public writes denied for ${w}`, async () => {
    const db = who[w]();
    await assertFails(setDoc(doc(db, "public", "config"), { simStart: 1 }, { merge: true }));
    await assertFails(setDoc(doc(db, "public", "feed"), { items: { a: "{}" } }, { merge: true }));
    await assertFails(deleteDoc(doc(db, "public", "feed")));
    await assertFails(setDoc(doc(db, "public", "new"), { a: 1 }));
  });
}

// ---------- private/* ----------
for (const w of ADMINS) {
  test(`private read/write allowed for ${w}`, async () => {
    const db = who[w]();
    await assertSucceeds(getDoc(doc(db, "private", "script")));
    await assertSucceeds(getDoc(doc(db, "private", "control")));
    await assertSucceeds(setDoc(doc(db, "private", "script"), { items: { x: "{}" } }, { merge: true }));
    await assertSucceeds(setDoc(doc(db, "private", "control"), { autoRelease: true }, { merge: true }));
  });
}
for (const w of NON_ADMINS) {
  test(`private read/write denied for ${w}`, async () => {
    const db = who[w]();
    await assertFails(getDoc(doc(db, "private", "script")));
    await assertFails(getDoc(doc(db, "private", "control")));
    await assertFails(getDocs(collection(db, "private")));
    await assertFails(setDoc(doc(db, "private", "script"), { items: { x: "{}" } }, { merge: true }));
    await assertFails(setDoc(doc(db, "private", "control"), { autoRelease: true }, { merge: true }));
  });
}

// ---------- responses: read / update / delete ----------
for (const w of ADMINS) {
  test(`responses read/update/delete allowed for ${w}`, async () => {
    const db = who[w]();
    await assertSucceeds(getDoc(doc(db, "responses", "r1")));
    await assertSucceeds(getDocs(query(collection(db, "responses"), limit(5))));
    await assertSucceeds(updateDoc(doc(db, "responses", "r1"), { handled: true }));
    await assertSucceeds(deleteDoc(doc(db, "responses", "r1")));
  });
}
for (const w of NON_ADMINS) {
  test(`responses read/update/delete denied for ${w}`, async () => {
    const db = who[w]();
    await assertFails(getDoc(doc(db, "responses", "r1")));
    await assertFails(getDocs(query(collection(db, "responses"), limit(5))));
    await assertFails(updateDoc(doc(db, "responses", "r1"), { handled: true }));
    await assertFails(deleteDoc(doc(db, "responses", "r1")));
  });
}
test("a student cannot read, update or delete even their own response", async () => {
  const db = who.student();
  await assertFails(getDoc(doc(db, "responses", "r1"))); // r1.uid == "stu"
  await assertFails(updateDoc(doc(db, "responses", "r1"), { handled: true }));
  await assertFails(updateDoc(doc(db, "responses", "r1"), { text: "edited" }));
  await assertFails(deleteDoc(doc(db, "responses", "r1")));
});

// ---------- responses: create ----------
const valid = (over = {}) => ({ team: "1", role: "CEO", kind: "statement", text: "We will respond.", uid: "stu", createdAt: serverTimestamp(), ...over });
const send = (data, db = who.student()) => addDoc(collection(db, "responses"), data);
const without = (k) => {
  const v = valid();
  delete v[k];
  return v;
};

test("create: valid response accepted (required fields only, and with optional fields)", async () => {
  await assertSucceeds(send(valid()));
  await assertSucceeds(send(valid({ replyTo: "R01", name: "Pat" })));
});
test("create: a signed-in facilitator can also create with their own uid", async () => {
  await assertSucceeds(send(valid({ uid: "sam" }), who.sam()));
});
test("create: not signed in is denied", async () => {
  await assertFails(send(valid({ uid: "x" }), who.nobody()));
});
test("create: uid must be the caller's", async () => {
  await assertFails(send(valid({ uid: "someone-else" })));
});
test("create: createdAt must be the server time", async () => {
  await assertFails(send(valid({ createdAt: Timestamp.fromMillis(Date.now() - 60000) })));
  await assertFails(send(valid({ createdAt: Date.now() })));
});
test("create: extra fields are denied (e.g. handled)", async () => {
  await assertFails(send(valid({ handled: true })));
  await assertFails(send(valid({ admin: true })));
});
for (const k of ["team", "role", "kind", "text", "uid", "createdAt"]) {
  test(`create: missing required field ${k} is denied`, async () => {
    await assertFails(send(without(k)));
  });
}
for (const [k, max] of [["team", 20], ["role", 10], ["kind", 30], ["text", 4000], ["replyTo", 80], ["name", 80]]) {
  test(`create: ${k} length limit ${max}`, async () => {
    await assertSucceeds(send(valid({ [k]: "x".repeat(max) })));
    await assertFails(send(valid({ [k]: "x".repeat(max + 1) })));
  });
  test(`create: ${k} must be a string`, async () => {
    await assertFails(send(valid({ [k]: 5 })));
    await assertFails(send(valid({ [k]: ["x"] })));
  });
}
test("create: empty text is denied", async () => {
  await assertFails(send(valid({ text: "" })));
});
test("create: a fixed id is fine but cannot overwrite an existing response", async () => {
  await assertSucceeds(setDoc(doc(who.student(), "responses", "mine"), valid()));
  await assertFails(setDoc(doc(who.student(), "responses", "r1"), valid())); // exists → this is an update
});

// ---------- everything else ----------
for (const w of ["nobody", "student", "sam"]) {
  test(`other collections are closed, even to ${w}`, async () => {
    const db = who[w]();
    await assertFails(getDoc(doc(db, "elsewhere", "x")));
    await assertFails(setDoc(doc(db, "elsewhere", "y"), { a: 1 }));
    await assertFails(getDoc(doc(db, "public", "config", "sub", "x")));
    await assertFails(setDoc(doc(db, "responses", "r1", "sub", "x"), { a: 1 }));
  });
}
