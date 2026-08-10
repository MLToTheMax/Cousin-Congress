/**
 * actions.js — every write in the building.
 *
 * All handlers are delegated from the document, so a region can be re-rendered
 * as often as it likes without rebinding anything. Each handler does the same
 * three things in the same order: append an op locally, tell the member it
 * landed, and let sync.js worry about the network. None of them await a
 * server, and none of them fail if there isn't one.
 */

import CONFIG from "./config.js";
import { select } from "./crdt.js";
import { copyText, download, qs, qsa, toast } from "./ui.js";
import { changeChairPin, claimSeat, requireChair } from "./auth.js";
import { iconFingerprint } from "./icons.js";

const newId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Resolve one shareable item (news / bill / docket) to its display record. */
function findShareItem(state, type, id) {
  if (type === "bill") return select.bill(state, id);
  const table = { news: state.news, docket: state.docket }[type];
  const record = table?.[id];
  return record && !record._deleted ? record : null;
}

/**
 * Show a member's seat code as a scannable QR the Chair can hold up, print, or
 * screenshot into a chat. The QR carries an absolute URL, so a phone's ordinary
 * camera opens the site AND seats the cousin in one scan.
 */
async function showSeatCode(store, ctx, member) {
  const [{ makeSeatCode }, { encodeQR, qrToSvg }, { showDialog }] = await Promise.all([
    import("./seatcode.js"),
    import("./qr.js"),
    import("./ui.js"),
  ]);
  const { url } = makeSeatCode({
    room: CONFIG.room,
    memberId: member.id,
    name: member.name,
    icon: member.icon,
    roomSecret: ctx?.sync?.currentRoomSecret,
  });
  const svg = qrToSvg(encodeQR(url, { ecl: "M" }), { margin: 3 });
  await showDialog({
    icon: member.icon || "🪑",
    title: `${member.name}'s sign-in code`,
    hint: "Let them scan this with any phone camera — it opens the chamber and seats them. The first device to scan it takes the seat.",
    bodyHtml: `<div class="seat-qr">${svg}</div>`,
    copyText: url,
    confirmLabel: "Done",
  });
}

const OUTBOX_KEY = "cc.outbox";

/* --------------------------------------------------------------------------
   Private messages — these are the one thing that is NOT replicated.
   Constituent mail belongs to the office, not to every cousin's browser, so
   it goes to the Worker or waits in a local outbox until one exists.
   -------------------------------------------------------------------------- */

const readOutbox = () => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
  } catch {
    return [];
  }
};

const writeOutbox = (items) => {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-50)));
  } catch {
    /* storage full — the toast below is the user-visible signal */
  }
};

