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
 */

/* ==========================================================================
   Hybrid logical clock
   ========================================================================== */

const PAD_MS = 15;
const PAD_CT = 5;

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
    if (remote.ms > this.ms) {
      this.ms = remote.ms;
      this.count = remote.count + 1;
    } else if (remote.ms === this.ms) {
      this.count = Math.max(this.count, remote.count) + 1;
    }
    if (wall > this.ms) {
      this.ms = wall;
      this.count = 0;
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
    s.session = { ...s.session, ...op.payload, _hlc: op.hlc };
  },

  "member.upsert": (s, op) => put(s.members, op.payload.id, op.payload, op),

  "member.presence": (s, op) => {
    const { memberId, ...rest } = op.payload;
    put(s.members, memberId, rest, op);
  },

  "member.retract": (s, op) => put(s.members, op.payload.id, { _deleted: true }, op),

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

  "docket.add": (s, op) => put(s.docket, op.payload.id, op.payload, op),
  "docket.remove": (s, op) => put(s.docket, op.payload.id, { _deleted: true }, op),

  "proxy.delegate": (s, op) => put(s.proxies, op.payload.memberId, op.payload, op),
  "proxy.revoke": (s, op) =>
    put(s.proxies, op.payload.memberId, { _deleted: true, to: null }, op),
};

export const KNOWN_OP_TYPES = Object.freeze(Object.keys(REDUCERS));

/** Apply one op. Unknown types are kept in the log but ignored when folding,
 *  so an older client never loses data written by a newer one. */
export function applyOp(state, op) {
  const reducer = REDUCERS[op.type];
  if (reducer) reducer(state, op);
  return state;
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
      this.state = fold(this.ordered, this.snapshot?.state);
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
