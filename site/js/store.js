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
