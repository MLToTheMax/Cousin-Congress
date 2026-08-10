/**
 * founding.js — starting a brand-new chamber.
 *
 * Almost everyone arrives by scanning a code someone else made, which is why
 * this is a quiet link at the bottom of the pairing page rather than a button
 * competing with the main flow. But somebody has to go first, and when they do
 * they should get a clean record and the gavel in one motion — not a demo
 * chamber full of example cousins they have to delete one at a time.
 *
 * THE GAVEL IS BOUND TO A SEAT
 *
 * Historically the Chair was "whoever knows the chair password", and every
 * privileged action re-asked for it. That is tedious for the one person who
 * uses it most. Founding now creates the founder's own seat, binds this device's
 * key to BOTH that seat and the chair, and records `chairSeat` — so once they
 * have signed in as themselves, chair actions simply work. The password is still
 * set (and still required from any device that is not an enrolled chair device),
 * so the gavel can be recovered or handed on.
 */

import { askDialog, toast } from "./ui.js";
import { select } from "./crdt.js";
import { makeAuth } from "./auth.js";

const newId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Has this device done anything yet? Founding is only safe on a device with no
 * history of its own: no claimed seat, no peer it has ever paired with, and
 * nothing in the record beyond what the shipped demo put there.
 */
export function canFound(store, sync) {
  if (store.identity.memberId) return { ok: false, why: "This device is already signed in to a seat." };
  if (select.chairEstablished(store.state)) {
    return { ok: false, why: "This chamber already has a Chair." };
  }
  const authored = Object.keys(store.vv).some((actor) => actor !== "genesis");
  if (authored) return { ok: false, why: "This device has already taken part in a chamber." };
  if ((sync?.status?.peers || []).length) {
    return { ok: false, why: "This device is connected to a chamber already." };
  }
  return { ok: true };
}

/** Every record the shipped snapshot created, retracted so the wipe replicates. */
const DEMO_RETRACTIONS = [
  ["members", "member.retract"],
  ["votes", "vote.retract"],
  ["bills", "bill.retract"],
  ["news", "news.retract"],
  ["docket", "docket.remove"],
  ["statuses", "status.retract"],
  ["comments", "comment.retract"],
  ["amendments", "amendment.withdraw"],
  ["announcements", "announce.retract"],
];

/** Clear the demo snapshot. Tombstones, not deletions, so it replicates. */
export function clearSampleData(store) {
  let cleared = 0;
  for (const [table, opType] of DEMO_RETRACTIONS) {
    for (const record of Object.values(store.state[table] || {})) {
      if (!record?.id || record._deleted) continue;
      store.dispatch(opType, { id: record.id });
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Found a chamber: clear the samples, create the founder's seat, bind this
 * device to it and to the gavel.
 */
export async function registerChair(store, sync) {
  const allowed = canFound(store, sync);
  if (!allowed.ok) {
    toast(allowed.why, "warn");
    return false;
  }

  const name = await askDialog({
    icon: "🏛️",
    title: "Start a new chamber",
    hint: "This clears the example data and makes you the Chair. What should we call you?",
    placeholder: "your name",
    confirmLabel: "Create the chamber",
  });
  if (!name || !name.trim()) return false;

  const pin = await askDialog({
    icon: "🔑",
    title: `Pick your password, ${name.trim()}`,
    hint: "You'll use this to sign in on any device. As the Chair you won't be asked for a separate gavel password on this one.",
    placeholder: "your secret word",
    confirmLabel: "Create the chamber",
    password: true,
    autocomplete: "new-password",
    username: name.trim(),
  });
  if (!pin || !pin.trim()) return false;

  // 1. Wipe the demo chamber so the family starts on a blank record.
  const cleared = clearSampleData(store);

  // 2. The founder's seat.
  const memberId = newId("m");
  store.dispatch("member.upsert", {
    id: memberId,
    name: name.trim(),
    icon: "🪑",
    district: "At large",
    role: "Chair",
    presence: "present",
    seniority: 1,
    canTalk: true,
    canChat: true,
  });

  // 3. Bind this device's key to the seat AND to the gavel, and record which
  //    seat holds the chair so signing in as that cousin is enough from now on.
  const kid = store.myFingerprint;
  if (kid) {
    store.dispatch("member.claimKey", { memberId, kid });
    store.dispatch("chair.claim", { kid });
  }
  const auth = await makeAuth(pin);
  store.dispatch("member.auth", { memberId, auth });
  store.dispatch("session.set", {
    chairAuth: auth, // same secret, so the gavel can still be recovered elsewhere
    chairSeat: memberId,
    demo: false,
    sitting: 1,
    founded: new Date().toISOString(),
  });

  // 4. This device is that cousin.
  store.setIdentity({ memberId, displayName: name.trim() });

  toast(
    cleared
      ? `Chamber created — ${cleared} example ${cleared === 1 ? "entry" : "entries"} cleared. You hold the gavel.`
      : "Chamber created. You hold the gavel."
  );
  return true;
}

export default { registerChair, canFound, clearSampleData };
