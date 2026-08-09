/**
 * authz.js — who may do what, enforced at fold time.
 *
 * The signature layer (crypto.js) answers "who authored these bytes". The room
 * MAC (store.js) answers "did this come from inside the room". Neither answers
 * the question a red-team pass put its finger on: an op is authored by one
 * identity but *acts on* a payload naming a different member or the chamber
 * itself. Signing authenticates the author; the reducers were authorising by
 * payload. A member could therefore cast another member's ballot or overwrite
 * the gavel simply by naming them in the payload — a classic confused deputy.
 *
 * This module closes that. Authority is bound to keys, in replicated state:
 *
 *   - session.chairKeys : { kid -> {actor, at} }   who may run the chamber
 *   - members[id].keys  : { kid -> {actor, at} }   who may act as that member
 *
 * and every privileged op is checked against the AUTHENTICATED key that signed
 * it (op.kid), not against whatever the payload claims.
 *
 * Why at fold time, not at ingest. Authorisation depends on other ops — the
 * claim that bound a key, the founding of the chair — so it must be evaluated
 * against the same total order every replica folds in, or replicas would
 * diverge on what counts. `authorize(state, op)` is therefore a PURE function
 * of the state built so far (in HLC order) and the op, and applyOp() consults
 * it before running a reducer. An unauthorised op still lives in the log (so
 * the mesh stays convergent and the chair can audit the attempt) but changes
 * nothing.
 *
 * Trust bootstrap is first-writer-wins: the first key to claim the chair — or
 * an unclaimed seat — binds it, and after that only that key (or the chair) may
 * rebind. See docs/CC-SEAL.md §15 for the model and its documented residual
 * (a same-room adversary who backdates a founding claim; out-of-band pinning of
 * the chair fingerprint via the invite is the specced hardening).
 */

/* --- key-binding accessors ------------------------------------------------ */

export const chairKeysOf = (s) => (s && s.session && s.session.chairKeys) || {};
export const hasChair = (s) => Object.keys(chairKeysOf(s)).length > 0;
export const isChairKey = (s, kid) => Boolean(kid && chairKeysOf(s)[kid]);

export const memberKeysOf = (s, id) =>
  (id && s && s.members && s.members[id] && s.members[id].keys) || {};
export const memberOwned = (s, id) => Object.keys(memberKeysOf(s, id)).length > 0;
export const ownsMember = (s, id, kid) => Boolean(kid && memberKeysOf(s, id)[kid]);

/* --- helpers -------------------------------------------------------------- */

/** Fields on a member record only the chair may set (roles and moderation). */
const CHAIR_ONLY_MEMBER_FIELDS = new Set([
  "role",
  "frozen",
  "frozenBy",
  "canTalk",
  "canChat",
]);
const touchesChairFields = (payload) =>
  Object.keys(payload || {}).some((k) => CHAIR_ONLY_MEMBER_FIELDS.has(k));

/**
 * Member-scoped leniency: the chair may always act; the seat's own key may act;
 * and a seat NObody has claimed yet is open (so the first honest claim can bind
 * it). Ballots deliberately do NOT get this leniency — an unclaimed seat has no
 * voter — and are handled separately.
 */
const memberScoped = (s, memberId, kid) =>
  isChairKey(s, kid) || ownsMember(s, memberId, kid) || !memberOwned(s, memberId);

/** Scope an op to the member named in a field of an existing record. */
function recordScoped(s, table, id, field, kid) {
  const rec = s[table] && s[table][id];
  if (!rec) return true; // nothing to protect yet
  return memberScoped(s, rec[field], kid);
}

/* --- the policy ----------------------------------------------------------- */

/**
 * May `op` mutate state? Pure; depends only on the folded-so-far `state`.
 * Returns true to apply the reducer, false to fold the op with no effect.
 */
