import { loadBackend, resilientWatch } from "./store.js";
import { h, add, clear, toast, chime, confirmDialog, qs } from "./ui.js";
import { isForViewer, feedList, fmtClock, buildResponse, RESPONSE_KINDS, DEFAULT_ROLES, LIMITS } from "./model.js";
import { inboxRow, messageView, socialPost, kindLabel } from "./feedview.js";

const ID_KEY = "csim-identity";
const SOUND_KEY = "csim-sound";

const S = {
  backend: null,
  user: null,
  authError: null,
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
  sent: [],
  sound: localStorage.getItem(SOUND_KEY) !== "off",
  built: false,
  join: { team: null, role: null, name: "" }, // picks on the join screen, kept across re-renders
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
  try {
    S.backend = await loadBackend();
  } catch (e) {
    console.error(e);
    return bootMessage("Couldn't load the simulation. Check your internet connection and reload the page.");
  }
  if (!S.backend) return bootMessage("This site hasn't been connected to its database yet. If you're the facilitator, see the setup guide.");
  if (S.backend.kind === "mock") document.body.classList.add("is-mock");

  S.backend.onAuth((u) => {
    S.user = u;
    if (S.built) renderRespondStatus();
  });
  S.backend.signInStudent().catch((e) => {
    console.error(e);
    S.authError = e;
    if (S.built) renderRespondStatus();
  });

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

function resolveIdentity() {
  if (!S.config) return;
  let id = S.identity || loadLocal(ID_KEY, null);
  const urlTeam = qs("team"), urlRole = qs("role");
  if (urlTeam && urlRole) id = { ...(id || {}), team: urlTeam, role: urlRole.toUpperCase() };
  if (id && teamInfo(id.team) && roles().some((r) => r.code === id.role)) {
    if (!S.identity || S.identity.team !== id.team || S.identity.role !== id.role) setIdentity(id);
  } else if (S.identity && (!teamInfo(S.identity.team) || !roles().some((r) => r.code === S.identity.role))) {
    S.identity = null; // team was removed by the facilitators
    S.built = false;
  }
}

function setIdentity(id) {
  S.identity = { team: String(id.team), role: id.role, name: id.name || "" };
  saveLocal(ID_KEY, S.identity);
  S.read = new Set(loadLocal("csim-read:" + idKey(), []));
  S.sent = loadLocal("csim-sent:" + idKey(), []);
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
  renderRespondOptions();
  renderTabs();
}

function renderJoin() {
  S.built = false;
  const t = teams();
  // Redraw only when something on this screen changed, so a release or other update doesn't wipe a half-filled form.
  const sig = JSON.stringify([t, roles().map((r) => [r.code, r.character, r.title]), S.config && S.config.title, S.config && S.config.company]);
  if (S.joinSig === sig && $("app").querySelector(".join")) return;
  S.joinSig = sig;
  const app = clear($("app"));
  const J = S.join;
  if (J.team && !t.some((tm) => String(tm.id) === J.team)) J.team = null;
  if (J.role && !roles().some((r) => r.code === J.role)) J.role = null;
  const nameInput = h("input", { type: "text", id: "join-name", maxlength: "80", placeholder: "Optional — helps facilitators know who replied", autocomplete: "name", value: J.name, oninput: (e) => (J.name = e.target.value) });
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
                setIdentity({ team: J.team, role: J.role, name: nameInput.value.trim() });
                S.join = { team: null, role: null, name: J.name };
                render();
              },
            },
            h("h2", null, "1. Your team"),
            h(
              "div",
              { class: "choice-grid choice-grid--teams" },
              t.map((tm) =>
                h("button", { type: "button", class: "choice", "data-team": String(tm.id), "aria-pressed": "false", onclick: () => { J.team = String(tm.id); update(); } }, tm.name || "Team " + tm.id),
              ),
            ),
            h("h2", null, "2. Your role"),
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
            h("label", { class: "field", for: "join-name" }, h("span", { class: "field__label" }, "3. Your name"), nameInput),
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
          h("button", { type: "button", class: "btn btn--primary btn--sm desktop-only", id: "respond-open", onclick: () => setRespondOpen(true) }, "Send a response"),
          h("button", { type: "button", class: "btn btn--ghost btn--sm", id: "switch", onclick: switchRole }, "Switch role"),
        ),
      ),
      h(
        "nav",
        { class: "tabs", id: "tabs" },
        tabBtn("inbox", "Inbox"),
        tabBtn("social", "Social"),
        tabBtn("respond", "Respond"),
      ),
      h(
        "main",
        { class: "panes" },
        h("section", { class: "pane pane--inbox", "aria-label": "Inbox" }, h("div", { class: "pane__head" }, h("h2", null, "Inbox"), h("span", { class: "count", id: "inbox-count" })), h("div", { class: "inbox-list", id: "inbox-list" })),
        h("section", { class: "pane pane--reader", id: "reader", "aria-label": "Message" }),
        h("section", { class: "pane pane--social", "aria-label": "Social media" }, h("div", { class: "pane__head" }, h("h2", null, "Social & news feed"), h("span", { class: "live-dot" }, "live")), h("div", { class: "social-list", id: "social-list" })),
        h("section", { class: "pane pane--respond", id: "respond", "aria-label": "Send a response" }, buildRespond()),
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

// ---------- respond ----------

function buildRespond() {
  const kind = h("select", { id: "r-kind", class: "input" }, RESPONSE_KINDS.map((k) => h("option", { value: k.code }, k.label)));
  const replyTo = h("select", { id: "r-reply", class: "input" });
  const text = h("textarea", { id: "r-text", class: "input", rows: "7", maxlength: String(LIMITS.text), placeholder: "Write what you would post, say or decide. Facilitators see it immediately." });
  const counter = h("span", { class: "field__hint", id: "r-count" }, `0 / ${LIMITS.text}`);
  text.addEventListener("input", () => (counter.textContent = `${text.value.length} / ${LIMITS.text}`));
  const send = h("button", { type: "submit", class: "btn btn--primary", id: "r-send" }, "Send to facilitators");
  const form = h(
    "form",
    { class: "respond", id: "respond-form", onsubmit: onSend },
    h("div", { class: "respond__head" }, h("h2", null, "Send a response"), h("button", { type: "button", class: "btn btn--ghost btn--sm desktop-only", onclick: () => setRespondOpen(false), "aria-label": "Close" }, "✕")),
    h("p", { class: "respond__intro" }, "Use this for anything you'd send outside the leadership team: a public post, a statement, a reply. Deliverables (board deck, video, press statement) still go to bCourses."),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "What is this?"), kind),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "In reply to"), replyTo),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your response"), text, counter),
    h("div", { class: "respond__status", id: "r-status", role: "status" }),
    send,
    h("h3", { class: "respond__sent-title" }, "Sent from this device"),
    h("ul", { class: "sent-list", id: "sent-list" }),
  );
  return form;
}

