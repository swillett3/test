// Picks the data backend. `?backend=mock` runs everything in this browser only (for testing/rehearsal on one machine).
import { isConfigured } from "./config.js";

export async function loadBackend() {
  const params = new URLSearchParams(location.search);
  if (params.get("backend") === "mock") {
    const m = await import("./backend-mock.js");
    return m.createBackend();
  }
  if (!isConfigured()) return null;
  const m = await import("./backend-firebase.js");
  return m.createBackend();
}

/** Keep ?backend=mock on links between pages when testing. */
export function carryParams(href) {
  const p = new URLSearchParams(location.search);
  if (p.get("backend") !== "mock") return href;
  const u = new URL(href, location.href);
  u.searchParams.set("backend", "mock");
  return u.pathname.split("/").pop() + u.search + u.hash;
}

const isDenied = (e) => !!e && (e.code === "permission-denied" || /permission/i.test(e.message || ""));

/**
 * Keep a live subscription alive. A Firestore listener stops for good after an error, so on any error other than
 * permission-denied this re-subscribes with backoff (2 s, 4 s … 30 s). `onLost(err)` fires on each failure,
 * `onData` as usual (its first call after a failure means the connection is back). Permission errors go to `onDenied`
 * and are not retried. Returns an unsubscribe function.
 */
export function resilientWatch(start, onData, { onLost, onDenied, minDelay = 2000, maxDelay = 30000 } = {}) {
  let unsub = null;
  let timer = null;
  let stopped = false;
  let delay = minDelay;
  const sub = () => {
    if (stopped) return;
    unsub = start(
      (...args) => {
        delay = minDelay;
        onData(...args);
      },
      (e) => {
        if (stopped) return;
        if (isDenied(e)) return onDenied ? onDenied(e) : onLost && onLost(e);
        try {
          if (unsub) unsub();
        } catch {}
        if (onLost) onLost(e);
        clearTimeout(timer);
        timer = setTimeout(sub, delay);
        delay = Math.min(delay * 2, maxDelay);
      },
    );
  };
  sub();
  return () => {
    stopped = true;
    clearTimeout(timer);
    try {
      if (unsub) unsub();
    } catch {}
  };
}