async function postPrivate(path, body) {
  if (!CONFIG.apiBase) throw new Error("no-server");
  const res = await fetch(`${CONFIG.apiBase.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function sendOrQueue(path, body, { queuedMessage, sentMessage }) {
  try {
    await postPrivate(path, body);
    toast(sentMessage);
    return true;
  } catch {
    if (!CONFIG.features.offlineQueue) {
      toast("The clerk's office is unreachable right now.", "err");
      return false;
    }
    writeOutbox([...readOutbox(), { path, body, queuedAt: Date.now() }]);
    toast(queuedMessage, "warn");
    return false;
  }
}

/** Retry anything that was queued while the office was closed. */
export async function drainOutbox() {
  if (!CONFIG.apiBase) return;
  const queued = readOutbox();
  if (!queued.length) return;

  const stuck = [];
  for (const item of queued) {
    try {
      await postPrivate(item.path, item.body);
    } catch {
      stuck.push(item);
    }
  }
  writeOutbox(stuck);
  const delivered = queued.length - stuck.length;
  if (delivered > 0) toast(`Delivered ${delivered} queued message${delivered === 1 ? "" : "s"}.`);
}

/* --------------------------------------------------------------------------
   Guards
   -------------------------------------------------------------------------- */

function requireSeat(store) {
  if (store.identity.memberId) return store.identity.memberId;
  toast("Take your seat on the Members page first — then the chamber knows who you are. 🪑", "warn");
  return null;
}

const formValues = (form) => Object.fromEntries(new FormData(form).entries());

/* ==========================================================================
   Click actions
   ========================================================================== */

const CLICK_ACTIONS = {
  /** Sign this device's member on as a cosponsor. Idempotent by construction. */
  cosponsor(store, el) {
    const memberId = requireSeat(store);
    if (!memberId) return;
    const billId = el.dataset.bill;
    const already = store.state.cosponsors[`${billId}::${memberId}`]?.signed;
    store.dispatch(already ? "cosponsor.remove" : "cosponsor.add", { billId, memberId });
    toast(already ? "Sign-on withdrawn." : "Sign-on recorded.");
  },

  /** Bind this browser to a seat — password-checked against the synced hash. */
  async "claim-seat"(store, el) {
    await claimSeat(el.dataset.member);
  },

  "release-seat"(store) {
    store.setIdentity({ memberId: null, displayName: "" });
    toast("Seat released — this device is a visitor in the gallery now. 👋");
  },

  /** Presence beacon straight from the header. */
  "check-in"(store, el) {
    const memberId = requireSeat(store);
    if (!memberId) return;
    const presence = el.dataset.presence || "present";
    store.dispatch("member.presence", {
      memberId,
      presence,
      location: el.dataset.location || undefined,
      checkedInAt: new Date().toISOString(),
    });
    toast(`Checked in as ${presence}.`);
  },

  "toggle-dnd"(store) {
    const memberId = requireSeat(store);
    if (!memberId) return;
    const current = select.member(store.state, memberId)?.dnd;
    store.dispatch("member.presence", { memberId, dnd: !current });
    toast(current ? "Do-not-disturb cleared." : "Do-not-disturb set.");
  },

  /** Close a motion and freeze its result into the log. Chair only. */
  async "close-vote"(store, el) {
    if (!(await requireChair())) return;
    const voteId = el.dataset.vote;
    const tally = select.tally(store.state, voteId);
    store.dispatch("vote.close", {
      id: voteId,
      result: tally.passing ? "passed" : "failed",
      closedAt: new Date().toISOString(),
      finalTally: { yea: tally.yea, nay: tally.nay, present: tally.present },
    });
    toast(`🔨 Bang! Roll call closed — ${tally.passing ? "agreed to" : "not agreed to"}.`);
  },

  /** Move a bill one stop down the pipeline. Chair only. */
  async "advance-stage"(store, el) {
    if (!(await requireChair())) return;
    const stages = ["drafted", "introduced", "committee", "floor", "enacted"];
    const bill = select.bill(store.state, el.dataset.bill);
    if (!bill) return;
    const next = stages[Math.min(stages.indexOf(bill.stage || "drafted") + 1, stages.length - 1)];
    if (next === bill.stage) return;
    store.dispatch("bill.stage", { billId: bill.id, stage: next });
    toast(next === "enacted" ? "🎉 Enacted! It's family law now." : `Bill moved along: now ${next}.`);
  },

  "member-detail"(store, el) {
    const member = select.member(store.state, el.dataset.member);
    if (member) toast(`${member.icon || "🪑"} ${member.name} — ${member.location || "location not set"}`);
  },

  /* --- the Chair's office ------------------------------------------------- */

  /** Clear a member's password so they can invent a new one. Chair only. */
  async "reset-pin"(store, el) {
    if (!(await requireChair())) return;
    const member = select.member(store.state, el.dataset.member);
    if (!member) return;
    store.dispatch("member.auth", { memberId: member.id, auth: null });
    toast(`${member.name}'s password is cleared — they'll pick a fresh one next time they sit down.`);
  },

  /** Retire a member from the roster. Chair only, two-tap confirm. */
  async "remove-member"(store, el) {
    if (el.dataset.confirmed !== "true") {
      el.dataset.confirmed = "true";
      el.textContent = "Really retire them?";
      setTimeout(() => {
        el.dataset.confirmed = "false";
        el.textContent = "Retire";
      }, 5000);
      return;
    }
    if (!(await requireChair())) return;
    const member = select.member(store.state, el.dataset.member);
    if (!member) return;
    store.dispatch("member.retract", { id: member.id });
    if (store.identity.memberId === member.id) {
      store.setIdentity({ memberId: null, displayName: "" });
    }
    toast(`${member.name} has been retired from the roster with full honours.`);
  },

  async "chair-pin"() {
    await changeChairPin();
  },

  /** Chair-controlled toggles for the whole chamber. */
  async "toggle-lock"(store) {
    if (!(await requireChair())) return;
    const locked = !store.state.session?.locked;
    store.dispatch("session.set", { locked });
    toast(locked ? "🔒 Chamber locked — no new devices can join." : "🔓 Chamber open to new devices.");
  },

  async "toggle-stun"(store) {
    if (!(await requireChair())) return;
    const off = store.state.session?.stun === false;
    store.dispatch("session.set", { stun: off ? true : false });
    toast(off ? "🌐 STUN on — cousins on other networks can connect." : "🏠 STUN off — local network only, no outside servers.");
  },

  async "chat-policy"(store) {
    if (!(await requireChair())) return;
    const current = store.state.session?.chatPolicy || "chair-picks";
    const next = current === "all" ? "chair-picks" : "all";
    store.dispatch("session.set", { chatPolicy: next });
    toast(next === "all" ? "💬 Chat open to everyone." : "💬 Chat is now Chair-picks only.");
  },

  async "toggle-chat"(store, el) {
    if (!(await requireChair())) return;
    const member = select.member(store.state, el.dataset.member);
    if (!member) return;
    store.dispatch("member.presence", { memberId: member.id, canChat: !member.canChat });
    toast(member.canChat ? `Chat off for ${member.name}.` : `💬 Chat on for ${member.name}.`);
  },

  /** Copy a static, offline read-link for one item (news/bill/docket). */
  async "share-item"(store, el) {
    const { createShareLink } = await import("./share.js");
    const { type, id } = el.dataset;
    const record = findShareItem(store.state, type, id);
    if (!record) return toast("Couldn't find that to share.", "err");
    const withNames =
      type === "bill" ? { ...record, sponsorName: select.member(store.state, record.sponsor)?.name } : record;
    const link = await createShareLink(type, withNames);
    await copyText(link, "Read-only link copied — it unlocks just this one item.");
  },

  /** Mint a LIVE scoped guest link (revocable, connects through the mesh). */
  async "share-live"(store, el, ctx) {
    const memberId = requireSeat(store);
    if (!memberId) return;
    try {
      const { code } = await ctx.sync.createGuestShare(el.dataset.type, el.dataset.id);
      await copyText(code, "Live guest code copied. They can read only this — revoke any time from the Chair's dashboard.");
    } catch (error) {
      toast(String(error.message || error), "err");
    }
  },

  async "revoke-share"(store, el, ctx) {
    if (el.dataset.mine !== "true" && !(await requireChair())) return;
    ctx.sync.revokeShare(el.dataset.share);
    toast("Access revoked — their screen has been cleared.");
  },

  /**
   * Show the login QR for one member. Scanning it seats that cousin on the
   * scanning device (and prompts for a password the first time), so a young
   * cousin never has to find themselves in a list or type anything.
   */
  async "seat-qr"(store, el, ctx) {
    if (!(await requireChair())) return;
    const member = select.member(store.state, el.dataset.member);
    if (!member) return;
    await showSeatCode(store, ctx, member);
  },

  /**
   * Found a brand-new chamber, and become its Chair.
   *
   * Deliberately only offered to a device that has never joined anything and has
   * nothing of its own: founding a chamber on top of an existing record would
   * either fork it or throw it away, and neither is something to do behind one
   * link. Everything the demo shipped with is cleared, so the family starts on a
   * blank record rather than deleting sample cousins one at a time.
   *
   * The gavel is bound to the founder's SEAT, not to a shared password: once
   * they have signed in as themselves, chair actions just work. The password
   * still exists so another device can take the gavel if it has to.
   */
  async "register-chair"(store, el, ctx) {
    const { registerChair } = await import("./founding.js");
    await registerChair(store, ctx?.sync);
  },

  /** Chair bars a device from the chamber — everywhere, not just here. */
  async "revoke-device"(store, el, ctx) {
    if (!(await requireChair())) return;
    const kid = el.dataset.kid;
    store.dispatch("device.revoke", { kid });
    ctx.sync?.peers?.dropByFingerprint?.(kid);
    toast("Device barred and disconnected. It can't rejoin from anywhere.");
  },

  /** Chair lets a barred device back in. */
  async "unrevoke-device"(store, el) {
    if (!(await requireChair())) return;
    store.dispatch("device.seen", { kid: el.dataset.kid, revoked: false });
    toast("Device allowed again.");
  },

  /** Chair approves a device asking to hold the gavel. */
  async "approve-chair"(store, el) {
    if (!(await requireChair())) return;
    store.dispatch("chair.enroll", { kid: el.dataset.kid, actor: el.dataset.actor || undefined });
    toast("✅ Approved — that device now holds the gavel too.");
  },

  /** Chair approves a device asking to be enrolled onto a seat. */
  async "approve-seat"(store, el) {
    if (!(await requireChair())) return;
    const member = select.member(store.state, el.dataset.member);
    store.dispatch("member.enrollKey", { memberId: el.dataset.member, kid: el.dataset.kid });
    toast(`✅ Approved — that device can now vote as ${member?.name || "that seat"}.`);
  },

  /** Chair clears a seat's registered devices so a new one can re-claim it.
   *  This is the recovery path for a lost, replaced, or shared device. */
  async "reset-seat"(store, el) {
    if (el.dataset.confirmed !== "true") {
      el.dataset.confirmed = "true";
      el.textContent = "Really unregister their devices?";
      setTimeout(() => {
        el.dataset.confirmed = "false";
        el.textContent = "Reset devices";
      }, 5000);
      return;
    }
    if (!(await requireChair())) return;
    const member = select.member(store.state, el.dataset.member);
    if (!member) return;
    store.dispatch("member.resetKeys", { memberId: member.id });
    toast(`${member.name}'s devices are cleared — the next device to enter their password takes the seat.`);
  },

  /** Chair verdict on a watchdog flag — teaches the classifier. */
  "watchdog-verdict"(store, el, ctx) {
    ctx.sync.__watchdog?.update({ fingerprint: el.dataset.fp, ip: el.dataset.ip }, el.dataset.verdict);
    toast(el.dataset.verdict === "fine" ? "Marked as fine — noted." : "Marked as suspicious — watching closer.");
    el.closest("[data-flag]")?.remove();
  },

  /** Chair toggles the chamber's walkie-talkie policy between everyone and picked. */
  async "talkie-policy"(store, el) {
    if (!(await requireChair())) return;
    const current = store.state.session?.talkiePolicy || "all";
    const next = current === "all" ? "chair-picks" : "all";
    store.dispatch("session.set", { talkiePolicy: next });
    toast(next === "all" ? "📻 Everyone may use the talkie." : "📻 Only cousins you pick may use the talkie.");
  },

  /** Chair freezes (isolates) or thaws a member. Frozen members stay connected
   *  but can do nothing until the Chair releases them. */
  async "toggle-freeze"(store, el) {
    if (!(await requireChair())) return;
    const memberId = el.dataset.member;
    const member = select.member(store.state, memberId);
    if (!member) return;
    store.dispatch("member.presence", {
      memberId,
      frozen: !member.frozen,
      frozenBy: member.frozen ? null : store.identity.displayName || "the Chair",
    });
    toast(member.frozen ? `${member.name} is un-frozen.` : `❄️ ${member.name} is frozen — they must contact you.`);
  },

  /** Chair drops a live peer connection outright. */
  async "disconnect-peer"(store, el, ctx) {
    if (!(await requireChair())) return;
    ctx.sync.peers?.disconnectPeer(el.dataset.peer);
    toast("Connection dropped.");
  },

  /** Chair isolates a live connection locally: it stays open, but no data
   *  crosses it until released. */
  async "isolate-peer"(store, el, ctx) {
    if (!(await requireChair())) return;
    const on = ctx.sync.peers?.togglePeerIsolation(el.dataset.peer);
    toast(on ? "🔇 Connection isolated — no data flows." : "Connection released.");
  },

  /** Chair grants or removes one member's talkie permission. */
  async "toggle-talk"(store, el) {
    if (!(await requireChair())) return;
    const memberId = el.dataset.member;
    const member = select.member(store.state, memberId);
    if (!member) return;
    store.dispatch("member.presence", { memberId, canTalk: !member.canTalk });
    toast(member.canTalk ? `Talkie taken from ${member.name}.` : `Talkie given to ${member.name}. 📻`);
  },

  /**
   * Retire every entity the shipped demo snapshot created. Tombstones rather
   * than deletions, so the clearing itself replicates to cousins who are
   * offline right now instead of quietly coming back when they reconnect.
   */
  async "clear-demo"(store, el) {
    if (el.dataset.confirmed !== "true") {
      el.dataset.confirmed = "true";
      el.textContent = "Really clear the example data?";
      setTimeout(() => {
        el.dataset.confirmed = "false";
        el.textContent = "Clear the example data";
      }, 5000);
      return;
    }
    if (!(await requireChair())) return;

    const state = store.state;
    const RETRACTIONS = [
      ["members", "member.retract"],
      ["votes", "vote.retract"],
      ["bills", "bill.retract"],
      ["news", "news.retract"],
      ["docket", "docket.remove"],
      ["statuses", "status.retract"],
      ["comments", "comment.retract"],
      ["amendments", "amendment.withdraw"],
    ];

    let cleared = 0;
    for (const [table, opType] of RETRACTIONS) {
      for (const record of Object.values(state[table] || {})) {
        if (!record?.demo || record._deleted) continue;
        store.dispatch(opType, { id: record.id });
        cleared += 1;
      }
    }
    // Ballots and cosponsors hang off retracted parents, so they fall out of
    // every selector on their own once the parent carries a tombstone.
    store.dispatch("session.set", { demo: false, sitting: 1 });

    if (store.identity.memberId?.startsWith("m-demo-")) {
      store.setIdentity({ memberId: null, displayName: "" });
    }
    toast(
      cleared
        ? `Cleared ${cleared} example ${cleared === 1 ? "entry" : "entries"}. The chamber is yours now.`
        : "There was no example data left to clear."
    );
  },

  copy(store, el) {
    const source = qs(el.dataset.copyFrom);
    if (source) copyText(source.value ?? source.textContent ?? "");
  },

  /* --- replication console ---------------------------------------------- */

  async "create-invite"(store, el, ctx) {
    const output = qs("#invite-code");
    const wrap = qs("#invite-out");
    el.disabled = true;
    el.textContent = "Drawing your picture code…";
    try {
      const { code } = await ctx.sync.createInvite();
      output.value = code;
      const badge = qs("#invite-badge");
      if (badge) badge.textContent = await iconFingerprint(code);
      wrap.hidden = false;
      toast("Picture code ready! Send it to your cousin, then paste their reply below.");
    } catch (error) {
      toast(String(error.message || error), "err");
    } finally {
      el.disabled = false;
      el.textContent = "Make a picture code";
    }
  },

  async "accept-invite"(store, el, ctx) {
    const input = qs("#join-code");
    const output = qs("#answer-code");
    const wrap = qs("#answer-out");
    if (!input?.value.trim()) return toast("Paste your cousin's picture code first.", "warn");
    el.disabled = true;
    try {
      const joinBadge = qs("#join-badge");
      if (joinBadge) joinBadge.textContent = await iconFingerprint(input.value.trim());
      output.value = (await ctx.sync.acceptInvite(input.value)).code;
      const badge = qs("#answer-badge");
      if (badge) badge.textContent = await iconFingerprint(output.value);
      wrap.hidden = false;
      toast("Reply code ready! Send it back the same way.");
    } catch (error) {
      toast(String(error.message || error), "err");
    } finally {
      el.disabled = false;
    }
  },

  async "complete-invite"(store, el, ctx) {
    const input = qs("#answer-in");
    if (!input?.value.trim()) return toast("Paste the reply code first.", "warn");
    el.disabled = true;
    try {
      await ctx.sync.completeInvite(input.value);
      toast("Paired! 🎉 Your two chambers are trading everything they know.");
      input.value = "";
    } catch (error) {
      toast(String(error.message || error), "err");
    } finally {
      el.disabled = false;
    }
  },

  "export-log"(store) {
    download(`cousin-congress-${new Date().toISOString().slice(0, 10)}.json`, store.exportLog());
    toast("Log exported. That file alone can rebuild the whole chamber.");
  },

  "import-log"() {
    qs("#import-file")?.click();
  },

  "force-sweep"(store, el, ctx) {
    ctx.sync.sweep();
    toast("Digest broadcast — peers will backfill anything missing.");
  },

  async "reset-replica"(store, el) {
    if (el.dataset.confirmed !== "true") {
      el.dataset.confirmed = "true";
      el.textContent = "Really erase this device?";
      setTimeout(() => {
        el.dataset.confirmed = "false";
        el.textContent = "Erase this device";
      }, 5000);
      return;
    }
    await store.reset();
  },
};

