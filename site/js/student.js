import { loadBackend, resilientWatch } from "./store.js";
import { h, add, clear, toast, chime, confirmDialog, qs } from "./ui.js";
import { isForViewer, feedList, fmtClock, DEFAULT_ROLES } from "./model.js";
import { inboxRow, messageView, socialPost, kindLabel } from "./feedview.js";

const ID_KEY = "csim-identity";
const SOUND_KEY = "csim-sound";
const LOCK_KEY = "csim-team-lock";

const S = {
  backend: null,
  config: null,
  feed: {},
  feedLoaded: false,
  online: true,
  configLost: false,
  identity: null,
  tab: "inbox",
  selected: null,
  read: new Set(),
  known: null, // keys seen so far; null until the first feed snapshot after joining
  freshSocial: new Set(),
  sound: localStorage.getItem(SOUND_KEY) !== "off",
  built: false,
  join: { team: null, role: null }, // picks on the join screen, kept across re-renders
  lockedTeam: null, // set when the student arrived on a team link (index.html?team=3): they only pick a role
  joinSig: null, // what the join screen was last drawn from; null when it isn't showing
};

const $ = (id) => document.getElementById(id);
const roles = () => (S.config && Array.isArray(S.config.roles) && S.config.roles.length ? S.config.roles : DEFAULT_ROLES);
const teams = () => (S.config && Array.isArray(S.config.teams) ? S.config.teams : []);
const roleInfo = (code) => roles().find((r) => r.code === code) || { code, character: code, title: code };
const teamInfo = (id) => teams().find((t) => String(t.id) === String(id));
const idKey = () => (S.identity ? `${S.identity.team}:${S.identity.role}` : "none");

