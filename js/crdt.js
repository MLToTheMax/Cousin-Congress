/**
 * crdt.js — the convergence core.
 *
 * The chamber's entire state is a fold over an append-only log of immutable
 * operations. Nothing mutates state directly; a client appends an op, folds
 * it, and paints. Replicas exchange ops in any order, any number of times,
 * and land on identical state because:
 *
 *   1. Ops are content-addressed by `${actor}:${seq}`, so replay is a no-op.
 *   2. Ops carry a hybrid logical clock that totally orders the log with a
 *      deterministic tiebreak, so every replica folds in the same sequence.
 *   3. Every reducer is a last-writer-wins shallow merge over a keyed entity,
 *      or an add-only set. Both are commutative once (2) fixes the order.
 *
 * Deletes are tombstones, never removals — a removal cannot be replicated to
 * a peer that has not yet seen the thing being removed.
 *
 * Authorisation rides on the same fold. Every privileged op is checked against
 * authz.js before its reducer runs, using the AUTHENTICATED signer (op.kid) and
 * the key bindings held in state — never the payload's own claims. Because the
 * check is a pure function of the total-ordered log, every replica reaches the
 * same verdict, so an unauthorised op folds into the log (staying convergent
 * and auditable) but changes nothing.
 */

import {
  authorize,
  hasChair,
  isChairKey,
  chairKeysOf,
  memberKeysOf,
  ownsMember,
  memberOwned,
} from "./authz.js";

/* ==========================================================================
   Hybrid logical clock
   ========================================================================== */

const PAD_MS = 15;
const PAD_CT = 5;
const COUNT_CAP = 10 ** PAD_CT; // counter rolls into ms before it overflows its field
/**
 * How far ahead of our own wall clock we will let a peer's timestamp move us.
 * Without this cap a single op carrying a near-maximum `ms` would poison our
 * clock so that our OWN subsequent stamps overflow the wire format and are
 * dropped by every peer — a silent, persistent, chamber-wide write-partition
 * from one message. A day is generous for honest clock drift and astronomically
 * short of the attack.
 */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const pad = (n, w) => String(n).padStart(w, "0");

/**
 * Packs wall time, a per-millisecond counter and the actor id into one
 * lexicographically sortable string. Wall time keeps timestamps humane; the
 * counter survives bursts inside a single millisecond; the actor id breaks
 * ties between replicas that wrote concurrently.
 */
export class Clock {
  constructor(actor, state) {
    this.actor = actor;
    this.ms = state?.ms ?? 0;
    this.count = state?.count ?? 0;
  }

  /** Stamp a locally originated op. */
  tick() {
    const wall = Date.now();
    if (wall > this.ms) {
      this.ms = wall;
      this.count = 0;
    } else {
      this.count += 1;
    }
    this.#normalize();
    return this.pack();
  }

  /**
   * Fold a remote timestamp in. Keeping our clock at or ahead of everything
   * we have seen is what stops a peer with a fast clock from permanently
   * winning every future conflict.
   */
  observe(stamp) {
    const remote = Clock.parse(stamp);
    if (!remote) return;
    const wall = Date.now();
    // Never adopt a timestamp more than a bounded skew ahead of our wall clock:
    // that is the clock-poison defence. Counts are likewise bounded so a huge
    // remote counter cannot overflow our fixed-width field.
    const ceil = wall + MAX_CLOCK_SKEW_MS;
    const remoteMs = Math.min(remote.ms, ceil);
    const remoteCount = Math.min(remote.count, COUNT_CAP - 1);
    if (remoteMs > this.ms) {
      this.ms = remoteMs;
      this.count = remoteCount + 1;
    } else if (remoteMs === this.ms) {
      this.count = Math.max(this.count, remoteCount) + 1;
    }
    if (wall > this.ms) {
      this.ms = wall;
      this.count = 0;
    }
    this.#normalize();
  }

  /** Keep the counter inside its field width by rolling overflow into ms. */
  #normalize() {
    while (this.count >= COUNT_CAP) {
      this.ms += 1;
      this.count -= COUNT_CAP;
    }
  }

  pack() {
    return `${pad(this.ms, PAD_MS)}:${pad(this.count, PAD_CT)}:${this.actor}`;
  }

  snapshot() {
    return { ms: this.ms, count: this.count };
  }

  static parse(stamp) {
    if (typeof stamp !== "string") return null;
    const [ms, count, actor] = stamp.split(":");
    if (ms === undefined || count === undefined) return null;
    return { ms: Number(ms), count: Number(count), actor };
  }

  /** Human-readable wall time carried by a stamp. */
  static timeOf(stamp) {
    const parsed = Clock.parse(stamp);
    return parsed ? new Date(parsed.ms) : null;
  }
}

/* ==========================================================================
   Version vectors
   ========================================================================== */

