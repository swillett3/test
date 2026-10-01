import { loadBackend, carryParams } from "./store.js";
import { ADMIN_EMAILS } from "./config.js";
import { h, add, clear, toast, dialog, confirmDialog, download, chime, paragraphs } from "./ui.js";
import {
  DEFAULT_CONFIG, DEFAULT_ROLES, RESPONSE_KINDS, normItem, normAudience, studentProjection, feedKeyFor, scheduledAt,
  releasesOf, isReleased, dueItems, upcoming, compareSchedule, shiftedStartFor, offsetForTime, parseScriptFile,
  audienceLabel, isForViewer, feedList, fmtClock, fmtClockSec, fmtDuration, toCsv,
} from "./model.js";
import { inboxRow, messageView, socialPost, kindLabel } from "./feedview.js";

const OVERDUE_GRACE_MS = 2 * 60 * 1000; // items more than this late count as "overdue" (not normal flow)
const OVERDUE_PROMPT_COUNT = 3;          // ask before releasing a backlog bigger than this

const S = {
  backend: null,
  user: null,
  denied: false,
  config: null,
  feed: {},
  script: null, // {items, meta}
  control: {},
  responses: [],
  responsesLoaded: false,
  tab: "timeline",
  filter: { channel: "all", q: "", hideReleased: false },
  expanded: new Set(),
  respFilter: { team: "", role: "", open: true },
  preview: { team: "", role: "CEO", selected: null },
  releasing: false,
  overduePrompt: false,
  lastResponseIds: null,
  unsubs: [],
  built: false,
};

const $ = (id) => document.getElementById(id);
const cfg = () => ({ ...DEFAULT_CONFIG, ...(S.config || {}) });
const roles = () => (cfg().roles && cfg().roles.length ? cfg().roles : DEFAULT_ROLES);
const teams = () => cfg().teams || [];
const items = () => (S.script && S.script.items) || {};
const roleName = (code) => {
  const r = roles().find((x) => x.code === code);
  return r ? `${r.character} (${r.code})` : code;
};
const teamName = (id) => (teams().find((t) => String(t.id) === String(id)) || { name: "Team " + id }).name;

// ---------- boot & auth ----------

async function boot() {
  try {
    S.backend = await loadBackend();
  } catch (e) {
    console.error(e);
    return bootMessage("Couldn't load. Check your internet connection and reload.");
  }
  if (!S.backend) return bootMessage("Not connected to a database yet: fill in js/config.js (see SETUP.md).");
  if (S.backend.kind === "mock") document.body.classList.add("is-mock");
  S.backend.onAuth((u) => {
    const was = S.user && S.user.uid;
    S.user = u;
    if (!u || u.isAnonymous) {
      stopWatching();
      return renderSignIn();
    }
    if (was !== u.uid) startWatching();
  });
  setInterval(tick, 1000);
}

function bootMessage(msg) {
  S.built = false;
  clear($("app")).appendChild(h("div", { class: "boot" }, h("div", { class: "boot__logo" }, "★"), h("p", { class: "boot__msg" }, msg)));
}

function renderSignIn(note) {
  S.built = false;
  clear($("app")).appendChild(
    h(
      "main",
      { class: "signin" },
      h("div", { class: "boot__logo" }, "★"),
      h("h1", null, "Facilitator console"),
      h("p", null, "Sign in with the Google account on the facilitator list."),
      note ? h("p", { class: "signin__note" }, note) : null,
      h(
        "button",
        {
          type: "button",
          class: "btn btn--primary btn--lg",
          id: "signin-btn",
          onclick: async () => {
            try {
              await S.backend.signInAdmin();
            } catch (e) {
              console.error(e);
              renderSignIn(e && e.code === "auth/popup-blocked" ? "Your browser blocked the sign-in window. Allow pop-ups for this site and try again." : "Sign-in didn't complete. Try again.");
            }
          },
        },
        "Sign in with Google",
      ),
      h("p", { class: "signin__small" }, h("a", { href: carryParams("index.html") }, "Go to the student page")),
    ),
  );
}

function stopWatching() {
  S.unsubs.forEach((u) => {
    try {
      u();
    } catch {}
  });
  S.unsubs = [];
}

function startWatching() {
  stopWatching();
  S.denied = false;
  S.script = null;
  S.responsesLoaded = false;
  S.lastResponseIds = null;
  const denied = (e) => {
    console.error(e);
    if (e && (e.code === "permission-denied" || /permission/i.test(e.message || ""))) {
      S.denied = true;
      renderDenied();
    }
  };
  S.unsubs.push(
    S.backend.watchConfig((c) => { S.config = c || {}; renderAll(); }, denied),
    S.backend.watchFeed((f) => { S.feed = f || {}; renderAll(); }, denied),
    S.backend.watchScript((s) => { S.script = s; renderAll(); }, denied),
    S.backend.watchControl((c) => { S.control = c || {}; renderAll(); }, denied),
    S.backend.watchResponses((r) => onResponses(r), denied),
  );
}

function renderDenied() {
  S.built = false;
  stopWatching();
  clear($("app")).appendChild(
    h(
      "main",
      { class: "signin" },
      h("h1", null, "Not on the facilitator list"),
      h("p", null, `${(S.user && S.user.email) || "This account"} can't open the console. Facilitators: ${ADMIN_EMAILS.join(", ")}.`),
      h("button", { type: "button", class: "btn", onclick: () => S.backend.signOut() }, "Sign in with a different account"),
    ),
  );
}

function onResponses(list) {
  const ids = new Set(list.map((r) => r.id));
  if (S.lastResponseIds) {
    const fresh = list.filter((r) => !S.lastResponseIds.has(r.id));
    if (fresh.length) {
      fresh.slice(0, 3).forEach((r) =>
        toast(h("span", null, h("strong", null, `${teamName(r.team)} · ${r.role}`), " — ", String(r.text).slice(0, 80)), { onClick: () => setTab("responses"), ms: 7000 }),
      );
      chime();
    }
  }
  S.lastResponseIds = ids;
  S.responses = list;
  S.responsesLoaded = true;
  renderAll();
}

// ---------- scheduler ----------

function tick() {
  updateClocks();
  runScheduler();
}

async function runScheduler() {
  if (!S.built || S.denied || S.releasing || S.overduePrompt) return;
  const c = cfg();
  if (!S.control.autoRelease || c.simStart == null || !S.script) return;
  const now = Date.now();
  const due = dueItems(items(), S.feed, c, now);
  if (!due.length) return;
  const overdue = due.filter((it) => scheduledAt(it, c) < now - OVERDUE_GRACE_MS);
  if (overdue.length > OVERDUE_PROMPT_COUNT) return promptOverdue(due, overdue);
  await releaseItems(due, { auto: true });
}