/* ==========================================================================
   Form actions
   ========================================================================== */

const FORM_ACTIONS = {
  "post-status"(store, form, values) {
    const memberId = store.identity.memberId || values.memberId;
    if (!memberId) {
      toast("Claim your seat first so the chamber knows who is speaking.", "warn");
      return false;
    }
    store.dispatch("status.post", {
      id: newId("status"),
      memberId,
      text: values.text,
      location: values.location || undefined,
    });
    if (values.presence) {
      store.dispatch("member.presence", {
        memberId,
        presence: values.presence,
        location: values.location || undefined,
      });
    }
    toast("Status posted to the floor.");
    return true;
  },

  "submit-bill"(store, form, values) {
    const memberId = requireSeat(store);
    if (!memberId) return false;
    const id = newId("bill");
    store.dispatch("bill.upsert", {
      id,
      number: values.number || `H.CC. ${Math.floor(100 + Math.random() * 900)}`,
      title: values.title,
      summary: values.summary,
      text: values.text,
      committee: values.committee || undefined,
      sponsor: memberId,
      stage: "introduced",
      introduced: new Date().toISOString(),
    });
    store.dispatch("cosponsor.add", { billId: id, memberId });
    localStorage.removeItem("cc.draft");
    toast("Bill introduced and entered on the calendar.");
    return true;
  },

  "file-amendment"(store, form, values) {
    const memberId = requireSeat(store);
    if (!memberId) return false;
    store.dispatch("amendment.file", {
      id: newId("amdt"),
      billId: form.dataset.bill,
      author: memberId,
      number: `Amdt. ${Math.floor(10 + Math.random() * 90)}`,
      text: values.text,
      filed: new Date().toISOString(),
    });
    toast("Amendment filed.");
    return true;
  },

  comment(store, form, values) {
    store.dispatch("comment.post", {
      id: newId("cmt"),
      targetId: form.dataset.target,
      targetType: form.dataset.targetType || "bill",
      author: values.author,
      stance: values.stance,
      body: values.body,
    });
    toast("Comment added to the public record.");
    return true;
  },

  /**
   * Enroll a new cousin. Chair only. The Chair can set each moderatable
   * feature at creation time, and the last choices are remembered on the
   * session so the next new member inherits them — set your policy once.
   */
  async "add-member"(store, form, values, ctx) {
    if (!(await requireChair())) return false;
    const name = String(values.name || "").trim();
    if (!name) return false;
    const count = select.members(store.state).length;

    const canChat = values.canChat === "on";
    const canTalk = values.canTalk !== undefined ? values.canTalk === "on" : true;

    const memberId = newId("m");
    store.dispatch("member.upsert", {
      id: memberId,
      name,
      icon: values.icon || "🪑",
      district: values.district || "At large",
      role: "Representative",
      presence: "away",
      seniority: count + 1,
      canChat,
      canTalk,
    });

    // Remember these toggles as the defaults for the next new member.
    store.dispatch("session.set", { memberDefaults: { canChat, canTalk } });
    toast(`${values.icon || "🪑"} ${name} is enrolled!`);

    // Hand the Chair their sign-in code straight away — enrolling someone and
    // getting them onto a device is one motion, not two.
    await showSeatCode(store, ctx, { id: memberId, name, icon: values.icon || "🪑" });
    return true;
  },

  /** Send a chamber chat message. Needs a seat and chat permission. */
  "chat-send"(store, form, values) {
    const memberId = requireSeat(store);
    if (!memberId) return false;
    if (!store.select.canChat(memberId)) {
      toast("The Chair hasn't switched chat on for your seat yet.", "warn");
      return false;
    }
    const text = String(values.text || "").trim();
    if (!text) return false;
    store.dispatch("chat.post", {
      id: newId("msg"),
      memberId,
      name: select.member(store.state, memberId)?.name || "A cousin",
      icon: select.member(store.state, memberId)?.icon || "🪑",
      text,
    });
    return true;
  },

  async "open-vote"(store, form, values) {
    if (!(await requireChair())) return false;
    const closesAt = values.minutes
      ? new Date(Date.now() + Number(values.minutes) * 60000).toISOString()
      : undefined;
    store.dispatch("vote.open", {
      id: newId("vote"),
      number: values.number || `Roll Call ${Math.floor(10 + Math.random() * 90)}`,
      title: values.title,
      summary: values.summary,
      billId: values.billId || undefined,
      threshold: values.threshold || "majority",
      opensAt: new Date().toISOString(),
      closesAt,
    });
    toast("🔨 The Chair has called the vote — every device just heard the bell.");
    return true;
  },

  "delegate-proxy"(store, form, values) {
    const memberId = requireSeat(store);
    if (!memberId) return false;
    if (values.to === memberId) {
      toast("You cannot hold your own proxy.", "err");
      return false;
    }
    if (!values.to) {
      store.dispatch("proxy.revoke", { memberId });
      toast("Proxy revoked.");
      return true;
    }
    store.dispatch("proxy.delegate", { memberId, to: values.to, scope: values.scope || "all" });
    toast(`Proxy delegated to ${select.member(store.state, values.to)?.name || values.to}.`);
    return true;
  },

  async "add-docket"(store, form, values) {
    if (!(await requireChair())) return false;
    store.dispatch("docket.add", {
      id: newId("evt"),
      title: values.title,
      kind: values.kind || "session",
      starts: values.starts ? new Date(values.starts).toISOString() : new Date().toISOString(),
      durationMin: Number(values.durationMin) || 30,
      room: values.room || undefined,
      note: values.note || undefined,
    });
    toast("Added to the docket.");
    return true;
  },

  /**
   * A chamber-wide announcement. Reaches every connected device, seated or
   * not — the one message that does not need a claimed seat to be heard.
   */
  async "post-announcement"(store, form, values) {
    if (!(await requireChair())) return false;
    const minutes = Number(values.minutes) || 0;
    store.dispatch("announce.post", {
      id: newId("ann"),
      text: values.text,
      tone: values.tone || "info",
      icon: values.icon || "📣",
      by: store.identity.displayName || "The Chair",
      until: minutes ? new Date(Date.now() + minutes * 60000).toISOString() : null,
    });
    toast("📣 Announced to every device in the chamber.");
    return true;
  },

  /**
   * A member's own note in the newsroom. Unlike an official dispatch this needs
   * only a claimed seat, not the gavel — it is the cousins' own bulletin board.
   * Flagged as a note so the newsroom can set it apart from Chair dispatches.
   */
  "post-note"(store, form, values) {
    const memberId = requireSeat(store);
    if (!memberId) return false;
    store.dispatch("news.post", {
      id: newId("note"),
      title: values.title,
      category: "Cousin note",
      excerpt: values.excerpt || values.body?.slice(0, 140),
      body: values.body,
      author: select.member(store.state, memberId)?.name || "A cousin",
      authorId: memberId,
      memberNote: true,
      published: new Date().toISOString(),
    });
    toast("📝 Your note is on the newsroom board.");
    return true;
  },

  async "post-news"(store, form, values) {
    if (!(await requireChair())) return false;
    store.dispatch("news.post", {
      id: newId("news"),
      title: values.title,
      category: values.category || "notice",
      excerpt: values.excerpt,
      body: values.body,
      author: store.identity.displayName || "Office of the Clerk",
      published: new Date().toISOString(),
    });
    toast("Dispatch published.");
    return true;
  },

  /* --- private, server-bound -------------------------------------------- */

  async contact(store, form, values) {
    await sendOrQueue("/api/messages", values, {
      sentMessage: "Message delivered to the clerk's office.",
      queuedMessage: "Saved on this device — it sends itself once the office is reachable.",
    });
    return true;
  },

  async subscribe(store, form, values) {
    await sendOrQueue("/api/subscribe", values, {
      sentMessage: "Subscribed to the chamber bulletin.",
      queuedMessage: "Saved on this device — you'll be subscribed once the office is reachable.",
    });
    return true;
  },
};

