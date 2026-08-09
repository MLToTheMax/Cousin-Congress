/**
 * authz-fold.test.mjs — the in-room confused-deputy, closed at the fold.
 *
 * The room MAC stops a NON-member (a relay). This suite proves the second half:
 * a genuine in-room member — one that holds the room secret and signs its own
 * ops perfectly well — still cannot act as a DIFFERENT member or as the chair,
 * because authorisation is bound to the authenticated key in state, checked
 * deterministically at fold time.
 *
 * It drives the real Log/fold (crdt.js) with ops carrying explicit `kid`s, so
 * it tests authorize() exactly as applyOp() invokes it, and it checks the
 * property that makes fold-time authorisation sound: the result is identical no
 * matter what order the ops arrive in.
 */

import { Log, fold } from "../js/crdt.js";

let failures = 0;
const ok = (n) => console.log(`ok  ${n}`);
const bad = (n, e = "") => {
  failures += 1;
  console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`);
};
const assert = (n, c, e) => (c ? ok(n) : bad(n, e));

let seqByActor = {};
/** Build a signed-looking op. `t` is a small integer "time" for HLC ordering. */
function op(kid, type, payload, t) {
  const actor = kid; // one replica per key in these tests
  const seq = (seqByActor[actor] = (seqByActor[actor] ?? -1) + 1);
  const ms = String(t ?? 1).padStart(15, "0");
  return { actor, seq, hlc: `${ms}:00000:${actor}`, type, payload, v: 2, kid, sig: "x" };
}
const reset = () => (seqByActor = {});

/** Fold via a Log (idempotent insert + HLC order + refold), like the store. */
function play(ops) {
  const log = new Log();
  log.insert(ops);
  return log.state;
}

/* ========================================================================= */
/* 1. In-room member cannot cast another seat's ballot (PoC 1, in-room)      */
/* ========================================================================= */
{
  reset();
  const ops = [
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    op("chairK", "member.upsert", { id: "m-bo", name: "Bo" }, 3),
    op("alK", "member.claimKey", { memberId: "m-al", kid: "alK" }, 4),
    op("boK", "member.claimKey", { memberId: "m-bo", kid: "boK" }, 5),
    op("chairK", "vote.open", { id: "v1", threshold: "majority" }, 6),
    // Al votes their own seat — allowed.
    op("alK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "yea" }, 7),
    // Bo (a real, in-room member) tries to cast AL's ballot — must be refused,
    // even though Bo's op is otherwise perfectly valid.
    op("boK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "nay" }, 8),
  ];
  const s = play(ops);
  assert("Al's own ballot is recorded", s.ballots["v1::m-al"]?.choice === "yea");
  assert("Bo cannot overwrite Al's ballot (confused-deputy closed)", s.ballots["v1::m-al"]?.choice === "yea", `got ${s.ballots["v1::m-al"]?.choice}`);
  // Bo CAN cast Bo's own.
  const s2 = play([...ops, op("boK", "ballot.cast", { voteId: "v1", memberId: "m-bo", choice: "nay" }, 9)]);
  assert("Bo can cast Bo's own ballot", s2.ballots["v1::m-bo"]?.choice === "nay");
}

/* ========================================================================= */
/* 2. Only a chair key may run the chamber (PoC 2, in-room)                  */
/* ========================================================================= */
{
  reset();
  const base = [
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
  ];
  // A non-chair member tries chair-only ops.
  const s = play([
    ...base,
    op("alK", "member.claimKey", { memberId: "m-al", kid: "alK" }, 3),
    op("alK", "session.set", { locked: true, chairAuth: { salt: "x", hash: "s:ATTACKER" } }, 4),
    op("alK", "vote.open", { id: "v9", threshold: "majority" }, 5),
    op("alK", "member.presence", { memberId: "m-al", frozen: true, role: "Speaker" }, 6),
  ]);
  assert("non-chair cannot lock the chamber", !s.session.locked);
  assert("non-chair cannot overwrite the gavel password", s.session.chairAuth === undefined);
  assert("non-chair cannot open a vote", s.votes.v9 === undefined);
  assert("non-chair cannot self-promote to a chair-only role", s.members["m-al"].role !== "Speaker");
  // The chair can do all of these.
  const s2 = play([
    ...base,
    op("chairK", "session.set", { locked: true }, 4),
    op("chairK", "vote.open", { id: "v9", threshold: "majority" }, 5),
  ]);
  assert("the chair can lock the chamber", s2.session.locked === true);
  assert("the chair can open a vote", s2.votes.v9 !== undefined);
}

/* ========================================================================= */
/* 3. Chair founding is first-writer-wins (lowest HLC)                        */
/* ========================================================================= */
{
  reset();
  // Two devices both try to found the chair. The earlier (lower HLC) wins on
  // every replica; the later claim is refused and cannot do chair ops.
  const ops = [
    op("earlyK", "chair.claim", { kid: "earlyK" }, 2),
    op("lateK", "chair.claim", { kid: "lateK" }, 5),
    op("lateK", "session.set", { sitting: 99 }, 6),
    op("earlyK", "session.set", { sitting: 7 }, 7),
  ];
  const s = play(ops);
  assert("the earliest claim founds the chair", s.session.chairKeys?.earlyK && !s.session.chairKeys?.lateK);
  assert("the later founder's chair op is refused", s.session.sitting === 7, `sitting=${s.session.sitting}`);
}

/* ========================================================================= */
/* 4. A claimKey cannot bind a key other than its own signer                 */
/* ========================================================================= */
{
  reset();
  const s = play([
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    // evilK signs a claimKey but names alK as the key to bind — refused.
    op("evilK", "member.claimKey", { memberId: "m-al", kid: "alK" }, 3),
  ]);
  assert("a claimKey binding a foreign key is refused", !s.members["m-al"].keys || Object.keys(s.members["m-al"].keys).length === 0);
}

/* ========================================================================= */
/* 5. Chair recovery: resetKeys lets a new device re-claim a seat            */
/* ========================================================================= */
{
  reset();
  const s = play([
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    op("oldK", "member.claimKey", { memberId: "m-al", kid: "oldK" }, 3),
    // Al lost the old device. The chair clears the seat's keys...
    op("chairK", "member.resetKeys", { memberId: "m-al" }, 4),
    // ...and Al re-claims on a new device.
    op("newK", "member.claimKey", { memberId: "m-al", kid: "newK" }, 5),
    op("chairK", "vote.open", { id: "v1", threshold: "majority" }, 6),
    op("newK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "yea" }, 7),
    // The old (possibly stolen) device can no longer vote the seat.
    op("oldK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "nay" }, 8),
  ]);
  assert("after reset+re-claim the new device owns the seat", s.members["m-al"].keys?.newK && !s.members["m-al"].keys?.oldK);
  assert("the new device's ballot counts", s.ballots["v1::m-al"]?.choice === "yea");
  const nonChairReset = play([
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    op("oldK", "member.claimKey", { memberId: "m-al", kid: "oldK" }, 3),
    op("evilK", "member.resetKeys", { memberId: "m-al" }, 4), // not the chair
  ]);
  assert("a non-chair cannot reset a seat's keys", nonChairReset.members["m-al"].keys?.oldK);
}

/* ========================================================================= */
/* 6. Convergence: order of arrival does not change the folded state         */
/* ========================================================================= */
{
  reset();
  const ops = [
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    op("alK", "member.claimKey", { memberId: "m-al", kid: "alK" }, 3),
    op("chairK", "vote.open", { id: "v1", threshold: "majority" }, 4),
    op("alK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "yea" }, 5),
    op("boK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "nay" }, 6), // unauthorised
  ];
  const forward = JSON.stringify(play(ops));
  const reversed = JSON.stringify(play([...ops].reverse()));
  // The classic hazard: a ballot delivered BEFORE the claim that authorises it.
  const shuffled = JSON.stringify(play([ops[5], ops[4], ops[3], ops[2], ops[1], ops[0]]));
  assert("folded state is identical in reverse order", forward === reversed);
  assert("ballot arriving before its claim still converges", forward === shuffled);
  assert("the unauthorised ballot never took effect", play(ops).ballots["v1::m-al"]?.choice === "yea");
}

/* ========================================================================= */
/* 7. session.set cannot smuggle chair keys in through a wholesale merge     */
/* ========================================================================= */
{
  reset();
  const s = play([
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    // The chair itself tries to set chairKeys via session.set — the reducer
    // strips it, so chair enrolment can only ever happen through chair.enroll.
    op("chairK", "session.set", { chairKeys: { evilK: { actor: "evilK" } }, sitting: 3 }, 2),
  ]);
  assert("session.set cannot write chairKeys", !s.session.chairKeys?.evilK);
  assert("session.set's other fields still apply", s.session.sitting === 3);
}

console.log(
  failures
    ? `\n${failures} FAILURES`
    : "\nauthz-fold: confused-deputy closed, chair first-writer-wins, recovery works, authorisation converges"
);
process.exit(failures ? 1 : 0);
