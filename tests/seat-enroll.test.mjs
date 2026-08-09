/**
 * seat-enroll.test.mjs — Chair-approved seat devices.
 *
 * A second device on an already-claimed seat cannot bind itself (that is the
 * whole point of key-bound authority). Instead it files a request the Chair
 * approves, mirroring the chair-device request→approve flow. This pins that
 * path: a request grants nothing, only the Chair's enrol binds the key, and a
 * non-chair "enrol" is refused.
 */

import { Log } from "../js/crdt.js";

let failures = 0;
const assert = (n, c, e) => (c ? console.log(`ok  ${n}`) : (failures++, console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`)));

let seq = {};
const op = (kid, type, payload, t) => {
  const actor = kid;
  const s = (seq[actor] = (seq[actor] ?? -1) + 1);
  return { actor, seq: s, hlc: `${String(t ?? 1).padStart(15, "0")}:00000:${actor}`, type, payload, v: 2, kid, sig: "x" };
};
const play = (ops) => { const l = new Log(); l.insert(ops); return l.state; };

// Founded chair, seat m-al owned by the first device (oldK), vote open.
const base = [
  op("chairK", "chair.claim", { kid: "chairK" }, 1),
  op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
  op("oldK", "member.claimKey", { memberId: "m-al", kid: "oldK" }, 3),
  op("chairK", "vote.open", { id: "v1", threshold: "majority" }, 4),
];

// A second device (newK) requests the seat, then tries to vote before approval.
const requested = play([
  ...base,
  op("newK", "member.requestKey", { memberId: "m-al", kid: "newK", name: "Al's phone" }, 5),
  op("newK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "yea" }, 6),
]);
assert("a seat request is recorded as pending", requested.members["m-al"].pendingKeys?.newK);
assert("the requesting device is NOT yet a seat key", !requested.members["m-al"].keys?.newK);
assert("the un-approved device cannot vote the seat", requested.ballots["v1::m-al"] === undefined);

// The Chair approves; the device is enrolled and its request cleared.
const approved = play([
  ...base,
  op("newK", "member.requestKey", { memberId: "m-al", kid: "newK", name: "Al's phone" }, 5),
  op("chairK", "member.enrollKey", { memberId: "m-al", kid: "newK" }, 6),
  op("newK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "yea" }, 7),
]);
assert("Chair approval enrols the device as a seat key", approved.members["m-al"].keys?.newK);
assert("approval clears the pending request", !approved.members["m-al"].pendingKeys?.newK);
assert("the approved device's ballot now counts", approved.ballots["v1::m-al"]?.choice === "yea");

// A non-chair cannot enrol a device onto a seat.
const forged = play([
  ...base,
  op("evilK", "member.enrollKey", { memberId: "m-al", kid: "evilK" }, 5),
  op("evilK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "nay" }, 6),
]);
assert("a non-chair cannot enrol a seat device", !forged.members["m-al"].keys?.evilK);
assert("...so the forged enrol grants no vote", forged.ballots["v1::m-al"] === undefined);

// A request cannot smuggle a key bind (it only ever populates pendingKeys).
assert("member.requestKey never writes into keys", !requested.members["m-al"].keys?.newK);

console.log(failures ? `\n${failures} FAILURES` : "\nseat-enroll: requests are pending-only, only the Chair enrols, non-chair enrol refused");
process.exit(failures ? 1 : 0);