/* ==========================================================================
   Drafting studio — live engrossment preview
   ========================================================================== */

const DRAFT_KEY = "cc.draft";

/**
 * Mirrors the drafting form into the engrossment preview. The styling of the
 * preview, the progress checklist state and the validation cues are all CSS;
 * this only moves text and toggles one class per checklist row.
 */
export function initDraftStudio(store) {
  const form = qs("[data-action='submit-bill']");
  if (!form) return;

  const preview = {
    number: qs("[data-draft='number']"),
    title: qs("[data-draft='title']"),
    text: qs("[data-draft='text']"),
    sponsor: qs("[data-draft='sponsor']"),
  };

  const paint = () => {
    const values = formValues(form);
    if (preview.number) preview.number.textContent = values.number || "H.CC. ___";
    if (preview.title) preview.title.textContent = values.title || "An untitled measure";
    if (preview.text) {
      preview.text.textContent = values.text || "The operative text of the bill appears here as you type.";
    }
    if (preview.sponsor) {
      preview.sponsor.textContent = store.identity.displayName || "Sponsor — unclaimed seat";
    }

    for (const row of qsa("[data-requires]")) {
      const field = form.elements[row.dataset.requires];
      const min = Number(row.dataset.min || 1);
      row.classList.toggle("is-done", Boolean(field?.value?.trim().length >= min));
    }

    const counter = qs("[data-count='text']");
    if (counter) counter.textContent = `${(values.text || "").length} characters`;

    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(values));
    } catch {
      /* autosave is best effort */
    }
  };

  // Restore whatever was being written when the tab was last closed.
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (saved) {
      for (const [key, value] of Object.entries(saved)) {
        if (form.elements[key]) form.elements[key].value = value;
      }
    }
  } catch {
    /* ignore a corrupt draft */
  }

  form.addEventListener("input", paint);
  store.addEventListener("identity", paint);
  paint();
}

