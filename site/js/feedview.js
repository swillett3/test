// Rendering of the student-facing feed: inbox list, message reader and social timeline.
// Used by the student page and by the "View as student" preview in the console.

import { h, paragraphs } from "./ui.js";
import { fmtClock } from "./model.js";

const KIND_LABEL = {
  email: "Email", voicemail: "Voicemail", audio: "Audio message", video: "Video", news: "News report",
  press: "Press release", phone: "Phone call", article: "Article", social: "Post", text: "Text message", alert: "Alert",
};
const MEDIA_ICON = { image: "🖼", video: "▶", audio: "🔊", link: "🔗" };

export function kindLabel(kind) {
  return KIND_LABEL[kind] || "Message";
}

function senderName(from) {
  const s = String(from || "").trim();
  if (!s) return "Unknown sender";
  return s.split(",")[0].trim();
}

function initials(name) {
  const parts = String(name).replace(/^@/, "").split(/[\s_.-]+/).filter(Boolean);
  return ((parts[0] || "?")[0] + ((parts[1] || "")[0] || "")).toUpperCase();
}

export function attachmentList(media) {
  if (!media || !media.length) return null;
  return h(
    "div",
    { class: "attachments" },
    media.map((m) =>
      h(
        "a",
        { class: "attachment", href: m.url, target: "_blank", rel: "noopener noreferrer" },
        h("span", { class: "attachment__icon", "aria-hidden": "true" }, MEDIA_ICON[m.type] || "🔗"),
        h("span", { class: "attachment__label" }, m.label || "Attachment"),
        h("span", { class: "attachment__hint" }, "Opens in Google Drive ↗"),
      ),
    ),
  );
}

export function inboxRow(item, { unread, selected, onOpen }) {
  const preview = String(item.body || "").replace(/\s+/g, " ").slice(0, 110);
  return h(
    "button",
    {
      type: "button",
      class: "inbox-row" + (unread ? " is-unread" : "") + (selected ? " is-selected" : "") + (item.kind === "phone" ? " is-call" : ""),
      "data-key": item.key,
      "aria-current": selected ? "true" : null,
      onclick: () => onOpen(item.key),
    },
    h(
      "div",
      { class: "inbox-row__top" },
      h("span", { class: "inbox-row__from" }, item.kind === "phone" ? "📞 " + senderName(item.from) : senderName(item.from)),
      h("span", { class: "inbox-row__time" }, fmtClock(item.releasedAt)),
    ),
    h("div", { class: "inbox-row__subject" }, item.subject || kindLabel(item.kind)),
    h("div", { class: "inbox-row__preview" }, preview),
    item.media && item.media.length ? h("span", { class: "inbox-row__clip", title: "Has attachments" }, "📎 " + item.media.length) : null,
  );
}

export function messageView(item, { onBack } = {}) {
  if (!item) {
    return h("div", { class: "reader reader--empty" }, h("p", null, "Select a message to read it."));
  }
  const isCall = item.kind === "phone";
  return h(
    "article",
    { class: "reader" + (isCall ? " reader--call" : ""), "data-key": item.key },
    onBack ? h("button", { type: "button", class: "btn btn--ghost reader__back", onclick: onBack }, "← Inbox") : null,
    h("div", { class: "reader__kind" }, isCall ? "📞 Incoming call" : kindLabel(item.kind)),
    h("h2", { class: "reader__subject" }, item.subject || kindLabel(item.kind)),
    h(
      "dl",
      { class: "reader__meta" },
      h("dt", null, "From"),
      h("dd", null, item.from || "—"),
      item.to ? [h("dt", null, "To"), h("dd", null, item.to)] : null,
      h("dt", null, "Received"),
      h("dd", null, fmtClock(item.releasedAt)),
    ),
    paragraphs(item.body),
    attachmentList(item.media),
  );
}

export function socialPost(item, { fresh } = {}) {
  const name = item.from || "@someone";
  return h(
    "article",
    { class: "post" + (fresh ? " is-fresh" : ""), "data-key": item.key },
    h("div", { class: "post__avatar", "aria-hidden": "true" }, initials(name)),
    h(
      "div",
      { class: "post__main" },
      h("div", { class: "post__head" }, h("span", { class: "post__handle" }, name), h("span", { class: "post__time" }, fmtClock(item.releasedAt))),
      item.body ? paragraphs(item.body) : null,
      attachmentList(item.media),
    ),
  );
}