async function promptOverdue(due, overdue) {
  S.overduePrompt = true;
  try {
    const c = cfg();
    const first = overdue[0];
    const late = fmtDuration(Date.now() - scheduledAt(first, c));
    const choice = await dialog({
      title: `${overdue.length} messages are overdue`,
      body: h(
        "div",
        null,
        h("p", null, `Auto-release is on, but ${overdue.length} scheduled messages are past their time (the oldest by ${late}). This usually means the start time was changed, auto-release was paused, or this tab was closed.`),
        h("ul", { class: "mini-list" }, overdue.slice(0, 6).map((it) => h("li", null, `${fmtClock(scheduledAt(it, c))} · ${itemTitle(it)}`)), overdue.length > 6 ? h("li", null, `…and ${overdue.length - 6} more`) : null),
      ),
      buttons: [
        { label: "Turn auto-release off", value: "off" },
        { label: "Skip them", value: "skip" },
        { label: "Release them all now", value: "release" },
        { label: "Shift the schedule", value: "shift", primary: true },
      ],
    });
    if (choice === "release") await releaseItems(due, { auto: true });
    else if (choice === "shift") {
      const newStart = shiftedStartFor(first, c, Date.now());
      await S.backend.saveConfig({ simStart: newStart });
      toast(`Schedule shifted by ${fmtDuration(Number(c.simStart) - newStart).replace("-", "")}. The next message goes out now.`);
    } else if (choice === "skip") {
      for (const it of overdue) await S.backend.saveScriptItem({ ...it, skipped: true });
      toast(`Skipped ${overdue.length} messages. You can still release any of them by hand.`);
    } else if (choice === "off" || choice == null) {
      await S.backend.saveControl({ autoRelease: false });
    }
  } catch (e) {
    console.error(e);
    toast("Something went wrong: " + (e.message || e), { tone: "error" });
  } finally {
    S.overduePrompt = false;
  }
}

/** Release script items to students. opts.audience overrides the targeting (creates a separate copy). */
async function releaseItems(list, opts = {}) {
  if (!list.length) return [];
  S.releasing = true;
  try {
    const now = Date.now();
    const sorted = [...list].sort(compareSchedule(cfg()));
    const entries = sorted.map((it, i) => {
      const key = feedKeyFor(it, opts.audience, opts.nonce);
      return { key, entry: studentProjection(it, { releasedAt: now + i, audience: opts.audience }), onlyIfNew: !!opts.auto };
    });
    const keys = await S.backend.release(entries);
    if (!opts.auto && keys.length) toast(keys.length === 1 ? `Released: ${itemTitle(sorted[0])}` : `Released ${keys.length} messages`);
    if (!opts.auto && !keys.length) toast("Already released — nothing new went out.");
    return keys;
  } catch (e) {
    console.error(e);
    toast("Release failed: " + (e.message || e) + ". Try again.", { tone: "error", ms: 9000 });
    return [];
  } finally {
    S.releasing = false;
  }
}

// ---------- layout ----------

function setTab(tab) {
  S.tab = tab;
  renderAll();
  window.scrollTo(0, 0);
}

function build() {
  const app = clear($("app"));
  app.appendChild(
    h(
      "div",
      { class: "console" },
      h(
        "header",
        { class: "cbar" },
        h("div", { class: "cbar__title" }, h("span", { class: "logo" }, "★"), h("span", { id: "c-title" }), h("span", { class: "tag" }, "Facilitator")),
        h("div", { class: "cbar__status", id: "c-status" }),
        h("div", { class: "cbar__auto", id: "c-auto" }),
        h("div", { class: "cbar__user" }, h("span", { id: "c-user" }), h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => S.backend.signOut() }, "Sign out")),
      ),
      h("div", { class: "nextup", id: "c-next" }),
      h(
        "nav",
        { class: "ctabs", role: "tablist" },
        ["timeline", "compose", "responses", "preview", "setup"].map((t) =>
          h("button", { type: "button", role: "tab", class: "ctab", "data-tab": t, onclick: () => setTab(t) }, { timeline: "Timeline", compose: "Compose / interject", responses: "Responses", preview: "View as student", setup: "Setup" }[t], h("span", { class: "tab__badge", id: "cbadge-" + t })),
        ),
      ),
      h("main", { class: "cmain", id: "c-main" }),
    ),
  );
  S.built = true;
}

function renderAll() {
  if (S.denied || !S.user || S.user.isAnonymous) return;
  if (!S.built) build();
  renderBar();
  renderNext();
  document.querySelectorAll(".ctab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  const open = S.responses.filter((r) => !r.handled).length;
  $("cbadge-responses").textContent = open ? String(open) : "";
  const main = $("c-main");
  if (main.dataset.tab !== S.tab) {
    clear(main);
    main.dataset.tab = S.tab;
    main.dataset.built = "";
  }
  if (!S.script || S.config === null) {
    clear(main).appendChild(h("p", { class: "empty" }, "Loading…"));
    main.dataset.built = "";
    return;
  }
  ({ timeline: renderTimeline, compose: renderCompose, responses: renderResponses, preview: renderPreview, setup: renderSetup })[S.tab]();
}

function renderBar() {
  const c = cfg();
  $("c-title").textContent = c.title || "Crisis simulation";
  $("c-user").textContent = S.user ? S.user.email || "" : "";
  const st = clear($("c-status"));
  if (c.simStart == null) {
    add(st, h("span", { class: "pill pill--idle" }, "Not started"), h("button", { type: "button", class: "btn btn--primary btn--sm", id: "start-now", onclick: startNow }, "Start now"), h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: editStart }, "Set start time…"));
  } else {
    const first = Number(c.simStart) + (Number(c.firstReleaseDelayMin) || 0) * 60000;
    add(st, 
      h("span", { class: "pill pill--live" }, "Running"),
      h("span", { class: "cbar__meta" }, `Started ${fmtClock(Number(c.simStart))} · first release ${fmtClock(first)} · elapsed `, h("strong", { id: "elapsed" })),
      h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: editStart }, "Change…"),
    );
  }
  const a = clear($("c-auto"));
  const on = !!S.control.autoRelease;
  add(a, 
    h(
      "button",
      { type: "button", class: "switch" + (on ? " is-on" : ""), id: "auto-toggle", role: "switch", "aria-checked": String(on), onclick: toggleAuto },
      h("span", { class: "switch__knob" }),
    ),
    h("span", { class: "cbar__autolabel" }, on ? "Auto-release ON" : "Auto-release OFF"),
    on ? h("span", { class: "cbar__hint" }, "Keep this tab open") : null,
  );
  updateClocks();
}

function renderNext() {
  const el = clear($("c-next"));
  const c = cfg();
  if (!S.script) return;
  const n = Object.keys(items()).length;
  if (!n) {
    add(el, h("span", null, "No script loaded yet. "), h("button", { type: "button", class: "btn btn--sm", onclick: () => setTab("setup") }, "Import the script in Setup"));
    return;
  }
  if (!teams().length) {
    add(el, h("span", null, "No teams yet — students can't join. "), h("button", { type: "button", class: "btn btn--sm", onclick: () => setTab("setup") }, "Set up teams"));
    return;
  }
  const now = Date.now();
  const due = c.simStart != null ? dueItems(items(), S.feed, c, now) : [];
  const next = upcoming(items(), S.feed, c, now, 3);
  const released = Object.values(items()).filter((it) => isReleased(it.id, S.feed)).length;
  add(el, h("span", { class: "nextup__count" }, `${released} of ${n} released`));
  if (due.length) {
    add(el, 
      h("span", { class: "nextup__due" }, `${due.length} due now`),
      S.control.autoRelease ? null : h("button", { type: "button", class: "btn btn--primary btn--sm", id: "release-due", onclick: () => releaseItems(due) }, `Release ${due.length} due`),
    );
  }
  if (c.simStart == null) {
    add(el, h("span", { class: "nextup__muted" }, "Times appear once you start the simulation."));
    return;
  }
  next.forEach((it) => add(el, h("span", { class: "nextup__item" }, h("span", { class: "countdown", "data-at": String(scheduledAt(it, c)) }), " ", itemTitle(it))));
}

