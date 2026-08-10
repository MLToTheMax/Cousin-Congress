/**
 * statetools.js — measuring and reducing the shared record.
 *
 * The record is append-only, which is what makes it convergent: a removal cannot
 * be replicated to a peer that has not yet seen the thing being removed, so a
 * "delete" is a tombstone and the log only ever gets longer. That is correct,
 * and it is also why a chamber that has been chatting for a year eventually
 * wants a caretaker.
 *
 * This module gives the Chair three genuinely different tools, which are easy to
 * confuse and have very different consequences:
 *
 *   MEASURE  where the bytes actually are, per table and per op type.
 *   PRUNE    drop ops from THIS replica that are provably superseded. Shrinks
 *            storage. The cost is real: this device can no longer serve that
 *            history to a peer that never saw it.
 *   RETRACT  write a tombstone. Makes the log BIGGER, but removes the record
 *            from every view on every device. This is "get rid of it", not
 *            "make it smaller".
 *
 * Nothing here invents a new trust path: editing and retracting go through
 * ordinary signed ops, so the same authorisation rules apply as anywhere else.
 * Pruning is deliberately LOCAL ONLY — it never asks other devices to forget,
 * because a chamber where any one device can make history vanish everywhere is
 * a chamber whose record cannot be trusted.
 */

import { select, fold } from "./crdt.js";

/** Rough byte cost of an op on the wire and on disk. */
const opBytes = (op) => {
  try {
    return JSON.stringify(op).length;
  } catch {
    return 0;
  }
};

/** Which table an op type writes into, for attributing size. */
const TABLE_OF = {
  "session.set": "session", "chair.claim": "session", "chair.enroll": "session",
  "chair.request": "session",
  "member.upsert": "members", "member.presence": "members", "member.retract": "members",
  "member.auth": "members", "member.claimKey": "members", "member.requestKey": "members",
  "member.enrollKey": "members", "member.resetKeys": "members",
  "committee.upsert": "committees",
  "status.post": "statuses", "status.retract": "statuses",
  "vote.open": "votes", "vote.close": "votes", "vote.retract": "votes",
  "ballot.cast": "ballots",
  "bill.upsert": "bills", "bill.stage": "bills", "bill.retract": "bills",
  "cosponsor.add": "cosponsors", "cosponsor.remove": "cosponsors",
  "amendment.file": "amendments", "amendment.withdraw": "amendments",
  "comment.post": "comments", "comment.retract": "comments",
  "news.post": "news", "news.retract": "news",
  "announce.post": "announcements", "announce.retract": "announcements",
  "share.grant": "shares", "share.revoke": "shares",
  "device.seen": "devices", "device.revoke": "devices",
  "chat.post": "chat", "chat.retract": "chat",
  "docket.add": "docket", "docket.remove": "docket",
  "proxy.delegate": "proxies", "proxy.revoke": "proxies",
  "id.announce": "identity",
};

/**
 * Where the record's weight actually sits. Returns totals plus a per-table
 * breakdown sorted heaviest first, which is the only useful way to look at it —
 * the answer is almost always "chat" or "presence churn", and guessing wrong
 * means pruning the wrong thing.
 */