/** `{ actorId: highestContiguousSeq }` — the whole sync protocol rests on this. */
export const VV = {
  empty: () => ({}),

  /** Record that we hold `seq` from `actor`. */
  observe(vv, actor, seq) {
    if (!(actor in vv) || vv[actor] < seq) vv[actor] = seq;
    return vv;
  },

  /** True when `vv` already contains the op. */
  has(vv, op) {
    return (vv[op.actor] ?? -1) >= op.seq;
  },

  /** Ops in `ops` that `remote` is missing. This is the delta we send. */
  missing(ops, remote) {
    return ops.filter((op) => (remote[op.actor] ?? -1) < op.seq);
  },

  merge(a, b) {
    const out = { ...a };
    for (const [actor, seq] of Object.entries(b || {})) {
      if (!(actor in out) || out[actor] < seq) out[actor] = seq;
    }
    return out;
  },

  /** Total ops described, used for the convergence readout in the UI. */
  size(vv) {
    return Object.values(vv).reduce((sum, seq) => sum + seq + 1, 0);
  },

  equal(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) if ((a?.[k] ?? -1) !== (b?.[k] ?? -1)) return false;
    return true;
  },
};

/* ==========================================================================
   Ops
   ========================================================================== */

export const opId = (op) => `${op.actor}:${op.seq}`;

/** Deterministic total order. HLC first, op id as the final tiebreak. */
export const compareOps = (a, b) => {
  if (a.hlc === b.hlc) return opId(a) < opId(b) ? -1 : 1;
  return a.hlc < b.hlc ? -1 : 1;
};

/** Cheap structural validation — anything arriving from a peer goes through here. */
export function isValidOp(op) {
  return (
    op &&
    typeof op === "object" &&
    typeof op.actor === "string" &&
    op.actor.length > 0 &&
    op.actor.length <= 64 &&
    Number.isInteger(op.seq) &&
    op.seq >= 0 &&
    typeof op.hlc === "string" &&
    Clock.parse(op.hlc) !== null &&
    typeof op.type === "string" &&
    op.type.length <= 64 &&
    op.payload !== null &&
    typeof op.payload === "object"
  );
}

/* ==========================================================================
   Reducers
   ========================================================================== */

export const emptyState = () => ({
  session: {}, // chamber-level status: in session, recess, sitting number
  members: {}, // memberId -> member record (incl. presence/location/status)
  committees: {},
  votes: {}, // voteId -> motion record
  ballots: {}, // `${voteId}::${memberId}` -> ballot
  bills: {},
  cosponsors: {}, // `${billId}::${memberId}` -> sign-on
  amendments: {},
  comments: {},
  news: {},
  docket: {},
  proxies: {}, // memberId -> delegation
  statuses: {}, // statusId -> floor status update (append-only feed)
  announcements: {}, // chamber-wide notices, shown even to unseated devices
  shares: {}, // live scoped read-grants for guests, revocable
  chat: {}, // chamber chat messages (Chair enables per member)
  devices: {}, // kid -> every device that has ever connected (Chair roster)
});

/** Shallow last-writer-wins merge into a keyed entity table. */
function put(table, key, patch, op) {
  const prev = table[key];
  table[key] = {
    ...(prev || {}),
    ...patch,
    id: key,
    _hlc: op.hlc,
    _actor: op.actor,
  };
  return table[key];
}

/**
 * One reducer per op type. Each is a pure (state, op) -> void shallow merge,
 * which is why fold order is the only thing that has to be agreed on.
 */
