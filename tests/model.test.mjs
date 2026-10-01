// Unit tests for the pure logic. Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as M from "../site/js/model.js";

const scriptPath = process.env.SCRIPT_PATH || new URL("./fixtures/sample-script.json", import.meta.url);
const script = JSON.parse(readFileSync(scriptPath, "utf8"));

test("script file imports cleanly", () => {
  const p = M.parseScriptFile(JSON.stringify(script));
  assert.deepEqual(p.errors, []);
  assert.equal(Object.keys(p.items).length, script.items.length);
  assert.equal(p.roles.length, 7);
  assert.ok(p.roles.some((r) => r.code === "SVP"));
});

test("bad files are rejected with a message", () => {
  assert.match(M.parseScriptFile("{nope").errors[0], /not valid JSON/);
  assert.match(M.parseScriptFile("{}").errors[0], /no "items"/);
  const p = M.parseScriptFile({ items: [{ id: "A", audience: { roles: ["XYZ"] } }, { id: "A" }, { id: "B" }, { id: "B" }] });
  assert.deepEqual(Object.keys(p.items).sort(), ["A", "B"]); // first A rejected (bad role), second B rejected (duplicate)
  assert.equal(p.errors.length, 2);
});

test("audience targeting", () => {
  const inboxAll = { channel: "inbox", audience: { roles: "ALL", teams: "ALL" } };
  const cfoT2 = { channel: "inbox", audience: { roles: ["CFO"], teams: ["2"] } };
  const socialT3 = { channel: "social", audience: { roles: ["CEO"], teams: ["3"] } };
  assert.ok(M.isForViewer(inboxAll, { team: "1", role: "CEO" }));
  assert.ok(M.isForViewer(cfoT2, { team: "2", role: "CFO" }));
  assert.ok(!M.isForViewer(cfoT2, { team: "1", role: "CFO" }));
  assert.ok(!M.isForViewer(cfoT2, { team: "2", role: "CEO" }));
  assert.ok(M.isForViewer(socialT3, { team: "3", role: "CLO" }), "social ignores roles");
  assert.ok(!M.isForViewer(socialT3, { team: "1", role: "CEO" }));
  assert.ok(M.isForViewer({ channel: "inbox", audience: { roles: ["SVP"], teams: "ALL" } }, { team: 4, role: "SVP" }), "numeric team ids compare as strings");
  assert.ok(!M.isForViewer({ channel: "inbox", audience: { roles: [], teams: "ALL" } }, { team: "1", role: "CEO" }));
});

test("packet routing decisions", () => {
  const p = M.parseScriptFile(script);
  const r = (id) => p.items[id].audience.roles;
  assert.deepEqual(r("R02"), ["SVP"]);
  assert.deepEqual(r("R04"), ["CDO", "SVP"]);
  assert.deepEqual(r("R17"), ["CLO", "SVP"]);
  assert.equal(r("R01"), "ALL");
  assert.equal(p.items.R13b.manualOnly, true);
  assert.equal(p.items.R24.offsetMin, 180);
  assert.ok(p.items.R13.studentBody && !p.items.R13.studentBody.includes("Note to actors"));
  for (const it of Object.values(p.items)) {
    if (it.source === "prepared") assert.ok(it.manualOnly && it.offsetMin == null, it.id);
    if (it.source === "packet") assert.ok(it.offsetMin != null, it.id);
  }
});

test("student projection never leaks facilitator material", () => {
  const p = M.parseScriptFile(script);
  for (const it of Object.values(p.items)) {
    const s = M.studentProjection(it);
    assert.equal("notes" in s, false);
    assert.equal("offsetMin" in s, false);
    assert.equal("packetTime" in s, false);
    assert.ok(s.media.every((m) => m.url), "no dead attachments");
  }
  const call = M.studentProjection(p.items.R13);
  assert.ok(!call.body.includes("Script"), "call script hidden");
  assert.ok(!call.body.includes("Note to actors"));
  for (const sb of [null, "", "   "]) {
    const bare = M.studentProjection({ ...p.items.R13, studentBody: sb });
    assert.equal(bare.body, M.GENERIC_CALL_TEXT, `phone with studentBody=${JSON.stringify(sb)} never falls back to the script`);
  }
  assert.equal(M.studentProjection({ id: "E1", kind: "email", body: "hello" }).body, "hello");
});

