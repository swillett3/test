// Pure logic shared by the student feed, the admin console, the backends and the tests.
// No DOM, no network. Everything here is deterministic given its inputs.

export const DEFAULT_ROLES = [
  { code: "CEO", character: "Jaime Armstrong", title: "Chief Executive Officer" },
  { code: "CFO", character: "Robin Wright", title: "Chief Financial Officer" },
  { code: "CCO", character: "Casey Norman", title: "Chief Communications Officer" },
  { code: "CLO", character: "Avery Sikorsky", title: "Chief Legal Officer" },
  { code: "CDO", character: "Pat Lindbergh", title: "Chief Development Officer" },
  { code: "CHRO", character: "Kendall Lee", title: "Chief Human Resources Officer" },
  { code: "SVP", character: "Benni McCann", title: "Senior Vice President, Mona" },
];

export const DEFAULT_CONFIG = {
  title: "StarNight Crisis Simulation",
  company: "StarNight Aerospace",
  simStart: null,             // epoch ms; null = not started
  firstReleaseDelayMin: 15,   // minutes between sim start and the first scheduled release
  teams: [],                  // [{id: "1", name: "Team 1"}]
  roles: DEFAULT_ROLES,
};

export const RESPONSE_KINDS = [
  { code: "social-reply", label: "Public / social media response" },
  { code: "statement", label: "Statement or decision" },
  { code: "reply", label: "Reply to a message" },
  { code: "question", label: "Question for the facilitators" },
];

export const LIMITS = { text: 4000, name: 80, replyTo: 80, team: 20, role: 10, kind: 30 };

// ---------- audience ----------

export function normAudience(a) {
  const roles = !a || a.roles === "ALL" || a.roles == null ? "ALL" : [...new Set(a.roles.map(String))];
  const teams = !a || a.teams === "ALL" || a.teams == null ? "ALL" : [...new Set(a.teams.map(String))];
  return {
    roles: Array.isArray(roles) && roles.length === 0 ? [] : roles,
    teams: Array.isArray(teams) && teams.length === 0 ? [] : teams,
  };
}

/** Does a feed item reach a student sitting at {team, role}? */
export function isForViewer(item, viewer) {
  if (!item || !viewer) return false;
  const a = normAudience(item.audience);
  const teamOk = a.teams === "ALL" || a.teams.includes(String(viewer.team));
  if (!teamOk) return false;
  if (item.channel === "social") return true; // social is public within the targeted teams
  return a.roles === "ALL" || a.roles.includes(String(viewer.role));
}

export function audienceLabel(audience, config) {
  const a = normAudience(audience);
  const teamNames = (config && config.teams) || [];
  const roles = a.roles === "ALL" ? "All roles" : a.roles.length ? a.roles.join(", ") : "No roles";
  let teams;
  if (a.teams === "ALL") teams = "all teams";
  else if (!a.teams.length) teams = "no teams";
  else teams = a.teams.map((t) => (teamNames.find((x) => String(x.id) === t) || { name: "Team " + t }).name).join(", ");
  return `${roles} · ${teams}`;
}

// ---------- schedule ----------

export function scheduledAt(item, config) {
  if (!item || item.offsetMin == null || !Number.isFinite(Number(item.offsetMin))) return null;
  if (!config || config.simStart == null) return null;
  const delay = Number(config.firstReleaseDelayMin) || 0;
  return Number(config.simStart) + Math.round((delay + Number(item.offsetMin)) * 60000);
}

/** Feed entries that came from a given script item id. */
export function releasesOf(scriptId, feed) {
  const out = [];
  for (const [key, f] of Object.entries(feed || {})) if (f && f.sourceId === scriptId) out.push({ key, ...f });
  return out;
}

export function isReleased(scriptId, feed) {
  for (const f of Object.values(feed || {})) if (f && f.sourceId === scriptId) return true;
  return false;
}

