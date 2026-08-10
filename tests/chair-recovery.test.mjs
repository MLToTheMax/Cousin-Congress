/**
 * chair-recovery.test.mjs — getting the gavel back.
 *
 * Two independent routes out of a lost Chair device, and the guardrails on each:
 *
 *   1. The Chair's password re-enrols a new device with nobody's permission.
 *      The proof is a signature made with a key that ONLY the password unwraps,
 *      so it survives the obvious attack: a hostile replica holds the whole
 *      record — including the salted password hash — and still cannot forge one.
 *
 *   2. If the password is gone too, two-thirds of the seated chamber may move
 *      the gavel — but only while the Chair is genuinely silent, and any act by
 *      the Chair cancels it outright.
 *
 * The succession half is a pure fold, so it is asserted here against handmade
 * op logs with explicit hybrid-logical-clock stamps. That matters: the dormancy
 * rule reads time out of the LOG rather than out of Date.now(), which is the
 * only way every replica reaches the same verdict from the same history.
 */

import { fold } from "../js/crdt.js";
import { authorize } from "../js/authz.js";
import { makeChairRecovery, proveChairRecovery, verifyChairRecovery } from "../js/crypto.js";

let failures = 0;
const assert = (n, c) => (c ? console.log(`ok  ${n}`) : (failures++, console.error(`FAIL ${n}`)));

const DAY = 86400000;
const T0 = 1700000000000;
const hlc = (ms, n, actor) => `${String(ms).padStart(15, "0")}:${String(n).padStart(5, "0")}:${actor}`;

/* ==========================================================================
   1. Password recovery
   ========================================================================== */

const ROOM = "cousins";
const rec = await makeChairRecovery("Pizza Friday");
const ctx = { room: ROOM, kid: "new-phone", ts: T0 };

assert("verifier carries no private key", !("priv" in rec) && Boolean(rec.pub) && Boolean(rec.wrapped));

const proof = await proveChairRecovery(rec, "Pizza Friday", ctx);
assert("the right password produces a proof", Boolean(proof));
assert("the proof verifies", await verifyChairRecovery(rec, proof, ctx));

assert(
  "passwords normalise like every other password here",
  Boolean(await proveChairRecovery(rec, "  PIZZA friday  ", ctx))
);

assert("the wrong password produces nothing", (await proveChairRecovery(rec, "nope", ctx)) === null);

/* The point of the whole design: the record is public to the chamber, and
   holding all of it must not be enough to mint a proof. */
const recordOnly = { v: 1, pub: rec.pub, salt: rec.salt, iv: rec.iv, wrapped: rec.wrapped };
assert(
  "a replica holding the entire record still cannot forge a proof",
  (await proveChairRecovery(recordOnly, "guess", ctx)) === null
);

/* A proof is bound to one device key, one room and one moment, so a proof
   overheard on the wire cannot be replayed to enrol somebody else's device. */
assert(
  "a proof cannot be re-aimed at another device key",
  (await verifyChairRecovery(rec, proof, { ...ctx, kid: "attacker-phone" })) === false
);
assert(
  "a proof cannot be replayed into another chamber",
  (await verifyChairRecovery(rec, proof, { ...ctx, room: "elsewhere" })) === false
);
assert(
  "a proof cannot be replayed at another moment",
  (await verifyChairRecovery(rec, proof, { ...ctx, ts: T0 + 1 })) === false
);

/* --- authorize() only lets a well-formed recovery through ----------------- */

const withVerifier = fold([
  { actor: "g", seq: 0, hlc: hlc(T0, 0, "g"), type: "member.upsert", payload: { id: "m-al", name: "Al" }, v: 2 },
  { actor: "old", seq: 0, hlc: hlc(T0, 1, "old"), type: "chair.claim", payload: { kid: "lost-device" }, v: 2, kid: "lost-device" },
  { actor: "old", seq: 1, hlc: hlc(T0, 2, "old"), type: "session.set", payload: { chairRecovery: rec }, v: 2, kid: "lost-device" },
]);

const recoverOp = (payload, kid) => ({
  actor: "me", seq: 1, hlc: hlc(T0 + DAY, 0, "me"), type: "chair.recover", payload, kid, v: 2,
});

assert(
  "recovery is authorised for the signer's own key",
  authorize(withVerifier, recoverOp({ kid: "new-phone", ts: T0, proof }, "new-phone"))
);
assert(
  "recovery cannot enrol somebody else's key",
  authorize(withVerifier, recoverOp({ kid: "victim", ts: T0, proof }, "new-phone")) === false
);
assert(
  "recovery without a proof is refused",
  authorize(withVerifier, recoverOp({ kid: "new-phone", ts: T0 }, "new-phone")) === false
);

const noVerifier = fold([
  { actor: "old", seq: 0, hlc: hlc(T0, 0, "old"), type: "chair.claim", payload: { kid: "lost-device" }, v: 2, kid: "lost-device" },
]);
assert(
  "a chamber with no verifier refuses recovery rather than waving it through",
  authorize(noVerifier, recoverOp({ kid: "new-phone", ts: T0, proof }, "new-phone")) === false
);