export function authorize(state, op) {
  if (!op) return false;
  // The shipped seed is trusted by construction (derived locally, never taken
  // from the network). A locally authored op reaches fold before it is signed,
  // so it has no kid yet — allow it; by the time it is replicated it carries a
  // verified kid and is re-checked on every peer and on any refold.
  if (op.actor === "genesis") return true;
  const kid = op.kid;
  if (!kid) return true;

  const chair = isChairKey(state, kid);
  const noChair = !hasChair(state);
  const p = op.payload || {};

  switch (op.type) {
    /* --- trust bindings --------------------------------------------------- */
    case "chair.claim":
      // Must bind the signer's own key, and only the founder (no chair yet) or
      // an existing chair may record one.
      if (p.kid && p.kid !== kid) return false;
      return noChair || chair;

    case "chair.enroll":
    case "member.enrollKey":
    case "member.resetKeys":
      return chair; // administering others' keys is the chair's alone

    case "chair.request":
    case "member.requestKey":
      return true; // a request grants nothing; the chair must still approve

    case "member.claimKey": {
      if (p.kid && p.kid !== kid) return false;
      const id = p.memberId;
      return chair || !memberOwned(state, id) || ownsMember(state, id, kid);
    }

    /* --- chamber governance: the chair (or the founder, pre-chair) --------- */
    case "session.set":
    case "vote.open":
    case "vote.close":
    case "vote.retract":
    case "bill.stage":
    case "announce.post":
    case "announce.retract":
    case "docket.add":
    case "docket.remove":
    case "committee.upsert":
      return chair || noChair;

    /* --- ballots: strictly the seat's own key, or the chair --------------- */
    case "ballot.cast":
      return chair || ownsMember(state, p.memberId, kid);

    /* --- member self-service, with chair override ------------------------- */
    case "member.presence":
      if (touchesChairFields(p)) return chair || noChair;
      return memberScoped(state, p.memberId, kid);

    case "member.auth": // set own password / chair reset
      return memberScoped(state, p.memberId, kid);

    case "member.retract":
      return chair || ownsMember(state, p.id, kid);

    case "member.upsert":
      if (touchesChairFields(p)) return chair || noChair;
      if (!state.members[p.id]) return chair || noChair; // a new enrolment
      return memberScoped(state, p.id, kid);

    case "status.post":
      return memberScoped(state, p.memberId, kid);
    case "status.retract":
      return recordScoped(state, "statuses", p.id, "memberId", kid);

    case "cosponsor.add":
    case "cosponsor.remove":
      return memberScoped(state, p.memberId, kid);

    case "proxy.delegate":
    case "proxy.revoke":
      return memberScoped(state, p.memberId, kid);

    case "chat.post":
      return memberScoped(state, p.memberId, kid);
    case "chat.retract":
      return recordScoped(state, "chat", p.id, "memberId", kid);

    case "amendment.file":
      return memberScoped(state, p.author, kid);
    case "amendment.withdraw":
      return recordScoped(state, "amendments", p.id, "author", kid);

    case "share.grant":
      return memberScoped(state, p.by, kid);
    case "share.revoke":
      return recordScoped(state, "shares", p.id, "by", kid);

    case "news.post":
      // A member's newsroom note is theirs; an official dispatch is the chair's.
      if (p.memberNote) return memberScoped(state, p.authorId, kid);
      return chair || noChair;
    case "news.retract":
      return chair || noChair;

    case "bill.upsert": {
      const existing = state.bills[p.id];
      const sponsor = existing ? existing.sponsor : p.sponsor;
      return memberScoped(state, sponsor, kid);
    }
    case "bill.retract":
      return recordScoped(state, "bills", p.id, "sponsor", kid);

    // Retracting a comment is moderation: comments are pseudonymous (no member
    // key to scope to), so deletion belongs to the chair, not to any member who
    // can name someone else's comment id.
    case "comment.retract":
      return chair || noChair;

    /* --- open / self-authenticating / low-stakes -------------------------- */
    case "id.announce":
    case "comment.post":
      return true;

    default:
      // Fail closed. applyOp only consults authorize() when a reducer EXISTS for
      // the type, so reaching here means a privileged reducer was added without
      // an authorisation rule — deny it rather than let it inherit a silent
      // allow. (Unknown future types have no reducer and never reach here; they
      // are kept in the log unfolded for forward-compatibility.) The invariant
      // is pinned by tests/authz-coverage.test.mjs.
      return false;
  }
}

export default authorize;
