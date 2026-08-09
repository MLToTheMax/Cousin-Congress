/**
 * notify.js — per-device notifications of things worth noticing.
 *
 * The chamber is busy: votes open, bills move, the Chair announces, cousins
 * join. This turns that stream of operations into a small, human list of
 * "here's what happened while you were away", kept per device (what you have
 * read is your business, not the chamber's), with an unread count for the bell
 * and an optional nudge through the browser's own notifications.
 *
 * It derives notifications from ops rather than storing them as ops, for two
 * reasons: a notification is a personal, read-once thing that has no business
 * being replicated to everyone, and deriving them means the list is always
 * consistent with the actual record even after a merge reorders history.
 */

const READ_KEY = "cc.notif.read";
const SEEN_KEY = "cc.notif.seen";

/** How each op type becomes a line. Returns null to ignore an op. */
const RULES = {
  "vote.open": (op, s, me) => ({
    icon: "🙋",
    title: "A vote is open",
    body: op.payload.title,
    href: "voting.html",
    forEveryone: true,
  }),
  "vote.close": (op) => ({
    icon: "🔨",
    title: "A vote closed",
    body: `${op.payload.title || "A roll call"} — ${op.payload.result === "passed" ? "agreed to" : "not agreed to"}`,
    href: "results.html",
    forEveryone: true,
  }),
  "bill.upsert": (op, s, me) =>
    op.payload.stage === "introduced"
      ? { icon: "📜", title: "New bill introduced", body: op.payload.title, href: "bills.html", forEveryone: true }
      : null,
  "announce.post": (op) => ({
    icon: op.payload.icon || "📣",
    title: "Announcement",
    body: op.payload.text,
    href: "index.html",
    forEveryone: true,
    important: op.payload.tone === "urgent",
  }),
  "news.post": (op) => ({
    icon: op.payload.memberNote ? "📝" : "📰",
    title: op.payload.memberNote ? "A cousin posted a note" : "Newsroom dispatch",
    body: op.payload.title,
    href: "news.html",
    forEveryone: true,
  }),
  "member.upsert": (op) =>
    op.payload.role
      ? { icon: op.payload.icon || "👋", title: "A new member joined", body: op.payload.name, href: "members.html", forEveryone: true }
      : null,
  "cosponsor.add": (op, s, me) =>
    op.payload.billId
      ? { icon: "✍️", title: "New cosponsor", body: "A bill gained a sign-on", href: "bills.html", forEveryone: false }
      : null,
  "docket.add": (op) => ({
    icon: "📅",
    title: "Added to the docket",
    body: op.payload.title,
    href: "docket.html",
    forEveryone: true,
  }),
  "chat.post": (op, s, me) =>
    op.payload.memberId !== me
      ? { icon: "💬", title: `${op.payload.name || "A cousin"} said`, body: op.payload.text, href: "connect.html#chat", forEveryone: true }
      : null,
  // Personal: you, specifically, were frozen.
  "member.presence": (op, s, me) =>
    op.payload.memberId === me && op.payload.frozen
      ? { icon: "❄️", title: "You've been frozen", body: "Contact the Chair to be let back in.", href: "index.html", forEveryone: false, important: true, personal: true }
      : null,
};

export class Notifier extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.items = [];
    this.readIds = new Set(load(READ_KEY));
    this.seenIds = new Set(load(SEEN_KEY));
    this.webPermission = typeof Notification !== "undefined" ? Notification.permission : "unsupported";
  }

  get unread() {
    return this.items.filter((n) => !this.readIds.has(n.id)).length;
  }

  /** Rebuild the list from the whole log — cheap, and always correct. */
  rebuild() {
    const me = this.store.identity.memberId;
    const state = this.store.state;
    const items = [];

    for (const op of this.store.log.ordered) {
      const rule = RULES[op.type];
      if (!rule) continue;
      let note;
      try {
        note = rule(op, state, me);
      } catch {
        note = null;
      }
      if (!note) continue;
      // Personal notes only for their subject; the rest for everyone seated.
      if (note.personal && op.payload.memberId !== me) continue;
      items.push({
        id: `${op.actor}:${op.seq}`,
        at: hlcTime(op.hlc),
        ...note,
      });
    }

    items.sort((a, b) => b.at - a.at);
    this.items = items.slice(0, 200);
    this.dispatchEvent(new CustomEvent("change", { detail: { unread: this.unread } }));
    return this.items;
  }

  /**
   * Fire browser notifications for anything genuinely new since last time — but
   * never on the first build (that would dump the whole backlog as pop-ups) and
   * only for important items, so the family is nudged, not spammed.
   */
  nudgeNew(firstRun) {
    const fresh = this.items.filter((n) => !this.seenIds.has(n.id));
    for (const n of fresh) this.seenIds.add(n.id);
    save(SEEN_KEY, [...this.seenIds].slice(-500));

    if (firstRun || this.webPermission !== "granted") return;
    for (const n of fresh.filter((x) => x.important).slice(0, 3)) {
      try {
        new Notification(`Cousin Congress — ${n.title}`, { body: n.body, tag: n.id });
      } catch {
        /* notifications are a nicety, never load-bearing */
      }
    }
  }

  async requestWebPermission() {
    if (typeof Notification === "undefined") return "unsupported";
    if (Notification.permission === "default") this.webPermission = await Notification.requestPermission();
    else this.webPermission = Notification.permission;
    return this.webPermission;
  }

  markAllRead() {
    for (const n of this.items) this.readIds.add(n.id);
    save(READ_KEY, [...this.readIds].slice(-1000));
    this.dispatchEvent(new CustomEvent("change", { detail: { unread: 0 } }));
  }

  markRead(id) {
    this.readIds.add(id);
    save(READ_KEY, [...this.readIds].slice(-1000));
    this.dispatchEvent(new CustomEvent("change", { detail: { unread: this.unread } }));
  }
}

/* --- helpers -------------------------------------------------------------- */

const hlcTime = (hlc) => Number(String(hlc || "").split(":")[0]) || 0;

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window — notifications just won't remember across reloads */
  }
}

export default Notifier;