/** Items the auto-release loop should publish now. */
export function dueItems(scriptItems, feed, config, now) {
  const out = [];
  for (const it of Object.values(scriptItems || {})) {
    if (!it || it.manualOnly || it.skipped) continue;
    const t = scheduledAt(it, config);
    if (t == null || t > now) continue;
    if (isReleased(it.id, feed)) continue;
    out.push(it);
  }
  return out.sort(compareSchedule(config));
}

export function upcoming(scriptItems, feed, config, now, n = 3) {
  const out = [];
  for (const it of Object.values(scriptItems || {})) {
    if (!it || it.manualOnly || it.skipped) continue;
    const t = scheduledAt(it, config);
    if (t == null || t <= now) continue;
    if (isReleased(it.id, feed)) continue;
    out.push(it);
  }
  return out.sort(compareSchedule(config)).slice(0, n);
}

export function compareSchedule(config) {
  return (a, b) => {
    const oa = a.offsetMin == null ? Infinity : Number(a.offsetMin);
    const ob = b.offsetMin == null ? Infinity : Number(b.offsetMin);
    if (oa !== ob) return oa - ob;
    const ca = a.channel === "inbox" ? 0 : 1, cb = b.channel === "inbox" ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if ((a.seq || 0) !== (b.seq || 0)) return (a.seq || 0) - (b.seq || 0);
    if ((a.createdAt || 0) !== (b.createdAt || 0)) return (a.createdAt || 0) - (b.createdAt || 0);
    return String(a.id).localeCompare(String(b.id));
  };
}

/** New simStart that makes `item` due exactly at `now`, keeping all spacing. */
export function shiftedStartFor(item, config, now) {
  const delay = Number(config.firstReleaseDelayMin) || 0;
  return now - Math.round((delay + Number(item.offsetMin)) * 60000);
}

/** Offset (minutes after first release) that corresponds to wall-clock time t. */
export function offsetForTime(t, config) {
  if (!config || config.simStart == null) return null;
  const delay = Number(config.firstReleaseDelayMin) || 0;
  return Math.round(((t - Number(config.simStart)) / 60000 - delay) * 10) / 10;
}

// ---------- items ----------

const KINDS = ["email", "voicemail", "audio", "video", "news", "press", "phone", "article", "social", "text", "alert"];

function str(v, max) {
  if (v == null) return "";
  const s = String(v);
  return max && s.length > max ? s.slice(0, max) : s;
}

export function cleanMedia(media) {
  if (!Array.isArray(media)) return [];
  return media
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      label: str(m.label || m.name || "Attachment", 200),
      type: ["image", "video", "audio", "link"].includes(m.type) ? m.type : "link",
      url: safeUrl(m.url),
    }));
}

export function safeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Normalise one script item (from an import file or the compose form). */
export function normItem(raw) {
  if (!raw || typeof raw !== "object") throw new Error("item is not an object");
  const id = str(raw.id).trim();
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw new Error(`bad item id "${id}"`);
  const channel = raw.channel === "social" ? "social" : "inbox";
  const offset = raw.offsetMin == null || raw.offsetMin === "" ? null : Number(raw.offsetMin);
  if (offset != null && !Number.isFinite(offset)) throw new Error(`item ${id}: offsetMin is not a number`);
  return {
    id,
    release: str(raw.release, 20),
    seq: Number(raw.seq) || 0,
    offsetMin: offset,
    manualOnly: !!raw.manualOnly,
    skipped: !!raw.skipped,
    channel,
    kind: KINDS.includes(raw.kind) ? raw.kind : channel === "social" ? "social" : "email",
    from: str(raw.from, 300),
    to: str(raw.to, 600),
    subject: str(raw.subject, 300),
    body: str(raw.body, 60000),
    studentBody: raw.studentBody ? str(raw.studentBody, 60000) : null,
    media: cleanMedia(raw.media),
    audience: normAudience(raw.audience),
    packetTime: raw.packetTime ? str(raw.packetTime, 40) : null,
    notes: str(raw.notes, 8000),
    source: ["packet", "prepared", "live"].includes(raw.source) ? raw.source : "live",
    createdAt: Number(raw.createdAt) || 0,
  };
}

export const GENERIC_CALL_TEXT = "Incoming call: a facilitator will join your team shortly.";