const REDUCERS = {
  "session.set": (s, op) => {
    // chairKeys / chairRequests are managed only by their own binding ops, so a
    // session.set can never smuggle a chair key in through a wholesale merge.
    const { chairKeys, chairRequests, ...rest } = op.payload || {};
    s.session = { ...s.session, ...rest, _hlc: op.hlc };
  },

  /* --- trust bindings (see authz.js) ------------------------------------- */

  /** Bind the signing key as a chair device. First-writer-wins: authz.js only
   *  lets this run for the founder (no chair yet) or an existing chair. */
  "chair.claim": (s, op) => {
    const kid = op.payload?.kid || op.kid;
    if (!kid) return;
    s.session = {
      ...s.session,
      chairKeys: { ...(s.session.chairKeys || {}), [kid]: { actor: op.actor, at: op.hlc } },
    };
  },

  /**
   * A seated cousin endorses moving the gavel to another seat.
   *
   * The last resort, for when the Chair's password is gone as well as the Chair's
   * device — otherwise chair.recover is the answer and this is not needed. It is
   * deliberately hard to reach in the interface and deliberately hard to use: it
   * needs a supermajority of the seated chamber AND a Chair who has genuinely
   * stopped answering.
   *
   * "Stopped answering" is not a promise about wall-clock time — replicas
   * disagree about that — so it is measured in the record itself: the newest
   * op anyone has authored, against the newest op authored by a Chair device.
   * And any act by a Chair clears every pending petition outright (see
   * clearPetitionsOnChairActivity below), so a Chair who is merely quiet for a
   * fortnight and then speaks up cancels the whole thing by speaking up.
   */
  "chair.petition": (s, op) => {
    const p = op.payload || {};
    const seat = p.seat;
    const by = p.memberId;
    if (!seat || !by || !s.members?.[seat] || !s.members?.[by]) return;

    const petitions = { ...(s.session?.chairPetitions || {}) };
    const backers = { ...(petitions[seat] || {}) };
    backers[by] = { at: op.hlc, kid: op.kid };
    petitions[seat] = backers;
    s.session = { ...s.session, chairPetitions: petitions };

    // Does this endorsement carry it? Both tests, every time, on every replica.
    const seated = Object.values(s.members || {}).filter((m) => m && !m._deleted).length;
    const needed = Math.max(2, Math.ceil((seated * 2) / 3));
    if (Object.keys(backers).length < needed) return;
    if (!chairIsDormant(s)) return;

    // Carried. The gavel moves to the seat, and the old Chair's device keys go
    // with it — leaving them enrolled would hand the lost device the gavel back
    // the moment it reappeared.
    s.session = {
      ...s.session,
      chairSeat: seat,
      chairKeys: {},
      chairRequests: {},
      chairPetitions: {},
      chairSuccession: { seat, at: op.hlc, backers: Object.keys(backers).length, of: seated },
    };
  },

  /** Withdraw an endorsement. A petition nobody still backs simply lapses. */
  "chair.unpetition": (s, op) => {
    const p = op.payload || {};
    const petitions = { ...(s.session?.chairPetitions || {}) };
    const backers = { ...(petitions[p.seat] || {}) };
    delete backers[p.memberId];
    if (Object.keys(backers).length) petitions[p.seat] = backers;
    else delete petitions[p.seat];
    s.session = { ...s.session, chairPetitions: petitions };
  },

  /**
   * Self-enrol a Chair device by proving knowledge of the Chair's password.
   *
   * The escape hatch for a lost Chair device, where the ordinary route —
   * "ask an existing Chair device to approve you" — has nobody left to ask.
   * The op carries a signature over (room, kid, ts) made with a key that only
   * the Chair's password can unwrap, so every replica checks it independently.
   * The cryptographic check happens in store.ingest, where op signatures are
   * already verified; by the time a reducer sees this the proof has held.
   */
  "chair.recover": (s, op) => {
    const kid = op.payload?.kid || op.kid;
    if (!kid) return;
    const requests = { ...(s.session?.chairRequests || {}) };
    delete requests[kid];
    s.session = {
      ...s.session,
      chairKeys: {
        ...(s.session.chairKeys || {}),
        [kid]: { actor: op.actor, at: op.hlc, recovered: true },
      },
      chairRequests: requests,
    };
  },

  /** An established chair enrols another device as a chair, clearing any
   *  pending request from that device. */
  "chair.enroll": (s, op) => {
    const kid = op.payload?.kid;
    if (!kid) return;
    const requests = { ...(s.session.chairRequests || {}) };
    delete requests[kid];
    s.session = {
      ...s.session,
      chairKeys: {
        ...(s.session.chairKeys || {}),
        [kid]: { actor: op.payload.actor || op.actor, at: op.hlc },
      },
      chairRequests: requests,
    };
  },

  /** A device asks to be enrolled as a chair. Grants nothing on its own; the
   *  chair sees it and may approve with chair.enroll. */
  "chair.request": (s, op) => {
    const kid = op.payload?.kid || op.kid;
    if (!kid) return;
    s.session = {
      ...s.session,
      chairRequests: {
        ...(s.session.chairRequests || {}),
        [kid]: { actor: op.actor, name: op.payload?.name || "", at: op.hlc },
      },
    };
  },

  /** Bind the signing key as authorised to act as a member (seat claim). */
  "member.claimKey": (s, op) => {
    const memberId = op.payload?.memberId;
    const kid = op.payload?.kid || op.kid;
    const member = s.members[memberId];
    if (!member || !kid) return;
    const pending = { ...(member.pendingKeys || {}) };
    delete pending[kid];
    s.members[memberId] = {
      ...member,
      keys: { ...(member.keys || {}), [kid]: { actor: op.actor, at: op.hlc } },
      pendingKeys: pending,
      _hlc: op.hlc,
      _actor: op.actor,
    };
  },

  /** A device that knows a seat's password but isn't the seat's first device
   *  asks the Chair to enrol it. Grants nothing on its own — the Chair approves
   *  with member.enrollKey — so anyone folding this just sees a pending request. */
  "member.requestKey": (s, op) => {
    const memberId = op.payload?.memberId;
    const kid = op.payload?.kid || op.kid;
    const member = s.members[memberId];
    if (!member || !kid || (member.keys && member.keys[kid])) return;
    s.members[memberId] = {
      ...member,
      pendingKeys: {
        ...(member.pendingKeys || {}),
        [kid]: { name: op.payload?.name || "", at: op.hlc },
      },
      _hlc: op.hlc,
    };
  },

  /** The chair enrols an additional device onto a seat, clearing its request. */
  "member.enrollKey": (s, op) => {
    const { memberId, kid } = op.payload || {};
    const member = s.members[memberId];
    if (!member || !kid) return;
    const pending = { ...(member.pendingKeys || {}) };
    delete pending[kid];
    s.members[memberId] = {
      ...member,
      keys: { ...(member.keys || {}), [kid]: { actor: op.payload.actor || op.actor, at: op.hlc } },
      pendingKeys: pending,
      _hlc: op.hlc,
    };
  },

  /** The chair clears a seat's keys (and any pending requests) so a new device
   *  can re-claim it — recovery for a lost or replaced device. */
  "member.resetKeys": (s, op) => {
    const member = s.members[op.payload?.memberId];
    if (!member) return;
    s.members[op.payload.memberId] = { ...member, keys: {}, pendingKeys: {}, _hlc: op.hlc };
  },

  "member.upsert": (s, op) => put(s.members, op.payload.id, op.payload, op),

  "member.presence": (s, op) => {
    const { memberId, ...rest } = op.payload;
    put(s.members, memberId, rest, op);
  },

  "member.retract": (s, op) => put(s.members, op.payload.id, { _deleted: true }, op),

  /** Seat password: {memberId, auth: {salt, hash}} — auth:null clears it. */
  "member.auth": (s, op) => {
    const { memberId, auth } = op.payload;
    if (!memberId) return;
    put(s.members, memberId, { auth: auth || null }, op);
  },

  "committee.upsert": (s, op) => put(s.committees, op.payload.id, op.payload, op),

  "status.post": (s, op) => put(s.statuses, op.payload.id, op.payload, op),
  "status.retract": (s, op) => put(s.statuses, op.payload.id, { _deleted: true }, op),

  "vote.open": (s, op) => put(s.votes, op.payload.id, { state: "open", ...op.payload }, op),
  "vote.close": (s, op) =>
    put(s.votes, op.payload.id, { state: "closed", ...op.payload }, op),
  "vote.retract": (s, op) => put(s.votes, op.payload.id, { _deleted: true }, op),

  /**
   * A ballot is keyed by (vote, member), so two devices casting for the same
   * member converge on whichever stamp is later rather than double-counting.
   * That single key choice is what makes the tally conflict-free.
   */
  "ballot.cast": (s, op) => {
    const { voteId, memberId } = op.payload;
    if (!voteId || !memberId) return;
    put(s.ballots, `${voteId}::${memberId}`, { ...op.payload, at: op.hlc }, op);
  },

  "bill.upsert": (s, op) => put(s.bills, op.payload.id, op.payload, op),
  "bill.stage": (s, op) => {
    const { billId, stage, stageNote } = op.payload;
    put(s.bills, billId, { stage, stageNote }, op);
  },
  "bill.retract": (s, op) => put(s.bills, op.payload.id, { _deleted: true }, op),

  "cosponsor.add": (s, op) => {
    const { billId, memberId } = op.payload;
    put(s.cosponsors, `${billId}::${memberId}`, { ...op.payload, signed: true }, op);
  },
  "cosponsor.remove": (s, op) => {
    const { billId, memberId } = op.payload;
    put(s.cosponsors, `${billId}::${memberId}`, { ...op.payload, signed: false }, op);
  },

  "amendment.file": (s, op) => put(s.amendments, op.payload.id, op.payload, op),
  "amendment.withdraw": (s, op) =>
    put(s.amendments, op.payload.id, { _deleted: true }, op),

  "comment.post": (s, op) => put(s.comments, op.payload.id, op.payload, op),
  "comment.retract": (s, op) => put(s.comments, op.payload.id, { _deleted: true }, op),

  "news.post": (s, op) => put(s.news, op.payload.id, op.payload, op),
  "news.retract": (s, op) => put(s.news, op.payload.id, { _deleted: true }, op),

  /**
   * Chamber-wide announcement. Reaches every connected device regardless of
   * whether anyone has claimed a seat on it, which is the point: the gallery
   * should hear "we're starting in five minutes" without having to log in.
   */
  "announce.post": (s, op) => put(s.announcements, op.payload.id, op.payload, op),
  "announce.retract": (s, op) => put(s.announcements, op.payload.id, { _deleted: true }, op),

  /**
   * A live share grant: permission for a guest to read ONE item over a scoped
   * connection. The grant is a first-class, replicated record so that any
   * device serving the guest — and the Chair, from anywhere — can see it and
   * revoke it. Revocation is just a later op; the record is append-only.
   */
  // `byKid` is stamped from the AUTHENTICATED signer, never from the payload, so
  // re-grant/revoke authority can be bound to a key instead of a mutable label.
  "share.grant": (s, op) =>
    put(s.shares, op.payload.id, { revoked: false, ...op.payload, byKid: op.kid || null }, op),
  "share.revoke": (s, op) => put(s.shares, op.payload.id, { revoked: true, revokedBy: op.payload.by }, op),

  /**
   * A device joined the mesh. Recorded by whoever observed the connection (the
   * observer sees the peer's address; the peer itself reports its name), so the
   * Chair has a durable roster of what has ever connected — not just what is
   * connected right now — with the details needed to spot a stranger.
   */
  "device.seen": (s, op) => {
    const { kid } = op.payload || {};
    if (!kid) return;
    const prev = s.devices[kid] || {};
    s.devices[kid] = {
      ...prev,
      ...op.payload,
      id: kid,
      firstSeen: prev.firstSeen || op.hlc,
      lastSeen: op.hlc,
      seenBy: op.actor,
      _hlc: op.hlc,
    };
  },

  /** The Chair bars a device from the chamber. Enforced on connect. */
  "device.revoke": (s, op) => {
    const { kid } = op.payload || {};
    if (!kid) return;
    s.devices[kid] = {
      ...(s.devices[kid] || {}),
      id: kid,
      revoked: true,
      revokedAt: op.hlc,
      _hlc: op.hlc,
    };
  },

  /** Chamber chat. Enabled per member by the Chair (see canChat). */
  "chat.post": (s, op) => put(s.chat, op.payload.id, op.payload, op),
  "chat.retract": (s, op) => put(s.chat, op.payload.id, { _deleted: true }, op),

  "docket.add": (s, op) => put(s.docket, op.payload.id, op.payload, op),
  "docket.remove": (s, op) => put(s.docket, op.payload.id, { _deleted: true }, op),

  "proxy.delegate": (s, op) => put(s.proxies, op.payload.memberId, op.payload, op),
  "proxy.revoke": (s, op) =>
    put(s.proxies, op.payload.memberId, { _deleted: true, to: null }, op),
};