/* ==========================================================================
   Wiring
   ========================================================================== */

export function initActions(store, sync) {
  const ctx = { store, sync };

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (!el || el.tagName === "FORM") return;
    const handler = CLICK_ACTIONS[el.dataset.action];
    if (!handler) return;
    event.preventDefault();
    handler(store, el, ctx);
  });

  // Ballots commit on change, not on submit: a vote is one click, and it is
  // recorded the instant it is made whether or not anything is reachable.
  document.addEventListener("change", (event) => {
    const el = event.target;
    if (el.dataset?.action !== "cast") return;
    const memberId = requireSeat(store);
    if (!memberId) {
      el.checked = false;
      return;
    }
    store.dispatch("ballot.cast", {
      voteId: el.dataset.vote,
      memberId,
      choice: el.value,
      castAt: new Date().toISOString(),
    });
    toast(`Ballot recorded: ${el.value}.`);
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    const action = form.dataset?.action;
    const handler = FORM_ACTIONS[action];
    if (!handler) return;

    event.preventDefault();
    if (!form.reportValidity()) return;

    const submit = qs("[type='submit']", form);
    if (submit) submit.disabled = true;
    try {
      const reset = await handler(store, form, formValues(form), ctx);
      if (reset !== false) form.reset();
    } catch (error) {
      toast(String(error.message || error), "err");
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  // Log import from a file picker.
  const importInput = qs("#import-file");
  importInput?.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const count = await store.importLog(await file.text());
      toast(count ? `Merged ${count} new operations.` : "Already up to date — nothing new in that file.");
    } catch (error) {
      toast(`Could not read that log: ${error.message}`, "err");
    } finally {
      importInput.value = "";
    }
  });

  initDraftStudio(store);
  drainOutbox();
  addEventListener("online", drainOutbox);
}

export default initActions;