test("schedule math", () => {
  const cfg = { simStart: Date.UTC(2026, 9, 28, 23, 0), firstReleaseDelayMin: 15 };
  const it = { id: "X", offsetMin: 10 };
  assert.equal(M.scheduledAt(it, cfg), cfg.simStart + 25 * 60000);
  assert.equal(M.scheduledAt({ id: "Y", offsetMin: null }, cfg), null);
  assert.equal(M.scheduledAt(it, { simStart: null }), null);
  assert.equal(M.offsetForTime(cfg.simStart + 25 * 60000, cfg), 10);
  const ns = M.shiftedStartFor(it, cfg, cfg.simStart + 60 * 60000);
  assert.equal(M.scheduledAt(it, { ...cfg, simStart: ns }), cfg.simStart + 60 * 60000);
});

test("due / upcoming respect manual, skipped and already-released", () => {
  const cfg = { simStart: 0, firstReleaseDelayMin: 0 };
  const items = {
    A: { id: "A", offsetMin: 0, channel: "inbox" },
    B: { id: "B", offsetMin: 1, channel: "social" },
    C: { id: "C", offsetMin: 1, channel: "inbox", manualOnly: true },
    D: { id: "D", offsetMin: 1, channel: "inbox", skipped: true },
    E: { id: "E", offsetMin: 1, channel: "inbox" },
    F: { id: "F", offsetMin: 5, channel: "inbox" },
  };
  const feed = { A: { sourceId: "A" } };
  const due = M.dueItems(items, feed, cfg, 60000);
  assert.deepEqual(due.map((i) => i.id), ["E", "B"], "inbox before social at the same minute");
  assert.deepEqual(M.upcoming(items, feed, cfg, 60000).map((i) => i.id), ["F"]);
  assert.deepEqual(M.dueItems(items, { "E~x": { sourceId: "E" }, A: { sourceId: "A" } }, cfg, 60000).map((i) => i.id), ["B"], "a targeted release counts as released");
});

test("full packet timeline fits inside a 4-hour session", () => {
  const p = M.parseScriptFile(script);
  const cfg = { simStart: 0, firstReleaseDelayMin: 15 };
  const last = Math.max(...Object.values(p.items).filter((i) => i.offsetMin != null).map((i) => M.scheduledAt(i, cfg)));
  assert.ok(last <= 4 * 3600 * 1000, `last release at ${last / 60000} min`);
});

test("responses are validated", () => {
  assert.throws(() => M.buildResponse({ text: "   " }), /Write something/);
  assert.throws(() => M.buildResponse({ text: "x".repeat(4001) }), /under 4000/);
  const r = M.buildResponse({ team: "2", role: "CCO", kind: "bogus", text: " hi ", replyTo: "", name: "", uid: "u1" });
  assert.deepEqual(r, { team: "2", role: "CCO", kind: "statement", text: "hi", uid: "u1" });
});

test("unsafe links are dropped", () => {
  assert.equal(M.safeUrl("javascript:alert(1)"), null);
  assert.equal(M.safeUrl("data:text/html,x"), null);
  assert.equal(M.safeUrl("https://drive.google.com/file/d/x/view"), "https://drive.google.com/file/d/x/view");
  const it = M.normItem({ id: "Z", media: [{ label: "x", url: "javascript:alert(1)" }] });
  assert.equal(M.studentProjection(it).media.length, 0);
});

test("ids are restricted to safe characters", () => {
  assert.throws(() => M.normItem({ id: "a.b" }));
  assert.throws(() => M.normItem({ id: "../x" }));
  assert.throws(() => M.normItem({ id: "" }));
  M.normItem({ id: "S19-22-13" });
});

test("CSV export escapes and blocks formula injection", () => {
  const csv = M.toCsv([{ a: '=HYPERLINK("x")', b: 'he said "hi",\nthen left' }], [{ label: "A", key: "a" }, { label: "B", key: "b" }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"he said ""hi"",\nthen left"'));
});

test("feed ordering is newest first and stable", () => {
  const l = M.feedList({ a: { releasedAt: 1 }, b: { releasedAt: 3 }, c: { releasedAt: 2 } });
  assert.deepEqual(l.map((x) => x.key), ["b", "c", "a"]);
});