export const KNOWN_OP_TYPES = Object.freeze(Object.keys(REDUCERS));

/** Apply one op. Unknown types are kept in the log but ignored when folding,
 *  so an older client never loses data written by a newer one. An op that fails
 *  authorisation is likewise kept but folds to no effect. */
export function applyOp(state, op) {
  const reducer = REDUCERS[op.type];
  if (reducer && authorize(state, op)) reducer(state, op);
  noteActivity(state, op);
  return state;
}

/**
 * The two clocks the succession rule reads.
 *
 * `lastOpAt` is the newest moment anyone acted; `chairLastSeen` the newest
 * moment a Chair device did. Both come out of the op's hybrid logical clock
 * rather than Date.now(), so every replica computes the same answer from the
 * same log no matter when it folds it — which is the whole reason a rule this
 * consequential can live in the fold at all.
 *
 * Recorded for EVERY op, authorized or not: an op that fails authorisation
 * still proves its author was awake, and a Chair whose device is misconfigured
 * is present, not missing.
 *
 * Any act by a Chair device also wipes every pending petition. That is the
 * "does not work while the Chair is active" rule in its strongest form — a
 * Chair does not have to notice a petition or argue with it. Simply turning up
 * ends it.
 */
function noteActivity(state, op) {
  const at = hlcMs(op.hlc);
  if (!at) return;
  const session = state.session || {};
  const next = { ...session };
  if (at > (session.lastOpAt || 0)) next.lastOpAt = at;

  if (op.kid && isChairKey(state, op.kid)) {
    if (at > (session.chairLastSeen || 0)) next.chairLastSeen = at;
    if (session.chairPetitions && Object.keys(session.chairPetitions).length) {
      next.chairPetitions = {};
    }
  }
  state.session = next;
}