function loadLocal(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function saveLocal(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

// ---------- boot ----------

async function boot() {
  initTeamLock();
  try {
    S.backend = await loadBackend();
  } catch (e) {
    console.error(e);
    return bootMessage("Couldn't load the simulation. Check your internet connection and reload the page.");
  }
  if (!S.backend) return bootMessage("This site hasn't been connected to its database yet. If you're the facilitator, see the setup guide.");
  if (S.backend.kind === "mock") document.body.classList.add("is-mock");

  // Anonymous sign-in stays: the database rules only let signed-in visitors read the feed.
  S.backend.signInStudent().catch((e) => console.error(e));

  // Both listeners re-subscribe by themselves after an error (a Firestore listener stops for good otherwise).
  const lost = (what) => (e) => {
    console.error(what, e);
    if (what === "config") S.configLost = true;
    else S.online = false;
    if (!S.config) bootMessage("Couldn't reach the simulation. Trying again…");
    else if (S.built) renderHeader();
  };
  resilientWatch(
    S.backend.watchConfig,
    (cfg) => {
      S.configLost = false;
      S.config = cfg || {};
      resolveIdentity();
      render();
    },
    { onLost: lost("config") },
  );
  resilientWatch(
    S.backend.watchFeed,
    (feed, meta) => {
      S.online = !(meta && meta.fromCache);
      onFeed(feed || {});
    },
    { onLost: lost("feed") },
  );
  const onNet = () => S.built && renderHeader();
  window.addEventListener("online", onNet);
  window.addEventListener("offline", onNet);
  setInterval(tickClock, 1000);
}

function bootMessage(msg) {
  const el = $("boot-msg");
  if (el) el.textContent = msg;
  else {
    clear($("app")).appendChild(h("div", { class: "boot" }, h("div", { class: "boot__logo" }, "★"), h("p", { class: "boot__msg" }, msg)));
    S.built = false;
    S.joinSig = null;
  }
}

// ---------- identity ----------

// A team link (?team=3, no role) locks the team for this device until the student opens the general link again.
// After joining, the URL also carries &role=, so the lock is remembered to survive reloads and "Switch role".
function initTeamLock() {
  const urlTeam = qs("team"), urlRole = qs("role");
  if (urlTeam && !urlRole) S.lockedTeam = String(urlTeam);
  else if (urlTeam && urlRole) S.lockedTeam = loadLocal(LOCK_KEY, null);
  else S.lockedTeam = null;
  saveLocal(LOCK_KEY, S.lockedTeam);
}

/** The locked team, if it still exists in the facilitators' team list (a bad link falls back to the picker). */
const lockedTeam = () => (S.lockedTeam && teamInfo(S.lockedTeam) ? S.lockedTeam : null);

function resolveIdentity() {
  if (!S.config) return;
  let id = S.identity || loadLocal(ID_KEY, null);
  const urlTeam = qs("team"), urlRole = qs("role");
  if (urlTeam && urlRole) id = { ...(id || {}), team: urlTeam, role: urlRole.toUpperCase() };
  else if (id && lockedTeam() && String(id.team) !== lockedTeam()) id = null; // team link for a different team than last time
  if (id && teamInfo(id.team) && roles().some((r) => r.code === id.role)) {
    if (!S.identity || S.identity.team !== id.team || S.identity.role !== id.role) setIdentity(id);
  } else if (S.identity && (!teamInfo(S.identity.team) || !roles().some((r) => r.code === S.identity.role))) {
    S.identity = null; // team was removed by the facilitators
    S.built = false;
  }
}

function setIdentity(id) {
  S.identity = { team: String(id.team), role: id.role };
  saveLocal(ID_KEY, S.identity);
  S.read = new Set(loadLocal("csim-read:" + idKey(), []));
  S.known = null;
  S.selected = null;
  S.built = false;
  const u = new URL(location.href);
  u.searchParams.set("team", S.identity.team);
  u.searchParams.set("role", S.identity.role);
  history.replaceState(null, "", u.pathname + u.search);
}

// ---------- feed ----------

function myItems() {
  if (!S.identity) return { inbox: [], social: [] };
  const all = feedList(S.feed).filter((f) => isForViewer(f, S.identity));
  return { inbox: all.filter((f) => f.channel !== "social"), social: all.filter((f) => f.channel === "social") };
}

function onFeed(feed) {
  S.feed = feed;
  S.feedLoaded = true;
  if (!S.identity) return render();
  const { inbox, social } = myItems();
  const keys = new Set([...inbox, ...social].map((f) => f.key));
  if (S.known === null) {
    S.known = keys;
  } else {
    const newInbox = inbox.filter((f) => !S.known.has(f.key));
    const newSocial = social.filter((f) => !S.known.has(f.key));
    newSocial.forEach((f) => S.freshSocial.add(f.key));
    if (newInbox.length) {
      newInbox.slice(0, 3).forEach((f) =>
        toast(h("span", null, h("strong", null, f.kind === "phone" ? "📞 Incoming call" : "New " + kindLabel(f.kind).toLowerCase()), " — ", f.subject || f.from), {
          onClick: () => openMessage(f.key),
          ms: 8000,
        }),
      );
      if (newInbox.length > 3) toast(`+${newInbox.length - 3} more new messages`);
    }
    if ((newInbox.length || newSocial.length) && S.sound) chime();
    S.known = keys;
  }
  if (S.selected && !S.feed[S.selected]) S.selected = null; // retracted
  render();
}

function markRead(key) {
  if (!key || S.read.has(key)) return;
  S.read.add(key);
  saveLocal("csim-read:" + idKey(), [...S.read]);
}

function openMessage(key) {
  S.selected = key;
  S.tab = "inbox";
  markRead(key);
  render();
  const r = $("reader");
  if (r) r.scrollTop = 0;
}

// ---------- render ----------

function render() {
  if (!S.config) return;
  if (!S.identity) return renderJoin();
  if (S.known === null && S.feedLoaded) {
    // Joined after the feed loaded: what's already there is not "new" (no toasts), but stays unread.
    const { inbox, social } = myItems();
    S.known = new Set([...inbox, ...social].map((f) => f.key));
  }
  if (!S.built) buildWorkspace();
  renderHeader();
  renderInbox();
  renderReader();
  renderSocial();
  renderTabs();
}

function renderJoin() {
  S.built = false;
  const t = teams();
  // Redraw only when something on this screen changed, so a release or other update doesn't wipe a half-filled form.
  const lock = lockedTeam();
  const sig = JSON.stringify([t, roles().map((r) => [r.code, r.character, r.title]), S.config && S.config.title, S.config && S.config.company, lock]);
  if (S.joinSig === sig && $("app").querySelector(".join")) return;
  S.joinSig = sig;
  const app = clear($("app"));
  const J = S.join;
  if (lock) J.team = lock;
  if (J.team && !t.some((tm) => String(tm.id) === J.team)) J.team = null;
  if (J.role && !roles().some((r) => r.code === J.role)) J.role = null;
  const lockedInfo = lock && teamInfo(lock);
  const go = h("button", { type: "submit", class: "btn btn--primary btn--lg", id: "join-go", disabled: true }, "Enter the workspace");
  const update = () => {
    go.disabled = !(J.team && J.role);
    app.querySelectorAll("[data-team]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.team === J.team)));
    app.querySelectorAll("[data-role]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.role === J.role)));
  };
  app.appendChild(
    h(
      "main",
      { class: "join" },
      h("div", { class: "join__brand" }, h("span", { class: "logo" }, "★"), h("span", null, (S.config && S.config.company) || "StarNight Aerospace")),
      h("h1", { class: "join__title" }, (S.config && S.config.title) || "Crisis Simulation"),
      !t.length
        ? h("p", { class: "join__wait" }, "Your facilitators haven't set up the teams yet. This page will update by itself — no need to reload.")
        : h(
            "form",
            {
              class: "join__form",
              onsubmit: (e) => {
                e.preventDefault();
                if (!J.team || !J.role) return;
                setIdentity({ team: J.team, role: J.role });
                S.join = { team: null, role: null };
                render();
              },
            },
            lockedInfo
              ? h("p", { class: "join__team", id: "join-team" }, "Your team: ", h("strong", null, lockedInfo.name || "Team " + lockedInfo.id))
              : [
                  h("h2", null, "1. Your team"),
                  h(
                    "div",
                    { class: "choice-grid choice-grid--teams" },
                    t.map((tm) =>
                      h("button", { type: "button", class: "choice", "data-team": String(tm.id), "aria-pressed": "false", onclick: () => { J.team = String(tm.id); update(); } }, tm.name || "Team " + tm.id),
                    ),
                  ),
                ],
            h("h2", null, lockedInfo ? "Your role" : "2. Your role"),
            h(
              "div",
              { class: "choice-grid" },
              roles().map((r) =>
                h(
                  "button",
                  { type: "button", class: "choice choice--role", "data-role": r.code, "aria-pressed": "false", onclick: () => { J.role = r.code; update(); } },
                  h("span", { class: "choice__code" }, r.code),
                  h("span", { class: "choice__name" }, r.character),
                  h("span", { class: "choice__title" }, r.title),
                ),
              ),
            ),
            go,
          ),
    ),
  );
  update();
}

function buildWorkspace() {
  S.joinSig = null;
  const app = clear($("app"));
  app.appendChild(
    h(
      "div",
      { class: "ws", id: "ws", "data-tab": S.tab },
      h(
        "header",
        { class: "topbar" },
        h("div", { class: "topbar__brand" }, h("span", { class: "logo" }, "★"), h("span", { class: "topbar__company", id: "company" })),
        h("div", { class: "topbar__who", id: "who" }),
        h(
          "div",
          { class: "topbar__right" },
          h("span", { class: "status", id: "status" }),
          h("span", { class: "clock", id: "clock" }),
          h("button", { type: "button", class: "btn btn--ghost btn--sm", id: "sound-btn", onclick: toggleSound, title: "Sound for new messages" }),
          h("button", { type: "button", class: "btn btn--ghost btn--sm", id: "switch", onclick: switchRole }, "Switch role"),
        ),
      ),
      h(
        "nav",
        { class: "tabs", id: "tabs" },
        tabBtn("inbox", "Inbox"),
        tabBtn("social", "Social"),
      ),
      h(
        "main",
        { class: "panes" },
        h("section", { class: "pane pane--inbox", "aria-label": "Inbox" }, h("div", { class: "pane__head" }, h("h2", null, "Inbox"), h("span", { class: "count", id: "inbox-count" })), h("div", { class: "inbox-list", id: "inbox-list" })),
        h("section", { class: "pane pane--reader", id: "reader", "aria-label": "Message" }),
        h("section", { class: "pane pane--social", "aria-label": "Social media" }, h("div", { class: "pane__head" }, h("h2", null, "Social & news feed"), h("span", { class: "live-dot" }, "live")), h("div", { class: "social-list", id: "social-list" })),
      ),
    ),
  );
  S.built = true;
}

function tabBtn(tab, label) {
  return h(
    "button",
    {
      type: "button",
      class: "tab",
      "data-tab": tab,
      role: "tab",
      onclick: () => {
        S.tab = tab;
        if (tab === "social") S.freshSocial.clear();
        renderTabs();
      },
    },
    label,
    h("span", { class: "tab__badge", id: "badge-" + tab }),
  );
}

function renderTabs() {
  const ws = $("ws");
  if (!ws) return;
  ws.dataset.tab = S.tab;
  ws.dataset.reading = S.selected ? "1" : "0";
  ws.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  const { inbox, social } = myItems();
  const unread = inbox.filter((f) => !S.read.has(f.key)).length;
  $("badge-inbox").textContent = unread ? String(unread) : "";
  $("badge-social").textContent = S.freshSocial.size && S.tab !== "social" ? String(S.freshSocial.size) : "";
  document.title = (unread ? `(${unread}) ` : "") + "StarNight — Executive Workspace";
}

function renderHeader() {
  if (!$("who")) return;
  const r = roleInfo(S.identity.role);
  const tm = teamInfo(S.identity.team);
  $("company").textContent = (S.config && S.config.company) || "StarNight Aerospace";
  add(clear($("who")), 
    h("span", { class: "who__name" }, r.character),
    h("span", { class: "who__title" }, `${r.title} · ${tm ? tm.name : "Team " + S.identity.team}`),
  );
  const st = $("status");
  const live = S.online && !S.configLost && navigator.onLine;
  st.textContent = !S.feedLoaded ? "Connecting…" : live ? "Live" : "Reconnecting…";
  st.className = "status " + (S.feedLoaded && live ? "status--ok" : "status--warn");
  $("sound-btn").textContent = S.sound ? "🔔" : "🔕";
  $("sound-btn").setAttribute("aria-label", S.sound ? "Sound on" : "Sound off");
  tickClock();
}

function tickClock() {
  const c = $("clock");
  if (c) c.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function emptyState(kind) {
  const cfg = S.config || {};
  if (!S.feedLoaded) return h("p", { class: "empty" }, "Loading…");
  if (cfg.simStart == null) return h("p", { class: "empty" }, kind === "social" ? "Nothing posted yet." : "The simulation hasn't started yet. Your messages will appear here automatically — keep this page open.");
  const first = Number(cfg.simStart) + (Number(cfg.firstReleaseDelayMin) || 0) * 60000;
  if (kind === "social") return h("p", { class: "empty" }, "Nothing posted yet.");
  return h("p", { class: "empty" }, first > Date.now() ? `Stand by. The first messages arrive around ${fmtClock(first)}.` : "No messages for your role yet. Stand by.");
}

function renderInbox() {
  const { inbox } = myItems();
  const list = clear($("inbox-list"));
  $("inbox-count").textContent = inbox.length ? String(inbox.length) : "";
  if (!inbox.length) return list.appendChild(emptyState("inbox"));
  inbox.forEach((f) => list.appendChild(inboxRow(f, { unread: !S.read.has(f.key), selected: f.key === S.selected, onOpen: openMessage })));
}

function renderReader() {
  const item = S.selected ? myItems().inbox.find((f) => f.key === S.selected) : null;
  if (S.selected && !item) S.selected = null;
  const r = clear($("reader"));
  r.appendChild(messageView(item, { onBack: () => { S.selected = null; render(); } }));
}

function renderSocial() {
  const { social } = myItems();
  const list = clear($("social-list"));
  if (!social.length) return list.appendChild(emptyState("social"));
  social.forEach((f) => list.appendChild(socialPost(f, { fresh: S.freshSocial.has(f.key) })));
  if (S.tab === "social" || window.matchMedia("(min-width: 1100px)").matches) setTimeout(() => S.freshSocial.clear(), 4000);
}

function toggleSound() {
  S.sound = !S.sound;
  localStorage.setItem(SOUND_KEY, S.sound ? "on" : "off");
  if (S.sound) chime();
  renderHeader();
}

async function switchRole() {
  const lock = lockedTeam();
  if (!(await confirmDialog(lock ? "Switch role?" : "Switch team or role?", lock ? "You'll pick your role again. Your messages aren't lost." : "You'll pick your team and role again. Your messages aren't lost.", "Switch"))) return;
  S.identity = null;
  saveLocal(ID_KEY, null);
  const u = new URL(location.href);
  u.searchParams.delete("role");
  if (lock) u.searchParams.set("team", lock); // stay on the team link
  else u.searchParams.delete("team");
  history.replaceState(null, "", u.pathname + u.search);
  render();
}

boot();