/* --- and the reducer actually hands over the key -------------------------- */

const recovered = fold(
  [recoverOp({ kid: "new-phone", ts: T0, proof }, "new-phone")],
  { ...withVerifier, session: { ...withVerifier.session, chairRequests: { "new-phone": { at: 1 } } } }
);
assert("recovery enrols the device", Boolean(recovered.session.chairKeys["new-phone"]));
assert("recovery clears that device's pending request", !recovered.session.chairRequests["new-phone"]);
assert("recovery leaves any surviving Chair device alone", Boolean(recovered.session.chairKeys["lost-device"]));

/* ==========================================================================
   2. Supermajority succession
   ========================================================================== */

const members = ["a", "b", "c", "d"].map((id, i) => ({
  actor: "g", seq: i, hlc: hlc(T0, i, "g"), type: "member.upsert",
  payload: { id, name: id.toUpperCase() }, v: 2,
}));
const keys = ["a", "b", "c", "d"].map((id, i) => ({
  actor: id, seq: 0, hlc: hlc(T0, 10 + i, id), type: "member.claimKey",
  payload: { memberId: id, kid: `k-${id}` }, v: 2, kid: `k-${id}`,
}));
const chairSetup = [
  { actor: "a", seq: 1, hlc: hlc(T0, 20, "a"), type: "chair.claim", payload: { kid: "k-a" }, v: 2, kid: "k-a" },
  { actor: "a", seq: 2, hlc: hlc(T0, 21, "a"), type: "session.set", payload: { chairSeat: "a" }, v: 2, kid: "k-a" },
];
const chamber = [...members, ...keys, ...chairSetup];

const petition = (by, at, seat = "b") => ({
  actor: by, seq: 90, hlc: hlc(at, 0, by), type: "chair.petition",
  payload: { seat, memberId: by }, kid: `k-${by}`, v: 2,
});

/* The Chair acted at T0. A supermajority the very next day must NOT carry —
   a Chair who is merely busy has not vacated anything. */
const soon = fold([...chamber, petition("b", T0 + DAY), petition("c", T0 + DAY), petition("d", T0 + DAY)]);
assert("an active Chair keeps the gavel against a supermajority", soon.session.chairSeat === "a");
assert("the endorsements are still recorded for later", Object.keys(soon.session.chairPetitions?.b || {}).length === 3);

/* The same three names, after a long silence, do carry. */
const LATE = T0 + 30 * DAY;
const late = fold([...chamber, petition("b", LATE), petition("c", LATE), petition("d", LATE)]);
assert("a dormant Chair can be replaced by two-thirds", late.session.chairSeat === "b");
assert(
  "the old Chair's device keys go with the gavel",
  Object.keys(late.session.chairKeys || {}).length === 0
);
assert("the succession is recorded", late.session.chairSuccession?.seat === "b");

/* Two of four is not two-thirds. */
const short = fold([...chamber, petition("b", LATE), petition("c", LATE)]);
assert("below two-thirds nothing moves", short.session.chairSeat === "a");

/* The Chair turning up at any point wipes the slate. */
const spoke = {
  actor: "a", seq: 99, hlc: hlc(LATE + 1000, 0, "a"), type: "status.post",
  payload: { id: "s9", memberId: "a", text: "still here" }, kid: "k-a", v: 2,
};
const cancelled = fold([...chamber, petition("b", LATE), petition("c", LATE), spoke]);
assert("any act by the Chair clears every petition", Object.keys(cancelled.session.chairPetitions || {}).length === 0);
assert("and the Chair keeps the gavel", cancelled.session.chairSeat === "a");

/* Nobody can stack the count by endorsing in a cousin's name. */
const forged = {
  actor: "b", seq: 91, hlc: hlc(LATE, 1, "b"), type: "chair.petition",
  payload: { seat: "b", memberId: "c" }, kid: "k-b", v: 2, // b signing as c
};
const stacked = fold([...chamber, petition("b", LATE), forged, petition("d", LATE)]);
assert("an endorsement in someone else's name is refused", stacked.session.chairSeat === "a");
assert(
  "and never reaches the tally",
  !Object.keys(stacked.session.chairPetitions?.b || {}).includes("c")
);

/* Withdrawing a name un-carries a petition that was one short of the line. */
const withdrawn = fold([
  ...chamber,
  petition("b", LATE),
  petition("c", LATE),
  { actor: "c", seq: 92, hlc: hlc(LATE, 5, "c"), type: "chair.unpetition", payload: { seat: "b", memberId: "c" }, kid: "k-c", v: 2 },
  petition("d", LATE),
]);
assert("a withdrawn name is not counted", withdrawn.session.chairSeat === "a");

console.log(
  failures
    ? `\n${failures} FAILURES`
    : "\nchair-recovery: password recovery is unforgeable, succession needs a supermajority AND a silent Chair"
);
process.exit(failures ? 1 : 0);
