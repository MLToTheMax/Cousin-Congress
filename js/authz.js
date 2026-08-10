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
const hasRecovery = (s) => Boolean(s?.session?.chairRecovery?.pub);

const memberScoped = (s, memberId, kid) =>
  isChairKey(s, kid) || ownsMember(s, memberId, kid) || !memberOwned(s, memberId);

/** Scope an op to the member named in a field of an existing record. */
function recordScoped(s, table, id, field, kid) {
  const rec = s[table] && s[table][id];
  if (!rec) return true; // nothing to protect yet
  return memberScoped(s, rec[field], kid);
}

/**
 * Scope a "create or post" op that is keyed by `payload.id`. If a record already
 * exists at that id, the op is OVERWRITING it, so authority is the EXISTING
 * record's owner (never the payload's freshly-claimed author) — otherwise a
 * member could clobber another member's status/note/grant by reusing its id.
 * A brand-new id is scoped to the claimed author as usual.
 */
function createScoped(s, table, id, ownerField, claimedAuthor, kid) {
  const rec = s[table] && s[table][id];
  if (!rec) return memberScoped(s, claimedAuthor, kid); // brand-new id
  // OVERWRITING an existing record. Authority is the existing owner — and this
  // must fail CLOSED when that owner is not a claimable member id. memberScoped
  // treats an unowned/unknown member as open (so a fresh seat can be claimed),
  // which is right for a seat but catastrophic here: an official Chair dispatch
  // has no member owner at all, so the lenient path let any member overwrite it
  // by reusing its id. Likewise a share owned by a display name or actor id.
  if (isChairKey(s, kid)) return true;
  const owner = rec[ownerField];
  if (!owner || !s.members[owner]) return false; // unowned/opaque -> chair only
  return ownsMember(s, owner, kid);
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

    case "chair.recover":
      // Recovery from a lost Chair device. Two things are checked here — that
      // the op enrols the SIGNER'S own key and nobody else's, and that the
      // chamber actually has a recovery verifier to check against. The proof
      // itself is verified in store.ingest, next to the op signatures, because
      // it needs WebCrypto and this function is deliberately synchronous.
      // Fail closed if either half is missing.
      return Boolean(p.kid) && p.kid === kid && Boolean(p.proof) && hasRecovery(state);

    case "chair.enroll":
    case "member.enrollKey":
    case "member.resetKeys":
      return chair; // administering others' keys is the chair's alone

    case "chair.petition":
    case "chair.unpetition": {
      // A cousin may only endorse in their OWN name, for a seat that exists,
      // and neither party may be a tombstone. member.retract merges
      // `_deleted: true` and leaves `keys` behind, so ownsMember() alone still
      // holds for a retracted seat — which let a cousin retract themselves and
      // keep voting. Whether the endorsement CARRIES is still the reducer's
      // decision, taken on every replica from the log alone.
      const live = (id) => Boolean(id && state.members?.[id] && !state.members[id]._deleted);
      return Boolean(p.memberId) && live(p.memberId) && live(p.seat) && ownsMember(state, p.memberId, kid);
    }

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
      return createScoped(state, "statuses", p.id, "memberId", p.memberId, kid);
    case "status.retract":
      return recordScoped(state, "statuses", p.id, "memberId", kid);

    case "cosponsor.add":
    case "cosponsor.remove":
      return memberScoped(state, p.memberId, kid);

    case "proxy.delegate":
    case "proxy.revoke":
      return memberScoped(state, p.memberId, kid);

    case "chat.post":
      return createScoped(state, "chat", p.id, "memberId", p.memberId, kid);
    case "chat.retract":
      return recordScoped(state, "chat", p.id, "memberId", kid);

    case "amendment.file":
      return createScoped(state, "amendments", p.id, "author", p.author, kid);
    case "amendment.withdraw":
      return recordScoped(state, "amendments", p.id, "author", kid);

    // Share authority is bound to the granting KEY, not to a member/actor string.
    // `by` was only ever a label (it can hold a memberId, an actorId, or a display
    // name), and memberScoped treats an unrecognised owner as unowned — so binding
    // to it let an unrelated member revoke someone else's live share, or resurrect
    // a revoked one by re-granting its id. `byKid` is the granter's fingerprint,
    // recorded by the reducer from the authenticated signer.
    case "share.grant": {
      const existing = state.shares[p.id];
      if (!existing) return memberScoped(state, p.by, kid); // a brand-new grant
      return isChairKey(state, kid) || existing.byKid === kid;
    }
    case "share.revoke": {
      const grant = state.shares[p.id];
      if (!grant) return true; // nothing to protect yet
      return isChairKey(state, kid) || grant.byKid === kid;
    }

    case "news.post":
      // A member's newsroom note is theirs; an official dispatch is the chair's.
      if (p.memberNote) return createScoped(state, "news", p.id, "authorId", p.authorId, kid);
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

    // Anyone already inside the room may RECORD what they observed connecting
    // (that is how the Chair learns about devices it never saw itself), but only
    // the Chair may bar one.
    case "device.seen":
      return true;
    case "device.revoke":
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