// A phone item's body is the actors' script, so it is never shown to students; without a studentBody they get a generic line.
function studentBodyOf(it) {
  if (it.kind === "phone") return it.studentBody && it.studentBody.trim() ? it.studentBody : GENERIC_CALL_TEXT;
  return it.studentBody != null ? it.studentBody : it.body;
}

/** What students receive. Facilitator-only fields never leave the admin side. */
export function studentProjection(item, extra = {}) {
  const it = normItem(item);
  return {
    sourceId: it.id,
    channel: it.channel,
    kind: it.kind,
    from: it.from,
    to: it.to,
    subject: it.subject,
    body: studentBodyOf(it),
    media: it.media.filter((m) => m.url),
    audience: normAudience(extra.audience || it.audience),
    releasedAt: extra.releasedAt || Date.now(),
  };
}

/** Feed key: the item id for a full release, a unique suffix for a targeted re-release. */
export function feedKeyFor(item, audienceOverride, nonce) {
  if (!audienceOverride) return item.id;
  return `${item.id}~${nonce || Date.now().toString(36)}`;
}

// ---------- import ----------

export function parseScriptFile(json) {
  const errors = [];
  let data = json;
  if (typeof json === "string") {
    try {
      data = JSON.parse(json);
    } catch (e) {
      return { errors: ["That file is not valid JSON."], items: {}, roles: null, meta: null };
    }
  }
  if (!data || !Array.isArray(data.items)) return { errors: ["The file has no \"items\" list."], items: {}, roles: null, meta: null };
  const roles = Array.isArray(data.case && data.case.roles) && data.case.roles.length ? data.case.roles : DEFAULT_ROLES;
  const codes = new Set(roles.map((r) => r.code));
  const items = {};
  data.items.forEach((raw, i) => {
    try {
      const it = normItem(raw);
      if (items[it.id]) throw new Error(`duplicate id ${it.id}`);
      if (it.audience.roles !== "ALL") {
        const bad = it.audience.roles.filter((r) => !codes.has(r));
        if (bad.length) throw new Error(`item ${it.id}: unknown role(s) ${bad.join(", ")}`);
      }
      items[it.id] = it;
    } catch (e) {
      errors.push(`Item ${i + 1}: ${e.message}`);
    }
  });
  const meta = {
    title: str(data.case && data.case.title, 120) || "Crisis simulation",
    company: str(data.case && data.case.company, 120),
    summary: str(data.case && data.case.summary, 4000),
    importedAt: Date.now(),
  };
  return { errors, items, roles, meta };
}

// ---------- responses ----------

export function buildResponse({ team, role, kind, text, replyTo, name, uid }) {
  const t = String(text || "").trim();
  if (!t) throw new Error("Write something before sending.");
  if (t.length > LIMITS.text) throw new Error(`Keep it under ${LIMITS.text} characters.`);
  const r = {
    team: str(team, LIMITS.team),
    role: str(role, LIMITS.role),
    kind: RESPONSE_KINDS.some((k) => k.code === kind) ? kind : "statement",
    text: t,
    uid: String(uid || ""),
  };
  if (replyTo) r.replyTo = str(replyTo, LIMITS.replyTo);
  const n = String(name || "").trim();
  if (n) r.name = str(n, LIMITS.name);
  return r;
}

// ---------- formatting ----------

export function fmtClock(ms) {
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function fmtClockSec(ms) {
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function fmtDuration(ms) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const core = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return (neg ? "-" : "") + core;
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    const guarded = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; // stop spreadsheet formula injection
    return /[",\n\r]/.test(guarded) ? '"' + guarded.replace(/"/g, '""') + '"' : guarded;
  };
  const head = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(typeof c.get === "function" ? c.get(r) : r[c.key])).join(","));
  return [head, ...body].join("\r\n");
}

/** Sort feed entries newest first. */
export function feedList(feed) {
  return Object.entries(feed || {})
    .map(([key, f]) => ({ key, ...f }))
    .sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0) || String(b.key).localeCompare(String(a.key)));
}
