// Tiny DOM helpers. Every piece of data is inserted as text, never as HTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Append children (arrays flattened, null/false skipped). Returns el. */
export function add(el, ...children) {
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;

/** Text with clickable https links, as DOM nodes. */
export function linkified(text) {
  const frag = document.createDocumentFragment();
  const s = String(text || "");
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
    frag.appendChild(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer" }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
  return frag;
}

/** Body text as paragraphs (blank line = new paragraph, single newline = line break). */
export function paragraphs(text) {
  const wrap = h("div", { class: "prose" });
  const blocks = String(text || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const b of blocks) {
    if (!b.trim()) continue;
    const p = h("p");
    b.split("\n").forEach((line, i) => {
      if (i) p.appendChild(h("br"));
      p.appendChild(linkified(line));
    });
    wrap.appendChild(p);
  }
  return wrap;
}

export function toast(message, opts = {}) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts", class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  const t = h("div", { class: "toast" + (opts.tone ? " toast--" + opts.tone : "") }, message);
  if (opts.onClick) {
    t.classList.add("toast--click");
    t.addEventListener("click", () => {
      opts.onClick();
      t.remove();
    });
  }
  host.appendChild(t);
  setTimeout(() => t.classList.add("toast--out"), opts.ms || 5000);
  setTimeout(() => t.remove(), (opts.ms || 5000) + 400);
  return t;
}

/** A modal dialog. Resolves with the value of the clicked button (or null). */
export function dialog({ title, body, buttons }) {
  return new Promise((resolve) => {
    const close = (v) => {
      back.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
    };
    const panel = h(
      "div",
      { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("h2", { class: "dialog__title" }, title),
      body ? h("div", { class: "dialog__body" }, body) : null,
      h(
        "div",
        { class: "dialog__actions" },
        (buttons || [{ label: "OK", value: true, primary: true }]).map((b) =>
          h("button", { class: "btn" + (b.primary ? " btn--primary" : "") + (b.danger ? " btn--danger" : ""), type: "button", "data-value": String(b.value), onclick: () => close(b.value) }, b.label),
        ),
      ),
    );
    const back = h("div", { class: "dialog-back", onclick: (e) => e.target === back && close(null) }, panel);
    document.body.appendChild(back);
    document.addEventListener("keydown", onKey);
    const primary = panel.querySelector(".btn--primary");
    (primary || panel.querySelector("button")).focus();
  });
}

export function confirmDialog(title, text, okLabel = "OK", danger = false) {
  return dialog({
    title,
    body: h("p", null, text),
    buttons: [
      { label: "Cancel", value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
  });
}

export function download(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

let audioCtx = null;
export function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.15, now + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + i * 0.12);
      o.stop(now + i * 0.12 + 0.3);
    });
  } catch {
    /* sound is optional */
  }
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}
