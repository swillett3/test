// Unit test for resilientWatch (the reconnect logic shared by the console and the student page).
import test from "node:test";
import assert from "node:assert/strict";
import { resilientWatch } from "../site/js/store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("re-subscribes after a non-permission error, with backoff, and reports the outage", async () => {
  const calls = [];
  let n = 0;
  const start = (onData, onErr) => {
    const i = ++n;
    calls.push(i);
    setTimeout(() => (i < 3 ? onErr(Object.assign(new Error("unavailable"), { code: "unavailable" })) : onData("ok", i)), 1);
    return () => calls.push("unsub" + i);
  };
  const lost = [];
  const data = [];
  const stop = resilientWatch(start, (v, i) => data.push([v, i]), { onLost: (e) => lost.push(e.code), minDelay: 10, maxDelay: 40 });
  await sleep(120);
  assert.deepEqual(lost, ["unavailable", "unavailable"]);
  assert.deepEqual(data, [["ok", 3]]);
  assert.ok(calls.includes("unsub1") && calls.includes("unsub2"), "dead listeners are released");
  stop();
  assert.ok(calls.includes("unsub3"));
});

test("permission errors are not retried", async () => {
  let n = 0;
  const denied = [];
  resilientWatch(
    (onData, onErr) => {
      n++;
      setTimeout(() => onErr(Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" })), 1);
      return () => {};
    },
    () => {},
    { onDenied: (e) => denied.push(e.code), minDelay: 5 },
  );
  await sleep(60);
  assert.equal(n, 1);
  assert.deepEqual(denied, ["permission-denied"]);
});

test("stop() cancels a pending retry", async () => {
  let n = 0;
  const stop = resilientWatch(
    (onData, onErr) => {
      n++;
      setTimeout(() => onErr(new Error("boom")), 1);
      return () => {};
    },
    () => {},
    { minDelay: 30 },
  );
  await sleep(10);
  stop();
  await sleep(80);
  assert.equal(n, 1);
});
