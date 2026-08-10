/**
 * redteam-round7.test.mjs — the round-7 findings, pinned.
 *
 * Six defects survived two independent skeptics each. Five of the six were in
 * code written the same week, and the pattern they share is worth naming: none
 * of them was a broken primitive. The cryptography held everywhere it was
 * attacked. What failed was the plumbing AROUND the trust boundary — a second
 * code path that forgot a check, a tally whose numerator and denominator were
 * measured at different times, a clock the fold trusted from the wire, and a
 * sanitiser applied to the wrong grammar.
 *
 * Each test below is that specific attack, run against the real modules.
 */

import { fold } from "../js/crdt.js";
import { authorize } from "../js/authz.js";
import { hashPin, verifyPin, makeAuth } from "../js/auth.js";
import { cls } from "../js/ui.js";

let failures = 0;
const assert = (n, c) => (c ? console.log(`ok  ${n}`) : (failures++, console.error(`FAIL ${n}`)));

const DAY = 86400000;
const NOW = Date.now();
const hlc = (ms, n, actor) => `${String(ms).padStart(15, "0")}:${String(n).padStart(5, "0")}:${actor}`;

/* ==========================================================================
   C2 — the succession tally: historical numerator, live denominator
   ========================================================================== */

/** A chamber of `n` seats, each bound to its own key, with `chair` holding the gavel. */
function chamber(n, { chairSeat = "m0" } = {}) {
  const ops = [];
  for (let i = 0; i < n; i += 1) {
    ops.push({ actor: "g", seq: i, hlc: hlc(NOW - 90 * DAY, i, "g"), type: "member.upsert", payload: { id: `m${i}`, name: `M${i}` }, v: 2 });
    ops.push({ actor: `m${i}`, seq: 0, hlc: hlc(NOW - 90 * DAY, 100 + i, `m${i}`), type: "member.claimKey", payload: { memberId: `m${i}`, kid: `k${i}` }, v: 2, kid: `k${i}` });
  }
  ops.push({ actor: chairSeat, seq: 1, hlc: hlc(NOW - 90 * DAY, 900, chairSeat), type: "chair.claim", payload: { kid: "k0" }, v: 2, kid: "k0" });
  ops.push({ actor: chairSeat, seq: 2, hlc: hlc(NOW - 90 * DAY, 901, chairSeat), type: "session.set", payload: { chairSeat }, v: 2, kid: "k0" });
  return ops;
}

const petition = (by, seat, at, seq = 50) => ({
  actor: by, seq, hlc: hlc(at, seq, by), type: "chair.petition",
  payload: { seat, memberId: by }, kid: by.replace("m", "k"), v: 2,
});
/** A cousin retiring their own seat — signed by that seat's own key. */
const retract = (id, at, seq = 60) => ({
  actor: id, seq, hlc: hlc(at, seq, id), type: "member.retract",
  payload: { id }, kid: id.replace("m", "k"), v: 2,
});

const LATE = NOW; // the Chair has been silent ~90 days in these fixtures

/* The attack: bank endorsements from seats you control, retract those seats to
   shrink the denominator, and the banked names carry a chamber that never
   agreed. The numerator has to be recounted against the live roster. */
{
  const base = chamber(6);
  // m1 endorses, then m2 and m3 endorse, then m2 and m3 are retracted.
  const ops = [
    ...base,
    petition("m1", "m1", LATE, 50),
    petition("m2", "m1", LATE, 51),
    petition("m3", "m1", LATE, 52),
    retract("m2", LATE, 61),
    retract("m3", LATE, 62),
    // one more endorsement re-runs the carry test with a shrunken denominator
    petition("m4", "m1", LATE, 63),
  ];
  const st = fold(ops);
  assert(
    "retracted backers cannot carry a succession as the roster shrinks",
    st.session.chairSeat === "m0"
  );
  assert(
    "the audit record is not written on a tally that did not carry",
    !st.session.chairSuccession
  );
}

/* The honest path still works: enough LIVE cousins, and a silent Chair. */
{
  const st = fold([
    ...chamber(4),
    petition("m1", "m1", LATE, 50),
    petition("m2", "m1", LATE, 51),
    petition("m3", "m1", LATE, 52),
  ]);
  assert("a genuine live supermajority still carries", st.session.chairSeat === "m1");
  assert("and records who carried it", st.session.chairSuccession?.backers === 3);
}

/* A backer whose key was reset no longer counts — standing is current, not historical. */
{
  const base = chamber(6);
  const st = fold([
    ...base,
    petition("m1", "m1", LATE, 50),
    petition("m2", "m1", LATE, 51),
    petition("m3", "m1", LATE, 52),
    // the Chair resets m2's and m3's devices; their endorsements lose their key
    { actor: "m0", seq: 70, hlc: hlc(LATE, 70, "m0"), type: "member.resetKeys", payload: { memberId: "m2" }, kid: "k0", v: 2 },
    { actor: "m0", seq: 71, hlc: hlc(LATE, 71, "m0"), type: "member.resetKeys", payload: { memberId: "m3" }, kid: "k0", v: 2 },
    petition("m4", "m1", LATE, 72),
  ]);
  assert("an endorsement whose key was reset stops counting", st.session.chairSeat === "m0");
}