export function measure(store) {
  const ops = store.log.ordered;
  const byTable = new Map();
  const byType = new Map();
  let bytes = 0;

  for (const op of ops) {
    const size = opBytes(op);
    bytes += size;
    const table = TABLE_OF[op.type] || "other";
    const t = byTable.get(table) || { table, ops: 0, bytes: 0 };
    t.ops += 1;
    t.bytes += size;
    byTable.set(table, t);
    const y = byType.get(op.type) || { type: op.type, ops: 0, bytes: 0 };
    y.ops += 1;
    y.bytes += size;
    byType.set(op.type, y);
  }

  // Live vs tombstoned records, so "we have 4000 chat ops for 12 live messages"
  // is visible rather than something you have to work out.
  const records = {};
  let tombstones = 0;
  for (const [table, value] of Object.entries(store.state)) {
    if (!value || typeof value !== "object" || table === "session") continue;
    const all = Object.values(value);
    const dead = all.filter((r) => r && r._deleted).length;
    tombstones += dead;
    records[table] = { total: all.length, live: all.length - dead, deleted: dead };
  }

  return {
    ops: ops.length,
    bytes,
    replicas: Object.keys(store.vv).length,
    tombstones,
    prunable: findPrunable(store).length,
    records,
    byTable: [...byTable.values()].sort((a, b) => b.bytes - a.bytes),
    byType: [...byType.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

/**
 * Ops this replica can drop without changing the folded state.
 *
 * Only genuinely superseded ops qualify:
 *   - presence updates for a member that a LATER presence update overwrites
 *     entirely (the common case, and usually the bulk of the churn);
 *   - ops that only ever wrote a record which now carries a tombstone.
 *
 * Deliberately conservative. Anything whose removal could change a fold — a
 * ballot, a key binding, a chair claim, an identity announcement — is never
 * offered, because the whole point of the record is that it can be replayed.
 */
export function findPrunable(store) {
  const ops = store.log.ordered;
  const prunable = [];

  // A presence op is superseded only when a LATER presence op for the same
  // member writes every field it wrote — a key SUPERSET.
  //
  // "There is a newer one, so the old one is dead" is the obvious rule and it is
  // wrong: presence is a shallow merge, so an op that set `checkedInAt` is still
  // the only source of that field if the newer op only set `frozen`. Dropping it
  // silently loses data. Comparing key sets is what makes the prune provably
  // state-preserving rather than probably state-preserving.
  const presence = ops.filter((op) => op.type === "member.presence" && op.payload?.memberId);
  for (let i = 0; i < presence.length; i += 1) {
    const op = presence[i];
    const keys = Object.keys(op.payload).filter((k) => k !== "memberId");
    if (!keys.length) continue;
    const supersededBy = presence
      .slice(i + 1)
      .find(
        (later) =>
          later.payload.memberId === op.payload.memberId &&
          keys.every((k) => k in later.payload)
      );
    if (supersededBy) prunable.push(op);
  }

  // NOTE: ops that wrote a now-tombstoned record are deliberately NOT pruned,
  // even though it is tempting — they look like dead weight. A tombstone is a
  // shallow merge (`{_deleted: true}`), so the record still carries the fields
  // the earlier ops wrote: drop the `news.post` and the tombstoned record loses
  // its title. That is a change to the folded state, which is exactly the thing
  // pruning must never do. Getting rid of the content as well as the record is
  // what RETRACT plus a later prune of the whole entity would need, and that is
  // a bigger promise than this tool should make quietly.
  return prunable;
}

/**
 * Drop the prunable ops from this replica only, then refold from what remains.
 *
 * LOCAL ONLY, and that is a deliberate limit rather than an omission: a chamber
 * where one device can make history disappear everywhere is a chamber whose
 * record cannot be trusted. Other devices keep their copies, and anti-entropy
 * will happily hand any of it back — which is the honest behaviour, even though
 * it means pruning is housekeeping rather than erasure.
 */
export async function prune(store) {
  const doomed = new Set(findPrunable(store).map((op) => `${op.actor}:${op.seq}`));
  if (!doomed.size) return { removed: 0, bytesFreed: 0 };

  const keep = store.log.ordered.filter((op) => !doomed.has(`${op.actor}:${op.seq}`));

  // Prove it before doing it. The rule for a prune is "the folded record must be
  // byte-for-byte what it was" — a caretaker tool that quietly rewrites history
  // is worse than no tool at all — so fold the survivors and compare BEFORE
  // touching storage. If anything differs, refuse and say so rather than
  // half-applying. (This caught a real bug: dropping a post whose record was
  // later tombstoned silently lost the fields the tombstone had merged over.)
  const expected = JSON.stringify(store.state);
  const wouldBe = JSON.stringify(fold(keep));
  if (expected !== wouldBe) {
    return { removed: 0, bytesFreed: 0, refused: true, why: "pruning would change the record" };
  }

  const bytesFreed = store.log.ordered
    .filter((op) => doomed.has(`${op.actor}:${op.seq}`))
    .reduce((n, op) => n + opBytes(op), 0);

  await store.replaceLog(keep);
  return { removed: doomed.size, bytesFreed };
}

/**
 * Edit one record in place. Goes through a normal signed op, so the Chair can
 * fix a typo or a bad import without a special back door — and the edit is
 * attributable and replicates like anything else.
 */
const EDIT_OP = {
  members: "member.upsert",
  bills: "bill.upsert",
  votes: "vote.open",
  news: "news.post",
  docket: "docket.add",
  committees: "committee.upsert",
  statuses: "status.post",
  announcements: "announce.post",
};

export function editRecord(store, table, id, patch) {
  const type = EDIT_OP[table];
  if (!type) throw new Error(`Records in "${table}" cannot be edited directly.`);
  const existing = store.state[table]?.[id];
  if (!existing) throw new Error("That record is not here any more.");
  const { _hlc, _actor, _deleted, ...clean } = existing;
  return store.dispatch(type, { ...clean, ...patch, id });
}

/** The retraction op for a table, so the explorer can offer one uniformly. */
export const RETRACT_OP = {
  members: "member.retract", bills: "bill.retract", votes: "vote.retract",
  news: "news.retract", statuses: "status.retract", comments: "comment.retract",
  chat: "chat.retract", docket: "docket.remove", amendments: "amendment.withdraw",
  announcements: "announce.retract",
};

export const fmtBytes = (n) =>
  n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`;

export default { measure, findPrunable, prune, editRecord, RETRACT_OP, fmtBytes };