function updateClocks() {
  const c = cfg();
  const el = $("elapsed");
  if (el && c.simStart != null) el.textContent = fmtDuration(Date.now() - Number(c.simStart));
  document.querySelectorAll(".countdown[data-at]").forEach((x) => {
    const d = Number(x.dataset.at) - Date.now();
    x.textContent = d > 0 ? "in " + fmtDuration(d) : "due";
  });
}

async function startNow() {
  const c = cfg();
  const ok = await confirmDialog(
    "Start the simulation now?",
    `The clock starts now. The first message goes out in ${Number(c.firstReleaseDelayMin) || 0} minutes${S.control.autoRelease ? "" : " if auto-release is on (it's currently off)"}.`,
    "Start",
  );
  if (!ok) return;
  await S.backend.saveConfig({ simStart: Date.now() });
}

async function editStart() {
  const c = cfg();
  const base = c.simStart != null ? new Date(Number(c.simStart)) : new Date();
  const time = h("input", { type: "time", class: "input", id: "start-time", value: `${String(base.getHours()).padStart(2, "0")}:${String(base.getMinutes()).padStart(2, "0")}` });
  const delay = h("input", { type: "number", class: "input input--short", id: "start-delay", min: "0", max: "120", value: String(Number(c.firstReleaseDelayMin) || 0) });
  const v = await dialog({
    title: "Start time",
    body: h(
      "div",
      { class: "form-grid" },
      h("label", { class: "field" }, h("span", { class: "field__label" }, "Simulation starts at (today)"), time),
      h("label", { class: "field" }, h("span", { class: "field__label" }, "Minutes until the first message"), delay),
      h("p", { class: "field__hint" }, "All messages keep their original spacing after the first one. Changing this while running moves everything that hasn't gone out yet."),
    ),
    buttons: [
      { label: "Cancel", value: null },
      c.simStart != null ? { label: "Clear start (not started)", value: "clear", danger: true } : null,
      { label: "Save", value: "save", primary: true },
    ].filter(Boolean),
  });
  if (v === "clear") {
    if (await confirmDialog("Clear the start time?", "Auto-release stops and the console shows 'Not started'. Messages already released stay with students.", "Clear", true)) {
      await S.backend.saveControl({ autoRelease: false });
      await S.backend.saveConfig({ simStart: null });
    }
    return;
  }
  if (v !== "save") return;
  const [hh, mm] = (time.value || "").split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return toast("Pick a time.", { tone: "error" });
  const d = c.simStart != null ? new Date(Number(c.simStart)) : new Date();
  d.setHours(hh, mm, 0, 0);
  const dl = Math.max(0, Math.min(120, Number(delay.value) || 0));
  await S.backend.saveConfig({ simStart: d.getTime(), firstReleaseDelayMin: dl });
  toast(`Start set to ${fmtClock(d.getTime())}; first message at ${fmtClock(d.getTime() + dl * 60000)}.`);
}

async function toggleAuto() {
  const on = !S.control.autoRelease;
  if (on && cfg().simStart == null) {
    const go = await confirmDialog("The simulation hasn't started", "Auto-release only works once there's a start time. Start the simulation now and turn auto-release on?", "Start and turn on");
    if (!go) return;
    await S.backend.saveConfig({ simStart: Date.now() });
  }
  await S.backend.saveControl({ autoRelease: on });
}

// ---------- timeline ----------

function itemTitle(it) {
  if (it.channel === "social") return `${it.from}: ${String(it.body || "(image post)").slice(0, 70)}`;
  return it.subject || String(it.body).slice(0, 70) || "(no subject)";
}

function tagFor(it) {
  if (it.source === "live") return "Live";
  if (it.source === "prepared") return it.id;
  if (it.channel === "social") return "#" + it.release;
  return "#" + it.release;
}

function statusFor(it, c, now) {
  const rel = releasesOf(it.id, S.feed);
  if (rel.length) {
    const full = rel.find((r) => !String(r.key).includes("~"));
    const t = Math.min(...rel.map((r) => r.releasedAt || now));
    return { cls: "released", text: (full ? "Released " : `Sent to ${rel.length} group${rel.length > 1 ? "s" : ""} `) + fmtClock(t) };
  }
  if (it.skipped) return { cls: "skipped", text: "Skipped" };
  if (it.manualOnly) return { cls: "manual", text: "Manual" };
  const t = scheduledAt(it, c);
  if (t == null) return { cls: "idle", text: it.offsetMin == null ? "Unscheduled" : "Scheduled" };
  if (t <= now) return { cls: "due", text: "Due" };
  return { cls: "scheduled", text: "Scheduled", at: t };
}

function renderTimeline() {
  const main = $("c-main");
  if (!main.dataset.built) {
    add(clear(main), 
      h(
        "div",
        { class: "toolbar" },
        h(
          "div",
          { class: "chips", role: "group", "aria-label": "Show" },
          [["all", "Everything"], ["inbox", "Inbox messages"], ["social", "Social posts"], ["extra", "Prepared & live"]].map(([v, l]) =>
            h("button", { type: "button", class: "chip", "data-filter": v, onclick: () => { S.filter.channel = v; renderTimeline(); } }, l),
          ),
        ),
        h("input", { type: "search", class: "input input--search", id: "t-search", placeholder: "Search", value: S.filter.q, oninput: (e) => { S.filter.q = e.target.value; renderTimelineList(); } }),
        h("label", { class: "check" }, h("input", { type: "checkbox", id: "t-hide", onchange: (e) => { S.filter.hideReleased = e.target.checked; renderTimelineList(); } }), " Hide released"),
        h("button", { type: "button", class: "btn btn--sm", onclick: () => setTab("compose") }, "+ New message"),
      ),
      h("ol", { class: "tl", id: "tl" }),
    );
    main.dataset.built = "1";
  }
  main.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === S.filter.channel)));
  $("t-hide").checked = S.filter.hideReleased;
  renderTimelineList();
}