/** Fold an ordered op list into materialized state. */
export function fold(ops, base) {
  const state = base ? structuredClone(base) : emptyState();
  for (const op of ops) applyOp(state, op);
  return state;
}

/* ==========================================================================
   Log
   ========================================================================== */

/**
 * An in-memory op log with a version vector and a materialized projection.
 * Insertion is idempotent, and out-of-order inserts trigger a refold so the
 * projection always reflects the canonical order rather than arrival order.
 */
export class Log {
  constructor() {
    this.byId = new Map();
    this.ordered = [];
    this.vv = VV.empty();
    this.state = emptyState();
    /** Ops folded since the last snapshot, used to decide when to compact. */
    this.sinceSnapshot = 0;
    this.snapshot = null;
  }

  get size() {
    return this.byId.size;
  }

  has(op) {
    return this.byId.has(opId(op));
  }

  /**
   * Insert ops, returning only the ones that were genuinely new. Callers use
   * that return value to decide what to broadcast, which keeps a mesh from
   * echoing the same op around the ring forever.
   */
  insert(ops) {
    const accepted = [];
    let needsRefold = false;
    const tail = this.ordered.at(-1);

    for (const op of ops) {
      if (!isValidOp(op)) continue;
      const id = opId(op);
      if (this.byId.has(id)) continue;

      this.byId.set(id, op);
      accepted.push(op);
      VV.observe(this.vv, op.actor, op.seq);

      // Arrived out of order relative to what we have already folded.
      if (tail && compareOps(op, tail) < 0) needsRefold = true;
    }

    if (!accepted.length) return accepted;

    if (needsRefold) {
      this.ordered = [...this.byId.values()].sort(compareOps);
      // Refold from EMPTY, never over the snapshot: the snapshot is a checkpoint
      // of the whole retained log, so folding the log on top of it double-applies
      // every pre-snapshot op. That is invisible for pure LWW, but authorisation
      // is order-sensitive — an op that was unauthorised at its real position
      // (before the op that bound its key) would see that binding already baked
      // into the snapshot base and wrongly take effect, and replicas that
      // compacted at different points would diverge. The full log is retained, so
      // a from-scratch fold is correct and deterministic.
      this.state = fold(this.ordered);
    } else {
      accepted.sort(compareOps);
      for (const op of accepted) {
        this.ordered.push(op);
        applyOp(this.state, op);
      }
    }

    this.sinceSnapshot += accepted.length;
    return accepted;
  }