/* authz refuses a tombstoned cousin endorsing, and refuses endorsing INTO a tombstone. */
{
  const st = fold([...chamber(4), retract("m3", LATE, 61)]);
  assert(
    "a retracted cousin may not endorse",
    authorize(st, { actor: "m3", seq: 9, hlc: hlc(LATE, 80, "m3"), type: "chair.petition", payload: { seat: "m1", memberId: "m3" }, kid: "k3", v: 2 }) === false
  );
  assert(
    "the gavel may not be handed to a retracted seat",
    authorize(st, { actor: "m1", seq: 9, hlc: hlc(LATE, 81, "m1"), type: "chair.petition", payload: { seat: "m3", memberId: "m1" }, kid: "k1", v: 2 }) === false
  );
}

/* ==========================================================================
   C3 — session.set must not be able to write the fold's own bookkeeping
   ========================================================================== */

{
  const base = chamber(4);
  const poisoned = fold([
    ...base,
    {
      actor: "m0", seq: 80, hlc: hlc(NOW, 80, "m0"), type: "session.set", kid: "k0", v: 2,
      payload: {
        title: "Legitimate setting",
        lastOpAt: 4102444800000,       // year 2100: "the Chair has been silent for 74 years"
        chairLastSeen: 4102444800000,  // or the reverse: "the Chair is eternally present"
        chairPetitions: { m1: { m2: {}, m3: {} } },
        chairKeys: { evil: { actor: "evil" } },
        chairSuccession: { seat: "evil" },
      },
    },
  ]);
  assert("session.set may still write ordinary settings", poisoned.session.title === "Legitimate setting");
  assert("session.set cannot write lastOpAt", poisoned.session.lastOpAt !== 4102444800000);
  assert("session.set cannot write chairLastSeen", poisoned.session.chairLastSeen !== 4102444800000);
  assert("session.set cannot stuff the petition book", !poisoned.session.chairPetitions?.m1);
  assert("session.set cannot smuggle in a chair key", !poisoned.session.chairKeys?.evil);
  assert("session.set cannot forge a succession record", poisoned.session.chairSuccession?.seat !== "evil");

  // chairSeat stays settable — it is how founding binds the gavel to a seat.
  const founded = fold([
    { actor: "a", seq: 0, hlc: hlc(NOW, 0, "a"), type: "member.upsert", payload: { id: "a", name: "A" }, v: 2 },
    { actor: "a", seq: 1, hlc: hlc(NOW, 1, "a"), type: "chair.claim", payload: { kid: "ka" }, kid: "ka", v: 2 },
    { actor: "a", seq: 2, hlc: hlc(NOW, 2, "a"), type: "session.set", payload: { chairSeat: "a" }, kid: "ka", v: 2 },
  ]);
  assert("founding can still bind the gavel to a seat", founded.session.chairSeat === "a");
}

/* ==========================================================================
   H2 — one password must not have two verifiers at two different costs
   ========================================================================== */

{
  const auth = await makeAuth("pizza friday");
  assert("new passwords are stretched, not merely hashed", auth.hash.startsWith("p:"));
  assert("the right password verifies", await verifyPin("pizza friday", auth));
  assert("the wrong password does not", (await verifyPin("nope", auth)) === false);
  assert("passwords still normalise", await verifyPin("  PIZZA Friday ", auth));

  // A chamber founded before this change keeps working: the algorithm rides in
  // the prefix, so old hashes verify with the algorithm that made them.
  const legacy = { salt: auth.salt, hash: await hashPin("pizza friday", auth.salt, "s") };
  assert("a legacy single-SHA hash still verifies", await verifyPin("pizza friday", legacy));
  assert("and still rejects the wrong password", (await verifyPin("nope", legacy)) === false);
  assert("the two algorithms produce different hashes", legacy.hash !== auth.hash);
}

/* ==========================================================================
   H3 / M1 — member text must never reach a class attribute
   ========================================================================== */

{
  assert("a space cannot start a new class token", cls("away frozen-overlay") === "awayfrozen-overlay");
  assert("nor a tab or newline", cls("away\tfrozen-overlay\nx") === "awayfrozen-overlayx");
  assert("quotes and brackets are stripped", cls('a"><script>') === "ascript");
  assert("ordinary tokens survive intact", cls("present") === "present");
  assert("hyphens and underscores are legal in a class", cls("badge--live_1") === "badge--live_1");
  assert("null and undefined are empty, not the string", cls(null) === "" && cls(undefined) === "");
}

console.log(
  failures
    ? `\n${failures} FAILURES`
    : "\nredteam-round7: succession counts live standing, session.set cannot write the clock, passwords cost the same everywhere, class attributes are sanitised"
);
process.exit(failures ? 1 : 0);