function timelineItems() {
  const c = cfg();
  const q = S.filter.q.trim().toLowerCase();
  return Object.values(items())
    .filter((it) => {
      if (S.filter.channel === "inbox" && (it.channel !== "inbox" || it.source !== "packet")) return false;
      if (S.filter.channel === "social" && (it.channel !== "social" || it.source !== "packet")) return false;
      if (S.filter.channel === "extra" && it.source === "packet") return false;
      if (S.filter.hideReleased && isReleased(it.id, S.feed)) return false;
      if (q && !`${it.id} ${it.from} ${it.to} ${it.subject} ${it.body} ${it.notes}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort(compareSchedule(c));
}

function renderTimelineList() {
  const ol = $("tl");
  if (!ol) return;
  const scrollY = window.scrollY;
  clear(ol);
  const c = cfg();
  const now = Date.now();
  const list = timelineItems();
  if (!list.length) ol.appendChild(h("li", { class: "empty" }, "Nothing matches."));
  for (const it of list) ol.appendChild(timelineRow(it, c, now));
  window.scrollTo(0, scrollY);
  updateClocks();
}

function timelineRow(it, c, now) {
  const st = statusFor(it, c, now);
  const t = scheduledAt(it, c);
  const released = st.cls === "released";
  const open = S.expanded.has(it.id);
  const row = h(
    "li",
    { class: `tl-row tl-row--${st.cls}` + (open ? " is-open" : "") + (it.channel === "social" ? " is-social" : ""), "data-id": it.id },
    h(
      "div",
      { class: "tl-row__main", onclick: (e) => { if (e.target.closest("button")) return; toggleExpand(it.id); } },
      h("span", { class: "tl-row__time" }, t != null ? fmtClock(t) : it.offsetMin != null ? `+${it.offsetMin}m` : "—"),
      h("span", { class: "tl-row__tag" }, tagFor(it)),
      h("span", { class: "tl-row__icon", title: it.channel === "social" ? "Social post" : kindLabel(it.kind) }, it.channel === "social" ? "💬" : it.kind === "phone" ? "📞" : "✉"),
      h("span", { class: "tl-row__title" }, itemTitle(it)),
      h("span", { class: "tl-row__aud" }, it.channel === "social" ? (normAudience(it.audience).teams === "ALL" ? "Public" : audienceLabel(it.audience, c).split(" · ")[1]) : audienceLabel(it.audience, c)),
      h("span", { class: `status-pill status-pill--${st.cls}` }, st.text, st.at ? h("span", { class: "countdown", "data-at": String(st.at) }) : null),
      h(
        "span",
        { class: "tl-row__actions" },
        !released ? h("button", { type: "button", class: "btn btn--sm btn--primary", "data-action": "release", onclick: () => confirmRelease(it) }, "Release") : null,
        h("button", { type: "button", class: "btn btn--sm btn--ghost", "data-action": "more", onclick: (e) => moreMenu(it, e.currentTarget) }, "•••"),
      ),
    ),
    open ? itemDetail(it) : null,
  );
  return row;
}

function toggleExpand(id) {
  if (S.expanded.has(id)) S.expanded.delete(id);
  else S.expanded.add(id);
  renderTimelineList();
}

function itemDetail(it) {
  const proj = studentProjection(it);
  return h(
    "div",
    { class: "tl-detail" },
    h(
      "div",
      { class: "tl-detail__cols" },
      h(
        "div",
        null,
        h("h4", null, "What students see"),
        it.channel === "social" ? socialPost({ ...proj, key: it.id }) : messageView({ ...proj, key: it.id }),
      ),
      h(
        "div",
        null,
        it.studentBody ? [h("h4", null, it.kind === "phone" ? "Call script (facilitator only)" : "Original text (facilitator only)"), paragraphs(it.body)] : null,
        it.notes ? [h("h4", null, "Facilitator notes"), paragraphs(it.notes)] : null,
        h("h4", null, "Details"),
        h(
          "dl",
          { class: "kv" },
          h("dt", null, "Audience"), h("dd", null, audienceLabel(it.audience, cfg())),
          h("dt", null, "Packet time"), h("dd", null, it.packetTime || "—"),
          h("dt", null, "Offset"), h("dd", null, it.offsetMin == null ? "unscheduled" : `${it.offsetMin} min after first release`),
          h("dt", null, "Auto-release"), h("dd", null, it.manualOnly ? "No (manual only)" : it.skipped ? "No (skipped)" : "Yes"),
          releasesOf(it.id, S.feed).length ? [h("dt", null, "Released to"), h("dd", null, releasesOf(it.id, S.feed).map((r) => `${audienceLabel(r.audience, cfg())} at ${fmtClockSec(r.releasedAt)}`).join("; "))] : null,
        ),
      ),
    ),
  );
}

async function confirmRelease(it) {
  if (it.kind === "phone") {
    const ok = await confirmDialog("This is a live phone call", "Releasing tells students a call is coming. Make sure someone is ready to play the caller and join each team's room.", "Release");
    if (!ok) return;
  }
  await releaseItems([it]);
}

async function moreMenu(it, anchor) {
  const released = releasesOf(it.id, S.feed);
  const actions = [
    { label: "Release to specific teams…", value: "target" },
    { label: "Edit…", value: "edit" },
    it.skipped ? { label: "Un-skip (auto-release it on schedule)", value: "unskip" } : !released.length && !it.manualOnly ? { label: "Skip (don't auto-release)", value: "skip" } : null,
    released.length ? { label: `Retract from students (${released.length})`, value: "retract", danger: true } : null,
    { label: "Duplicate as new message", value: "dup" },
    it.source !== "packet" && !released.length ? { label: "Delete", value: "delete", danger: true } : null,
    { label: "Cancel", value: null },
  ].filter(Boolean);
  const v = await dialog({ title: itemTitle(it), body: null, buttons: actions.map((a) => ({ ...a, primary: false })) });
  if (v === "target") return releaseTargeted(it);
  if (v === "edit") return editItem(it);
  if (v === "skip" || v === "unskip") return S.backend.saveScriptItem({ ...it, skipped: v === "skip" });
  if (v === "dup") return composeFrom(it);
  if (v === "retract") {
    if (await confirmDialog("Retract this message?", "It disappears from every student's screen right away. You can release it again later.", "Retract", true)) {
      for (const r of released) await S.backend.retract(r.key);
      toast("Retracted.");
    }
  }
  if (v === "delete") {
    if (await confirmDialog("Delete this message?", "It's removed from the script. This can't be undone.", "Delete", true)) await S.backend.deleteScriptItem(it.id);
  }
}

function audienceEditor(initial, channel) {
  const a = normAudience(initial);
  const wrap = h("div", { class: "aud" });
  const allRoles = h("input", { type: "checkbox", "data-aud": "all-roles", checked: a.roles === "ALL" });
  const roleBoxes = roles().map((r) => h("input", { type: "checkbox", "data-role": r.code, checked: a.roles !== "ALL" && a.roles.includes(r.code) }));
  const allTeams = h("input", { type: "checkbox", "data-aud": "all-teams", checked: a.teams === "ALL" });
  const teamBoxes = teams().map((t) => h("input", { type: "checkbox", "data-team": String(t.id), checked: a.teams !== "ALL" && a.teams.includes(String(t.id)) }));
  const sync = () => {
    roleBoxes.forEach((b) => (b.disabled = allRoles.checked));
    teamBoxes.forEach((b) => (b.disabled = allTeams.checked));
  };
  allRoles.addEventListener("change", sync);
  allTeams.addEventListener("change", sync);
  const rolesRow = h(
    "fieldset",
    { class: "aud__row", "data-row": "roles" },
    h("legend", null, "Roles"),
    h("label", { class: "check check--strong" }, allRoles, " All roles"),
    roles().map((r, i) => h("label", { class: "check" }, roleBoxes[i], " " + r.code)),
  );
  add(wrap, 
    rolesRow,
    h(
      "fieldset",
      { class: "aud__row", "data-row": "teams" },
      h("legend", null, "Teams"),
      h("label", { class: "check check--strong" }, allTeams, " All teams"),
      teams().map((t, i) => h("label", { class: "check" }, teamBoxes[i], " " + t.name)),
    ),
  );
  sync();
  const setChannel = (ch) => (rolesRow.hidden = ch === "social");
  setChannel(channel);
  return {
    el: wrap,
    setChannel,
    get() {
      const r = allRoles.checked ? "ALL" : roleBoxes.filter((b) => b.checked).map((b) => b.dataset.role);
      const t = allTeams.checked ? "ALL" : teamBoxes.filter((b) => b.checked).map((b) => b.dataset.team);
      return { roles: rolesRow.hidden ? "ALL" : r, teams: t };
    },
  };
}

function audienceProblem(a, channel) {
  if (channel !== "social" && Array.isArray(a.roles) && !a.roles.length) return "Pick at least one role.";
  if (Array.isArray(a.teams) && !a.teams.length) return "Pick at least one team.";
  return null;
}

async function releaseTargeted(it) {
  const ed = audienceEditor({ roles: it.audience.roles, teams: [] }, it.channel);
  const v = await dialog({
    title: "Release to specific teams",
    body: h("div", null, h("p", null, itemTitle(it)), ed.el, h("p", { class: "field__hint" }, "Sends a copy to just these teams and roles. Releasing to everyone later still works.")),
    buttons: [{ label: "Cancel", value: null }, { label: "Release", value: "go", primary: true }],
  });
  if (v !== "go") return;
  const aud = ed.get();
  const p = audienceProblem(aud, it.channel);
  if (p) return toast(p, { tone: "error" });
  await releaseItems([it], { audience: aud, nonce: Date.now().toString(36) });
}

async function editItem(it) {
  const f = itemForm(it, { mode: "edit" });
  const released = releasesOf(it.id, S.feed);
  const alsoFeed = h("input", { type: "checkbox", id: "e-also", checked: true });
  const v = await dialog({
    title: "Edit message",
    body: h("div", null, f.el, released.length ? h("label", { class: "check" }, alsoFeed, " Also update the copy students already have") : null),
    buttons: [{ label: "Cancel", value: null }, { label: "Save", value: "save", primary: true }],
  });
  if (v !== "save") return;
  let next;
  try {
    next = f.get();
  } catch (e) {
    return toast(e.message, { tone: "error" });
  }
  await S.backend.saveScriptItem(next);
  if (released.length && alsoFeed.checked) {
    for (const r of released) {
      const isTargeted = String(r.key).includes("~");
      await S.backend.updateFeedEntry(r.key, studentProjection(next, { releasedAt: r.releasedAt, audience: isTargeted ? r.audience : undefined }));
    }
  }
  toast("Saved.");
}

// ---------- item form (edit + compose) ----------

const KIND_OPTIONS = [["email", "Email"], ["text", "Text message"], ["phone", "Phone call"], ["voicemail", "Voicemail"], ["news", "News report"], ["press", "Press release"], ["article", "Article"], ["alert", "Alert"], ["audio", "Audio"], ["video", "Video"], ["social", "Social post"]];

function itemForm(it, { mode }) {
  const c = cfg();
  const ch = h("select", { class: "input", "data-f": "channel" }, h("option", { value: "inbox" }, "Inbox message (to executives)"), h("option", { value: "social" }, "Social / news feed post (public)"));
  ch.value = it.channel || "inbox";
  const kind = h("select", { class: "input", "data-f": "kind" }, KIND_OPTIONS.map(([v, l]) => h("option", { value: v }, l)));
  kind.value = it.kind || (ch.value === "social" ? "social" : "email");
  const senders = [...new Set(Object.values(items()).filter((x) => x.channel === "inbox").map((x) => x.from).filter(Boolean))].sort();
  const dl = h("datalist", { id: "senders-" + mode }, senders.map((s) => h("option", { value: s })));
  const from = h("input", { class: "input", "data-f": "from", value: it.from || "", list: "senders-" + mode, maxlength: "300", placeholder: ch.value === "social" ? "@handle" : "Name, title" });
  const to = h("input", { class: "input", "data-f": "to", value: it.to || "", maxlength: "600" });
  const subject = h("input", { class: "input", "data-f": "subject", value: it.subject || "", maxlength: "300" });
  const body = h("textarea", { class: "input", "data-f": "body", rows: "8" });
  body.value = it.body || "";
  const studentBody = h("textarea", { class: "input", "data-f": "studentBody", rows: "4", placeholder: "Leave empty to show the main text" });
  studentBody.value = it.studentBody || "";
  const notes = h("textarea", { class: "input", "data-f": "notes", rows: "3" });
  notes.value = it.notes || "";
  const mediaRows = (it.media && it.media.length ? it.media : []).concat([{ label: "", url: "" }]).slice(0, 4).map((m) => ({
    label: h("input", { class: "input", placeholder: "Label (e.g. News video)", value: m.label || "" }),
    url: h("input", { class: "input", placeholder: "https://drive.google.com/…", value: m.url || "" }),
    type: h("select", { class: "input input--short" }, ["link", "image", "video", "audio"].map((t) => h("option", { value: t }, t))),
    _m: m,
  }));
  mediaRows.forEach((r) => (r.type.value = r._m.type || "link"));
  const offset = h("input", { class: "input input--short", type: "number", step: "0.5", "data-f": "offsetMin", value: it.offsetMin == null ? "" : String(it.offsetMin) });
  const manual = h("input", { type: "checkbox", "data-f": "manualOnly", checked: !!it.manualOnly });
  const aud = audienceEditor(it.audience, ch.value);
  const inboxOnly = [];
  const setCh = () => {
    aud.setChannel(ch.value);
    inboxOnly.forEach((el) => (el.hidden = ch.value === "social"));
  };
  ch.addEventListener("change", () => {
    if (ch.value === "social") kind.value = "social";
    else if (kind.value === "social") kind.value = "email";
    setCh();
  });
  const fToRow = h("label", { class: "field" }, h("span", { class: "field__label" }, "To"), to);
  const fSubjRow = h("label", { class: "field" }, h("span", { class: "field__label" }, "Subject"), subject);
  inboxOnly.push(fToRow, fSubjRow);
  const el = h(
    "div",
    { class: "form-grid item-form" },
    h("div", { class: "form-row" }, h("label", { class: "field" }, h("span", { class: "field__label" }, "Where it shows"), ch), h("label", { class: "field" }, h("span", { class: "field__label" }, "Type"), kind)),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "From"), from, dl),
    fToRow,
    fSubjRow,
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Message"), body),
    h("details", { class: "more" }, h("summary", null, "Attachments, alternate student text, notes"),
      h("div", { class: "field" }, h("span", { class: "field__label" }, "Attachment links"), mediaRows.map((r) => h("div", { class: "media-row" }, r.label, r.url, r.type))),
      h("label", { class: "field" }, h("span", { class: "field__label" }, "Text students see instead (optional — e.g. for a phone-call script)"), studentBody),
      h("label", { class: "field" }, h("span", { class: "field__label" }, "Facilitator notes (never shown to students)"), notes),
    ),
    h("div", { class: "field" }, h("span", { class: "field__label" }, "Who receives it"), aud.el),
    mode === "edit"
      ? h("div", { class: "form-row" },
          h("label", { class: "field" }, h("span", { class: "field__label" }, "Minutes after first release"), offset, c.simStart != null ? h("span", { class: "field__hint" }, "Blank = unscheduled") : null),
          h("label", { class: "check" }, manual, " Manual release only"))
      : null,
  );
  setCh();
  return {
    el,
    get() {
      const media = mediaRows
        .filter((r) => r.url.value.trim())
        .map((r) => {
          const url = r.url.value.trim();
          if (!/^https?:\/\//i.test(url)) throw new Error("Attachment links must start with https://");
          return { label: r.label.value.trim() || "Attachment", url, type: r.type.value };
        });
      const audience = aud.get();
      const p = audienceProblem(audience, ch.value);
      if (p) throw new Error(p);
      if (!body.value.trim() && !media.length) throw new Error("Write a message (or add an attachment).");
      if (ch.value === "inbox" && !from.value.trim()) throw new Error("Who is it from?");
      return normItem({
        ...it,
        id: it.id || "draft",
        channel: ch.value,
        kind: kind.value,
        from: from.value.trim() || (ch.value === "social" ? "@anonymous" : ""),
        to: ch.value === "social" ? "" : to.value.trim(),
        subject: ch.value === "social" ? "" : subject.value.trim(),
        body: body.value,
        studentBody: studentBody.value.trim() ? studentBody.value : null,
        notes: notes.value,
        media,
        audience,
        offsetMin: mode === "edit" ? (offset.value === "" ? null : Number(offset.value)) : it.offsetMin,
        manualOnly: mode === "edit" ? manual.checked : it.manualOnly,
      });
    },
  };
}

// ---------- compose ----------

let composeDraft = null;

function composeFrom(it) {
  composeDraft = { ...it, id: undefined, source: "live", offsetMin: null, manualOnly: true, skipped: false };
  S.tab = "compose";
  $("c-main").dataset.built = "";
  renderAll();
}

function renderCompose() {
  const main = $("c-main");
  if (main.dataset.built) return; // keep the form as typed
  main.dataset.built = "1";
  const base = composeDraft || { channel: "inbox", kind: "email", from: "", to: "", subject: "", body: "", audience: { roles: "ALL", teams: "ALL" }, media: [], source: "live" };
  composeDraft = null;
  const form = itemForm(base, { mode: "compose" });
  const prepared = Object.values(items()).filter((it) => it.source === "prepared").sort((a, b) => a.id.localeCompare(b.id));
  const when = h("select", { class: "input", id: "cmp-when" }, h("option", { value: "now" }, "Send now"), h("option", { value: "at" }, "Send at a time"), h("option", { value: "draft" }, "Save to the timeline (release by hand later)"));
  const at = h("input", { type: "time", class: "input input--short", id: "cmp-at", hidden: true });
  when.addEventListener("change", () => (at.hidden = when.value !== "at"));
  const preview = h("div", { class: "cmp-preview", id: "cmp-preview" });
  const refreshPreview = () => {
    clear(preview);
    try {
      const it = form.get();
      const p = { ...studentProjection({ ...it, id: "preview" }), key: "preview" };
      add(preview, h("h4", null, "Preview"), it.channel === "social" ? socialPost(p) : messageView(p), h("p", { class: "field__hint" }, "Goes to: " + audienceLabel(it.audience, cfg())));
    } catch (e) {
      add(preview, h("h4", null, "Preview"), h("p", { class: "field__hint" }, e.message));
    }
  };
  form.el.addEventListener("input", refreshPreview);
  form.el.addEventListener("change", refreshPreview);
  const send = h("button", { type: "button", class: "btn btn--primary", id: "cmp-send", onclick: () => onCompose(form, when.value, at.value) }, "Send");
  add(clear(main), 
    h(
      "div",
      { class: "compose" },
      h(
        "div",
        { class: "compose__form" },
        h("div", { class: "compose__head" }, h("h2", null, "New message"),
          prepared.length
            ? h("select", { class: "input", id: "cmp-load", onchange: (e) => { const p = items()[e.target.value]; if (p) composeFrom(p); } }, h("option", { value: "" }, "Start from a prepared interjection…"), prepared.map((p) => h("option", { value: p.id }, `${p.id} · ${itemTitle(p)}`)))
            : null),
        form.el,
        h("div", { class: "form-row compose__send" }, when, at, send),
      ),
      preview,
    ),
  );
  refreshPreview();
}

async function onCompose(form, when, atValue) {
  let it;
  try {
    it = form.get();
  } catch (e) {
    return toast(e.message, { tone: "error" });
  }
  const c = cfg();
  const now = Date.now();
  const id = "L" + now.toString(36).toUpperCase();
  it = normItem({ ...it, id, source: "live", createdAt: now, seq: 100000 + (now % 100000) });
  if (when === "now") {
    it.offsetMin = c.simStart != null ? offsetForTime(now, c) : null;
    it.manualOnly = true;
    await S.backend.saveScriptItem(it);
    const keys = await releaseItems([it]);
    if (!keys.length) return;
  } else if (when === "at") {
    if (c.simStart == null) return toast("Start the simulation first — scheduled times are relative to the start.", { tone: "error" });
    const [hh, mm] = (atValue || "").split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return toast("Pick a time.", { tone: "error" });
    const d = new Date(Number(c.simStart));
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() < now - 60000) return toast("That time has already passed.", { tone: "error" });
    it.offsetMin = offsetForTime(d.getTime(), c);
    it.manualOnly = false;
    await S.backend.saveScriptItem(it);
    toast(`Scheduled for ${fmtClock(d.getTime())}${S.control.autoRelease ? "" : " — note: auto-release is off"}.`);
  } else {
    it.offsetMin = null;
    it.manualOnly = true;
    await S.backend.saveScriptItem(it);
    toast("Saved to the timeline under 'Prepared & live'.");
  }
  $("c-main").dataset.built = "";
  renderAll();
}

// ---------- responses ----------

function renderResponses() {
  const main = $("c-main");
  const c = cfg();
  if (!main.dataset.built) {
    main.dataset.built = "1";
    add(clear(main), 
      h(
        "div",
        { class: "toolbar" },
        h("select", { class: "input", id: "rf-team", onchange: (e) => { S.respFilter.team = e.target.value; renderResponseList(); } }),
        h("select", { class: "input", id: "rf-role", onchange: (e) => { S.respFilter.role = e.target.value; renderResponseList(); } }),
        h("label", { class: "check" }, h("input", { type: "checkbox", id: "rf-open", checked: S.respFilter.open, onchange: (e) => { S.respFilter.open = e.target.checked; renderResponseList(); } }), " Only unhandled"),
        h("button", { type: "button", class: "btn btn--sm", onclick: exportResponses }, "Download CSV"),
      ),
      h("div", { class: "resp-list", id: "resp-list" }),
    );
  }
  const ft = $("rf-team");
  add(clear(ft), h("option", { value: "" }, "All teams"), teams().map((t) => h("option", { value: String(t.id) }, t.name)));
  ft.value = S.respFilter.team;
  const fr = $("rf-role");
  add(clear(fr), h("option", { value: "" }, "All roles"), roles().map((r) => h("option", { value: r.code }, r.code)));
  fr.value = S.respFilter.role;
  renderResponseList();
}

function renderResponseList() {
  const el = $("resp-list");
  if (!el) return;
  clear(el);
  if (!S.responsesLoaded) return el.appendChild(h("p", { class: "empty" }, "Loading…"));
  const list = S.responses.filter((r) => (!S.respFilter.team || r.team === S.respFilter.team) && (!S.respFilter.role || r.role === S.respFilter.role) && (!S.respFilter.open || !r.handled));
  if (!list.length) return el.appendChild(h("p", { class: "empty" }, S.responses.length ? "Nothing matches these filters." : "No responses yet. They appear here the moment a student sends one."));
  for (const r of list) {
    const re = r.replyTo ? S.feed[r.replyTo] : null;
    el.appendChild(
      h(
        "article",
        { class: "resp" + (r.handled ? " is-handled" : ""), "data-id": r.id },
        h("div", { class: "resp__head" },
          h("strong", null, teamName(r.team)),
          h("span", null, roleName(r.role)),
          r.name ? h("span", { class: "resp__name" }, r.name) : null,
          h("span", { class: "resp__kind" }, (RESPONSE_KINDS.find((k) => k.code === r.kind) || { label: r.kind }).label),
          h("span", { class: "resp__time" }, fmtClockSec(r.createdAt)),
        ),
        re ? h("div", { class: "resp__re" }, "Re: ", re.subject || `${re.from}: ${String(re.body).slice(0, 60)}`) : null,
        h("div", { class: "resp__text" }, paragraphs(r.text)),
        h("div", { class: "resp__actions" },
          h("button", { type: "button", class: "btn btn--sm", "data-action": "handled", onclick: () => S.backend.markResponse(r.id, { handled: !r.handled }) }, r.handled ? "Mark unhandled" : "Mark handled"),
          h("button", { type: "button", class: "btn btn--sm btn--primary", "data-action": "reply", onclick: () => replyTo(r) }, "Reply to this team…"),
        ),
      ),
    );
  }
}

function replyTo(r) {
  composeDraft = {
    channel: "inbox",
    kind: "email",
    from: mostFrequentSender(),
    to: roleName(r.role),
    subject: "",
    body: "",
    audience: { roles: [r.role], teams: [String(r.team)] },
    media: [],
    source: "live",
  };
  S.tab = "compose";
  $("c-main").dataset.built = "";
  renderAll();
}

function mostFrequentSender() {
  const counts = {};
  for (const it of Object.values(items())) if (it.channel === "inbox" && it.from) counts[it.from] = (counts[it.from] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function exportResponses() {
  const csv = toCsv(
    [...S.responses].sort((a, b) => a.createdAt - b.createdAt),
    [
      { label: "Time", get: (r) => new Date(r.createdAt).toLocaleString() },
      { label: "Team", get: (r) => teamName(r.team) },
      { label: "Role", key: "role" },
      { label: "Name", key: "name" },
      { label: "Type", key: "kind" },
      { label: "In reply to", get: (r) => (r.replyTo && S.feed[r.replyTo] ? S.feed[r.replyTo].subject || S.feed[r.replyTo].from : r.replyTo || "") },
      { label: "Text", key: "text" },
      { label: "Handled", get: (r) => (r.handled ? "yes" : "") },
    ],
  );
  download(`responses-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
}

// ---------- preview ----------

function renderPreview() {
  const main = $("c-main");
  if (!S.preview.team && teams().length) S.preview.team = String(teams()[0].id);
  if (!main.dataset.built) {
    main.dataset.built = "1";
    add(clear(main), 
      h("div", { class: "toolbar" },
        h("select", { class: "input", id: "pv-team", onchange: (e) => { S.preview.team = e.target.value; S.preview.selected = null; renderPreviewBody(); } }),
        h("select", { class: "input", id: "pv-role", onchange: (e) => { S.preview.role = e.target.value; S.preview.selected = null; renderPreviewBody(); } }),
        h("a", { class: "btn btn--sm btn--ghost", id: "pv-open", target: "_blank", rel: "noopener" }, "Open the student page ↗"),
      ),
      h("div", { class: "preview", id: "pv" }),
    );
  }
  const pt = $("pv-team");
  add(clear(pt), teams().map((t) => h("option", { value: String(t.id) }, t.name)));
  pt.value = S.preview.team;
  const pr = $("pv-role");
  add(clear(pr), roles().map((r) => h("option", { value: r.code }, `${r.code} — ${r.character}`)));
  pr.value = S.preview.role;
  renderPreviewBody();
}

function renderPreviewBody() {
  const pv = $("pv");
  if (!pv) return;
  const viewer = { team: S.preview.team, role: S.preview.role };
  $("pv-open").href = carryParams(`index.html?team=${encodeURIComponent(viewer.team)}&role=${encodeURIComponent(viewer.role)}`);
  const all = feedList(S.feed).filter((f) => isForViewer(f, viewer));
  const inbox = all.filter((f) => f.channel !== "social");
  const social = all.filter((f) => f.channel === "social");
  const sel = inbox.find((f) => f.key === S.preview.selected) || null;
  add(clear(pv), 
    h("section", { class: "pane pane--inbox" }, h("div", { class: "pane__head" }, h("h2", null, `Inbox (${inbox.length})`)),
      h("div", { class: "inbox-list" }, inbox.length ? inbox.map((f) => inboxRow(f, { unread: false, selected: f.key === S.preview.selected, onOpen: (k) => { S.preview.selected = k; renderPreviewBody(); } })) : h("p", { class: "empty" }, "Nothing yet."))),
    h("section", { class: "pane pane--reader" }, messageView(sel)),
    h("section", { class: "pane pane--social" }, h("div", { class: "pane__head" }, h("h2", null, `Social (${social.length})`)), h("div", { class: "social-list" }, social.length ? social.map((f) => socialPost(f)) : h("p", { class: "empty" }, "Nothing yet."))),
  );
}

// ---------- setup ----------

function renderSetup() {
  const main = $("c-main");
  if (main.dataset.built) {
    renderSetupLive();
    return;
  }
  main.dataset.built = "1";
  const c = cfg();
  const studentUrl = new URL(carryParams("index.html"), location.href).href;
  const nTeams = h("input", { type: "number", class: "input input--short", id: "s-nteams", min: "1", max: "40", value: String(teams().length || 6) });
  const teamNames = h("div", { class: "team-names", id: "s-team-names" });
  const drawNames = () => {
    const n = Math.max(1, Math.min(40, Number(nTeams.value) || 1));
    const existing = [...teamNames.querySelectorAll("input")].map((i) => i.value);
    clear(teamNames);
    for (let i = 0; i < n; i++) {
      const cur = teams()[i];
      teamNames.appendChild(h("label", { class: "field field--inline" }, h("span", { class: "field__label" }, `Team ${i + 1}`), h("input", { class: "input", "data-team-name": String(i + 1), value: existing[i] || (cur && cur.name) || `Team ${i + 1}`, maxlength: "60" })));
    }
  };
  nTeams.addEventListener("input", drawNames);
  drawNames();
  const fileIn = h("input", { type: "file", accept: ".json,application/json", id: "s-file" });
  const fileMsg = h("div", { id: "s-file-msg", class: "field__hint" });
  fileIn.addEventListener("change", () => onImportFile(fileIn, fileMsg));

  add(clear(main), 
    h("div", { class: "setup" },
      card("Student link", h("p", null, "Share this one link with every student (bCourses or the class chat). They pick their own team and role."),
        h("div", { class: "copy-row" }, h("input", { class: "input", readonly: true, value: studentUrl, id: "s-link" }), h("button", { type: "button", class: "btn", onclick: () => copy(studentUrl) }, "Copy"))),
      card("Teams", h("div", { class: "form-row" }, h("label", { class: "field" }, h("span", { class: "field__label" }, "Number of teams"), nTeams)), teamNames,
        h("button", { type: "button", class: "btn btn--primary", id: "s-save-teams", onclick: saveTeams }, "Save teams"),
        h("p", { class: "field__hint" }, "Renaming is safe at any time. Removing a team while students are in it sends them back to the join screen.")),
      card("Script", h("div", { id: "s-script-info" }),
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Import a script file (.json)"), fileIn), fileMsg,
        h("div", { class: "btn-row" },
          h("button", { type: "button", class: "btn", onclick: exportScript }, "Download current script"),
          h("button", { type: "button", class: "btn", onclick: printRunSheet }, "Printable run-sheet"))),
      card("Security self-check", h("p", null, "Signs in as a test student and confirms students can't see unreleased messages or other teams' responses. Run once after setup."),
        h("button", { type: "button", class: "btn", id: "s-selfcheck", onclick: runSelfCheck }, "Run self-check"), h("div", { id: "s-selfcheck-out" })),
      card("Reset for a rehearsal or the real thing", h("p", null, "Clears what students see, the start time and auto-release. Optionally deletes responses. The script and teams stay."),
        h("label", { class: "check" }, h("input", { type: "checkbox", id: "s-reset-resp" }), " Also delete all student responses"),
        h("label", { class: "check" }, h("input", { type: "checkbox", id: "s-reset-skips", checked: true }), " Un-skip skipped messages and remove live messages"),
        h("button", { type: "button", class: "btn btn--danger", id: "s-reset", onclick: resetSim }, "Reset simulation…")),
    ),
  );
  renderSetupLive();
}

function renderSetupLive() {
  const info = $("s-script-info");
  if (!info) return;
  const all = Object.values(items());
  const m = S.script && S.script.meta;
  add(clear(info), 
    h("p", null, all.length
      ? `${m && m.title ? m.title + ": " : ""}${all.filter((i) => i.channel === "inbox" && i.source === "packet").length} inbox messages, ${all.filter((i) => i.channel === "social" && i.source === "packet").length} social posts, ${all.filter((i) => i.source === "prepared").length} prepared, ${all.filter((i) => i.source === "live").length} live.${m && m.importedAt ? " Imported " + new Date(m.importedAt).toLocaleString() + "." : ""}`
      : "No script loaded yet."),
  );
}

function card(title, ...children) {
  return h("section", { class: "card" }, h("h3", null, title), ...children);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    const i = $("s-link");
    i.select();
    toast("Press Ctrl/⌘+C to copy.");
  }
}

async function saveTeams() {
  const inputs = [...document.querySelectorAll("[data-team-name]")];
  const list = inputs.map((i) => ({ id: i.dataset.teamName, name: i.value.trim() || `Team ${i.dataset.teamName}` }));
  const removed = teams().filter((t) => !list.some((x) => x.id === String(t.id)));
  if (removed.length && !(await confirmDialog("Remove teams?", `${removed.map((t) => t.name).join(", ")} will be removed. Students in them go back to the join screen.`, "Remove", true))) return;
  await S.backend.saveConfig({ teams: list });
  toast(`Saved ${list.length} teams.`);
}

async function onImportFile(input, msg) {
  const file = input.files && input.files[0];
  if (!file) return;
  clear(msg);
  const text = await file.text();
  const parsed = parseScriptFile(text);
  const n = Object.keys(parsed.items).length;
  if (!n) {
    msg.textContent = parsed.errors.join(" ") || "No items found.";
    msg.className = "field__hint is-error";
    input.value = "";
    return;
  }
  const existing = Object.values(items());
  const live = existing.filter((i) => i.source === "live");
  const ok = await dialog({
    title: "Import this script?",
    body: h("div", null,
      h("p", null, `${n} messages found${parsed.errors.length ? `, ${parsed.errors.length} skipped because of problems` : ""}.`),
      parsed.errors.length ? h("ul", { class: "mini-list" }, parsed.errors.slice(0, 8).map((e) => h("li", null, e))) : null,
      existing.length ? h("p", null, `This replaces the ${existing.length} messages in the current script${live.length ? ` (your ${live.length} live messages are kept)` : ""}. Messages students already have stay on their screens.`) : null),
    buttons: [{ label: "Cancel", value: false }, { label: "Import", value: true, primary: true }],
  });
  input.value = "";
  if (!ok) return;
  const merged = { ...parsed.items };
  for (const l of live) if (!merged[l.id]) merged[l.id] = l;
  await S.backend.importScript(merged, parsed.meta);
  await S.backend.saveConfig({ roles: parsed.roles, title: `${parsed.meta.title} Crisis Simulation`, company: parsed.meta.company || cfg().company });
  msg.textContent = `Imported ${n} messages.`;
  msg.className = "field__hint is-ok";
}

function exportScript() {
  const out = {
    format: "crisis-sim-script/v1",
    case: { title: (S.script.meta && S.script.meta.title) || cfg().title, company: cfg().company, summary: (S.script.meta && S.script.meta.summary) || "", roles: roles() },
    items: Object.values(items()).sort(compareSchedule(cfg())),
  };
  download(`script-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 1), "application/json");
}

function printRunSheet() {
  const c = cfg();
  const list = Object.values(items()).filter((i) => i.channel === "inbox" || i.source !== "packet").sort(compareSchedule(c));
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to open the run-sheet.", { tone: "error" });
  const d = w.document;
  d.title = "Run-sheet";
  const style = d.createElement("style");
  style.textContent = "body{font:12px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:5px 7px;vertical-align:top;text-align:left}th{background:#eee}.n{color:#555;font-size:11px}tr{page-break-inside:avoid}";
  d.head.appendChild(style);
  const hdr = d.createElement("h1");
  hdr.textContent = `${c.title} — run-sheet (inbox messages; social posts omitted)`;
  d.body.appendChild(hdr);
  const p = d.createElement("p");
  p.textContent = c.simStart != null ? `Start ${fmtClock(Number(c.simStart))}, first release ${fmtClock(Number(c.simStart) + (Number(c.firstReleaseDelayMin) || 0) * 60000)}.` : "Not started: times shown as minutes after the first release.";
  d.body.appendChild(p);
  const t = d.createElement("table");
  t.innerHTML = "<thead><tr><th>Time</th><th>#</th><th>To</th><th>From / subject</th><th>Notes</th><th>Done</th></tr></thead>";
  const tb = d.createElement("tbody");
  for (const it of list) {
    const tr = d.createElement("tr");
    const cells = [
      scheduledAt(it, c) != null ? fmtClock(scheduledAt(it, c)) : it.offsetMin != null ? `+${it.offsetMin}m` : "manual",
      tagFor(it),
      audienceLabel(it.audience, c),
      `${it.from}\n${it.subject || ""}`,
      (it.manualOnly ? "MANUAL. " : "") + (it.notes || "").slice(0, 300),
      "☐",
    ];
    cells.forEach((v, i) => {
      const td = d.createElement("td");
      td.textContent = v;
      if (i === 4) td.className = "n";
      td.style.whiteSpace = i === 3 ? "pre-line" : "";
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  d.body.appendChild(t);
}

async function runSelfCheck() {
  const out = clear($("s-selfcheck-out"));
  out.appendChild(h("p", null, "Running…"));
  let res;
  try {
    res = await S.backend.selfCheck();
  } catch (e) {
    clear(out).appendChild(h("p", { class: "is-error" }, "Self-check failed to run: " + (e.message || e)));
    return;
  }
  const allOk = res.every((r) => r.ok);
  add(clear(out), 
    h("p", { class: allOk ? "is-ok" : "is-error" }, allOk ? "All checks passed." : "Some checks failed — see below and the setup guide."),
    h("table", { class: "checks" }, h("tbody", null, res.map((r) => h("tr", { class: r.ok ? "ok" : "bad" }, h("td", null, r.ok ? "✓" : "✗"), h("td", null, r.label), h("td", null, r.ok ? "" : `expected ${r.expect}, got ${r.got}`))))),
  );
}

async function resetSim() {
  const delResp = $("s-reset-resp").checked;
  const unskip = $("s-reset-skips").checked;
  const typed = h("input", { class: "input", id: "reset-confirm", placeholder: "Type RESET" });
  const v = await dialog({
    title: "Reset the simulation?",
    body: h("div", null, h("p", null, `Students' screens go blank and the clock stops.${delResp ? " All responses are deleted." : ""} This can't be undone.`), typed),
    buttons: [{ label: "Cancel", value: false }, { label: "Reset", value: true, danger: true }],
  });
  if (!v) return;
  if (typed.value.trim().toUpperCase() !== "RESET") return toast("Type RESET to confirm.", { tone: "error" });
  await S.backend.saveControl({ autoRelease: false });
  await S.backend.saveConfig({ simStart: null });
  await S.backend.clearFeed();
  if (unskip) {
    const keep = {};
    for (const it of Object.values(items())) if (it.source !== "live") keep[it.id] = { ...it, skipped: false };
    await S.backend.importScript(keep, S.script.meta);
  }
  if (delResp) await S.backend.deleteAllResponses();
  toast("Reset done.");
}

boot();