  /** Everything a peer with `remote` is missing. */
  delta(remote) {
    return VV.missing(this.ordered, remote || {});
  }

  /**
   * The version vector we ADVERTISE to peers — the highest per-actor seq with no
   * gap beneath it, i.e. what we can actually answer a delta for.
   *
   * `this.vv` tracks the max seq seen (right for dedup and ordering), but a max
   * hides a missing middle op: receive seqs 0,1,5 for an actor and `vv` reads 5,
   * so a peer computing our delta thinks we already hold 2–4 and never resends
   * them — the gap is permanent. Advertising the CONTIGUOUS frontier (here, 1)
   * instead makes the peer resend from the gap; the ops we already have dedupe on
   * arrival. It can only ever cause more resends, never fewer, so it cannot break
   * convergence — and for a gapless log (the normal case) it equals `this.vv`.
   */
  advertisedVv() {
    const seqs = new Map();
    for (const op of this.ordered) {
      let set = seqs.get(op.actor);
      if (!set) seqs.set(op.actor, (set = new Set()));
      set.add(op.seq);
    }
    const out = {};
    for (const [actor, set] of seqs) {
      let frontier = -1;
      while (set.has(frontier + 1)) frontier += 1;
      out[actor] = frontier;
    }
    return out;
  }

  /**
   * Compact: fold everything into a checkpoint and keep the log. The ops are
   * deliberately retained — a peer joining with an empty vector must still be
   * able to receive the full history, and a snapshot alone cannot answer an
   * arbitrary version-vector delta request.
   */
  compact() {
    this.snapshot = {
      vv: { ...this.vv },
      state: structuredClone(this.state),
      at: Date.now(),
    };
    this.sinceSnapshot = 0;
    return this.snapshot;
  }

  /** Serializable form for export / IndexedDB / peer bootstrap. */
  export() {
    return { v: 1, vv: { ...this.vv }, ops: this.ordered };
  }
}

/* ==========================================================================
   Selectors — read models the views bind to
   ========================================================================== */

const alive = (record) => record && !record._deleted;
/**
 * How long a Chair may be silent before the chamber may replace them.
 * Long enough that a holiday, a flat battery or a school term cannot cost
 * somebody the gavel; short enough that a genuinely lost device is recoverable
 * within one family's patience.
 */
const CHAIR_DORMANT_MS = 21 * 24 * 60 * 60 * 1000;

/** Milliseconds out of a hybrid logical clock stamp ("ms:counter:actor"). */
const hlcMs = (hlc) => Number(String(hlc || "").split(":")[0]) || 0;

/**
 * Has the Chair stopped answering?
 *
 * Measured inside the record so every replica agrees: the newest moment anyone
 * acted, against the newest moment a Chair device acted. A chamber with no
 * Chair at all is trivially dormant; one whose Chair acted recently is not.
 */
function chairIsDormant(s) {
  if (!hasChair(s)) return true;
  const seen = s.session?.chairLastSeen || 0;
  const now = s.session?.lastOpAt || 0;
  if (!seen) return false; // a Chair we have never watched act is not presumed gone
  return now - seen >= CHAIR_DORMANT_MS;
}

const listOf = (table) => Object.values(table).filter(alive);