function renderRespondOptions() {
  const sel = $("r-reply");
  if (!sel) return;
  const cur = sel.value;
  const { inbox, social } = myItems();
  clear(sel).appendChild(h("option", { value: "" }, "Nothing specific"));
  const og1 = h("optgroup", { label: "Inbox" }, inbox.slice(0, 40).map((f) => h("option", { value: f.key }, `${fmtClock(f.releasedAt)} · ${f.subject || f.from}`.slice(0, 90))));
  const og2 = h("optgroup", { label: "Social posts" }, social.slice(0, 40).map((f) => h("option", { value: f.key }, `${f.from}: ${String(f.body).slice(0, 60)}`)));
  if (inbox.length) sel.appendChild(og1);
  if (social.length) sel.appendChild(og2);
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  renderSent();
  renderRespondStatus();
}

function renderSent() {
  const ul = $("sent-list");
  if (!ul) return;
  clear(ul);
  if (!S.sent.length) return ul.appendChild(h("li", { class: "empty" }, "Nothing sent yet."));
  S.sent.slice(0, 20).forEach((s) =>
    ul.appendChild(h("li", { class: "sent" }, h("span", { class: "sent__time" }, fmtClock(s.at) + " · " + ((RESPONSE_KINDS.find((k) => k.code === s.kind) || {}).label || s.kind)), h("span", { class: "sent__text" }, s.text))),
  );
}

function renderRespondStatus() {
  const st = $("r-status");
  const btn = $("r-send");
  if (!st || !btn) return;
  if (S.authError && !S.user) {
    st.textContent = "Can't send responses right now (sign-in failed). Tell a facilitator; you can still read messages.";
    st.className = "respond__status is-error";
    btn.disabled = true;
  } else if (!S.user) {
    st.textContent = "Connecting…";
    st.className = "respond__status";
    btn.disabled = true;
  } else if (!st.dataset.sticky) {
    st.textContent = "";
    st.className = "respond__status";
    btn.disabled = false;
  } else btn.disabled = false;
}

async function onSend(e) {
  e.preventDefault();
  const st = $("r-status");
  const btn = $("r-send");
  const text = $("r-text");
  let r;
  try {
    r = buildResponse({
      team: S.identity.team,
      role: S.identity.role,
      kind: $("r-kind").value,
      text: text.value,
      replyTo: $("r-reply").value,
      name: S.identity.name,
      uid: S.user && S.user.uid,
    });
  } catch (err) {
    st.textContent = err.message;
    st.className = "respond__status is-error";
    return;
  }
  btn.disabled = true;
  st.textContent = "Sending…";
  st.className = "respond__status";
  try {
    await S.backend.submitResponse(r);
    S.sent.unshift({ at: Date.now(), kind: r.kind, text: r.text });
    S.sent = S.sent.slice(0, 50);
    saveLocal("csim-sent:" + idKey(), S.sent);
    text.value = "";
    $("r-count").textContent = `0 / ${LIMITS.text}`;
    st.textContent = `Sent at ${fmtClock(Date.now())}. Facilitators can see it now.`;
    st.className = "respond__status is-ok";
    st.dataset.sticky = "1";
    setTimeout(() => {
      delete st.dataset.sticky;
    }, 6000);
    renderSent();
  } catch (err) {
    console.error(err);
    st.textContent = "That didn't send. Check your connection and try again — your text is still here.";
    st.className = "respond__status is-error";
  } finally {
    btn.disabled = !S.user;
  }
}

function setRespondOpen(open) {
  const ws = $("ws");
  if (!ws) return;
  ws.dataset.respond = open ? "open" : "closed";
  if (open) setTimeout(() => $("r-text") && $("r-text").focus(), 50);
}

function toggleSound() {
  S.sound = !S.sound;
  localStorage.setItem(SOUND_KEY, S.sound ? "on" : "off");
  if (S.sound) chime();
  renderHeader();
}

async function switchRole() {
  if (!(await confirmDialog("Switch team or role?", "You'll pick your team and role again. Your messages aren't lost.", "Switch"))) return;
  S.identity = null;
  saveLocal(ID_KEY, null);
  const u = new URL(location.href);
  u.searchParams.delete("team");
  u.searchParams.delete("role");
  history.replaceState(null, "", u.pathname + u.search);
  render();
}

boot();
