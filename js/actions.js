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
      output.value = await ctx.sync.acceptInvite(input.value);
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

  /** Enroll a new cousin. Chair only. */
  async "add-member"(store, form, values) {
    if (!(await requireChair())) return false;
    const name = String(values.name || "").trim();
    if (!name) return false;
    const count = select.members(store.state).length;
    store.dispatch("member.upsert", {
      id: newId("m"),
      name,
      icon: values.icon || "🪑",
      district: values.district || "At large",
      role: "Representative",
      presence: "away",
      seniority: count + 1,
    });
    toast(`${values.icon || "🪑"} ${name} is enrolled! They'll pick their password when they first sit down.`);
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
      const reset = await handler(store, form, formValues(form));
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