export const select = {
  members: (s) =>
    listOf(s.members).sort((a, b) => (a.name || "").localeCompare(b.name || "")),

  member: (s, id) => (alive(s.members[id]) ? s.members[id] : null),

  presenceCounts(s) {
    const counts = { present: 0, voting: 0, remote: 0, away: 0 };
    for (const m of listOf(s.members)) {
      const key = m.presence in counts ? m.presence : "away";
      counts[key] += 1;
    }
    return counts;
  },

  /** Anyone physically or virtually in attendance counts toward quorum. */
  quorum(s) {
    const members = listOf(s.members);
    const total = members.length;
    const attending = members.filter(
      (m) => m.presence === "present" || m.presence === "voting" || m.presence === "remote"
    ).length;
    const required = Math.floor(total / 2) + 1;
    return { total, attending, required, met: attending >= required };
  },

  votes: (s) =>
    listOf(s.votes).sort((a, b) => String(b.opensAt || "").localeCompare(String(a.opensAt || ""))),

  openVotes: (s) => select.votes(s).filter((v) => v.state === "open"),
  closedVotes: (s) => select.votes(s).filter((v) => v.state === "closed"),

  ballotsFor: (s, voteId) =>
    listOf(s.ballots).filter((b) => b.voteId === voteId),

  ballotOf: (s, voteId, memberId) => {
    const b = s.ballots[`${voteId}::${memberId}`];
    return alive(b) ? b : null;
  },

  /**
   * Tally a motion. Proxies are resolved here rather than at cast time so a
   * delegation that arrives late still retroactively counts, which is the
   * behaviour you want when devices sync out of order.
   */
  tally(s, voteId) {
    const vote = s.votes[voteId];
    const members = listOf(s.members);
    const counts = { yea: 0, nay: 0, present: 0, notVoting: 0 };
    const byMember = {};

    for (const m of members) {
      let ballot = select.ballotOf(s, voteId, m.id);

      if (!ballot) {
        const proxy = s.proxies[m.id];
        if (alive(proxy) && proxy.to) {
          const holder = select.ballotOf(s, voteId, proxy.to);
          if (holder) ballot = { ...holder, viaProxy: proxy.to };
        }
      }

      const choice = ballot?.choice;
      if (choice === "yea" || choice === "nay" || choice === "present") {
        counts[choice] += 1;
        byMember[m.id] = { ...ballot, choice };
      } else {
        counts.notVoting += 1;
        byMember[m.id] = null;
      }
    }

    const cast = counts.yea + counts.nay + counts.present;
    const decisive = counts.yea + counts.nay;
    const threshold = vote?.threshold || "majority";

    let needed;
    if (threshold === "twothirds") needed = Math.ceil((decisive * 2) / 3);
    else if (threshold === "unanimous") needed = decisive;
    else needed = Math.floor(decisive / 2) + 1;

    return {
      ...counts,
      cast,
      total: members.length,
      threshold,
      needed,
      passing: decisive > 0 && counts.yea >= needed,
      byMember,
      pct: (n) => (members.length ? (n / members.length) * 100 : 0),
    };
  },

  bills: (s) =>
    listOf(s.bills).sort((a, b) => String(b.introduced || "").localeCompare(String(a.introduced || ""))),

  bill: (s, id) => (alive(s.bills[id]) ? s.bills[id] : null),

  cosponsorsOf: (s, billId) =>
    listOf(s.cosponsors)
      .filter((c) => c.billId === billId && c.signed)
      .map((c) => c.memberId),

  amendmentsFor: (s, billId) => listOf(s.amendments).filter((a) => a.billId === billId),

  commentsFor: (s, targetId) =>
    listOf(s.comments)
      .filter((c) => c.targetId === targetId)
      .sort((a, b) => String(a._hlc).localeCompare(String(b._hlc))),

  news: (s) =>
    listOf(s.news).sort((a, b) => String(b.published || "").localeCompare(String(a.published || ""))),

  docket: (s) =>
    listOf(s.docket).sort((a, b) => String(a.starts || "").localeCompare(String(b.starts || ""))),

  statuses: (s, limit = 20) =>
    listOf(s.statuses)
      .sort((a, b) => String(b._hlc).localeCompare(String(a._hlc)))
      .slice(0, limit),

  committees: (s) => listOf(s.committees),

  announcements: (s, limit = 10) =>
    listOf(s.announcements)
      .filter((a) => !a.until || new Date(a.until).getTime() > Date.now())
      .sort((a, b) => String(b._hlc).localeCompare(String(a._hlc)))
      .slice(0, limit),

  /** Live share grants this device authored or holds the gavel over. */
  shares: (s) =>
    listOf(s.shares).sort((a, b) => String(b._hlc).localeCompare(String(a._hlc))),

  /** Is a share still good? Unknown, revoked, or expired all mean no. */
  shareLive(s, shareId) {
    const grant = s.shares[shareId];
    if (!grant || grant._deleted || grant.revoked) return false;
    if (grant.expiresAt && new Date(grant.expiresAt).getTime() < Date.now()) return false;
    return true;
  },

  share: (s, shareId) => s.shares[shareId] || null,

  /**
   * May this member use the walkie-talkie? Two policies: "all" (the default —
   * anyone seated can talk) or "chair-picks", where only members the Chair has
   * explicitly granted the talkie may transmit.
   */
  canTalk(s, memberId) {
    if (!memberId) return false;
    const member = select.member(s, memberId);
    if (!member || member.frozen) return false;
    // Voice goes to every device in the chamber at once and carries a real
    // person's actual voice, so it asks for more than "this device is on the
    // mesh": the seat must be a claimed one with a password set. Otherwise a
    // freshly-paired device could pick any unclaimed name off the roster and
    // start talking as them. Text and votes are already bound to a key by the
    // authorisation layer; this is the equivalent gate for audio.
    if (!member.auth) return false;
    const policy = s.session?.talkiePolicy || "all";
    if (policy === "all") return true;
    return Boolean(member.canTalk);
  },

  /**
   * May this member use the text chat? Chat is OFF for everyone by default —
   * the Chair grants it per member — so the policy defaults to "chair-picks".
   * A Chair who wants it open for all can flip the policy to "all".
   */
  canChat(s, memberId) {
    if (!memberId) return false;
    if (select.member(s, memberId)?.frozen) return false;
    const policy = s.session?.chatPolicy || "chair-picks";
    if (policy === "all") return true;
    return Boolean(select.member(s, memberId)?.canChat);
  },

  chat: (s, limit = 100) =>
    listOf(s.chat)
      .sort((a, b) => String(a._hlc).localeCompare(String(b._hlc)))
      .slice(-limit),

  /** Chamber-wide moderation state, all Chair-controlled. */
  locked: (s) => Boolean(s.session?.locked),
  frozenMembers: (s) => listOf(s.members).filter((m) => m.frozen),

  /* --- authority (key bindings, see authz.js) --------------------------- */

  /** Has any device claimed the chair yet? */
  chairEstablished: (s) => hasChair(s),
  /** Is the Chair silent long enough that the chamber may replace them? */
  chairDormant: (s) => chairIsDormant(s),
  /** Milliseconds of Chair silence, for the interface to explain itself with. */
  chairSilentFor: (s) => Math.max(0, (s.session?.lastOpAt || 0) - (s.session?.chairLastSeen || 0)),
  /** How many endorsements a succession needs, and who has given them. */
  chairPetition: (s, seat) => {
    const backers = Object.keys(s.session?.chairPetitions?.[seat] || {});
    const seated = Object.values(s.members || {}).filter((m) => m && !m._deleted).length;
    return { backers, seated, needed: Math.max(2, Math.ceil((seated * 2) / 3)) };
  },
  /** Is this key an enrolled chair device? */
  isChairDevice: (s, kid) => isChairKey(s, kid),
  /** Enrolled chair devices, for the Chair's dashboard. */
  chairDevices: (s) =>
    Object.entries(chairKeysOf(s)).map(([kid, meta]) => ({ kid, ...meta })),
  /** Devices asking to be enrolled as a chair, awaiting approval. */
  chairRequests: (s) =>
    Object.entries(s.session?.chairRequests || {})
      .filter(([kid]) => !chairKeysOf(s)[kid])
      .map(([kid, meta]) => ({ kid, ...meta })),

  /** Devices asking to be enrolled onto a seat, awaiting Chair approval —
   *  flattened across members for the Chair's dashboard. */
  seatRequests: (s) =>
    listOf(s.members).flatMap((m) =>
      Object.entries(m.pendingKeys || {})
        .filter(([kid]) => !(m.keys && m.keys[kid]))
        .map(([kid, meta]) => ({ memberId: m.id, memberName: m.name, memberIcon: m.icon, kid, ...meta }))
    ),
  /** Is this key authorised to act as the given member? */
  ownsSeat: (s, memberId, kid) => ownsMember(s, memberId, kid),
  /** Has anyone claimed this seat with a key yet? */
  seatClaimed: (s, memberId) => memberOwned(s, memberId),
  /** Devices enrolled on a seat, for the Chair's dashboard. */
  seatDevices: (s, memberId) =>
    Object.entries(memberKeysOf(s, memberId)).map(([kid, meta]) => ({ kid, ...meta })),

  /** Per-member participation record used by the scorecards. */
  scorecard(s, memberId) {
    const closed = select.closedVotes(s);
    let voted = 0;
    let yea = 0;
    let nay = 0;
    for (const v of closed) {
      const b = select.ballotOf(s, v.id, memberId);
      if (!b) continue;
      voted += 1;
      if (b.choice === "yea") yea += 1;
      if (b.choice === "nay") nay += 1;
    }
    const sponsored = listOf(s.bills).filter((b) => b.sponsor === memberId).length;
    const cosponsored = listOf(s.cosponsors).filter(
      (c) => c.memberId === memberId && c.signed
    ).length;
    return {
      votesEligible: closed.length,
      votesCast: voted,
      attendance: closed.length ? Math.round((voted / closed.length) * 100) : 100,
      yea,
      nay,
      sponsored,
      cosponsored,
    };
  },
};
