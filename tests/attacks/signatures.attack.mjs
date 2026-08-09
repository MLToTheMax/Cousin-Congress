/**
 * signatures.attack.mjs — red-team harness against OP AUTHENTICATION.
 *
 * Targets:
 *   js/crypto.js : signOp / verifyOp / canonical / KeyDirectory
 *   js/schema.js : validateEnvelope
 *   js/crdt.js   : isValidOp / Log.insert / fold   (the ACTUAL ingest path)
 *   js/store.js  : ingest                          (what a transport calls)
 *
 * We NEVER modify a shipped module. Every scenario prints an explicit verdict:
 *   EXPLOITABLE  — we made the code do the wrong thing, proven by output
 *   THEORETICAL  — argued, not demonstrated end-to-end
 *   DEFENDED     — we tried and the code stopped us (a defence that held)
 *
 * Run:  node tests/attacks/signatures.attack.mjs
 */

import {
  Identity,
  KeyDirectory,
  signOp,
  verifyOp,
  canonical,
  b64,
  unb64,
  fingerprint,
} from "../../js/crypto.js";
import { validateEnvelope, isValidEnvelope } from "../../js/schema.js";
import {
  Log,
  isValidOp,
  fold,
  compareOps,
  select,
  emptyState,
  applyOp,
} from "../../js/crdt.js";

const te = new TextEncoder();
const line = "-".repeat(72);

const results = [];
function verdict(name, tag, detail) {
  results.push({ name, tag });
  console.log(`\n[${tag}] ${name}`);
  if (detail) console.log("   " + String(detail).replace(/\n/g, "\n   "));
}

// Honest wire: an op crosses the relay as JSON and comes back parsed. Using
// the raw in-process object would let us smuggle `undefined`/dup-key tricks a
// real relay could never carry, so we always round-trip through JSON.
const wire = (o) => JSON.parse(JSON.stringify(o));

const mkOp = (over = {}) => ({
  actor: "aaaa",
  seq: 0,
  hlc: "000000000000042:00001:aaaa",
  type: "status.post",
  payload: { text: "hello" },
  v: 2,
  ...over,
});

/* ========================================================================== */
/* 1. Signature transplant — across ops, and across actors.                   */
/* ========================================================================== */
async function transplant() {
  const alice = await Identity.generate("aaaa");
  const bob = await Identity.generate("bbbb");
  const dir = new KeyDirectory();
  await dir.learn("aaaa", alice.spki, { pinned: true });
  await dir.learn("bbbb", bob.spki, { pinned: true });

  const op1 = await signOp(alice, mkOp({ payload: { text: "one" } }));
  const op2base = mkOp({ payload: { text: "two — attacker rewrote me" } });

  // (a) same actor, keep op1's sig/kid, swap the body.
  const forgedA = wire({ ...op2base, sig: op1.sig, kid: op1.kid });
  const vA = await verifyOp(forgedA, dir);

  // (b) cross-actor: staple alice's sig onto an op that claims to be bob.
  const forgedB = wire({ ...mkOp({ actor: "bbbb", hlc: "000000000000042:00001:bbbb" }), sig: op1.sig, kid: op1.kid });
  const vB = await verifyOp(forgedB, dir);

  // (c) sanity: the genuine op still verifies.
  const vGood = await verifyOp(wire(op1), dir);

  const held = vGood.ok && !vA.ok && !vB.ok;
  verdict(
    "Signature transplant (same-actor body swap + cross-actor staple)",
    held ? "DEFENDED" : "EXPLOITABLE",
    `genuine op verifies: ${vGood.ok}\n` +
      `same-actor transplant: ${vA.ok} (${vA.reason})\n` +
      `cross-actor transplant: ${vB.ok} (${vB.reason})\n` +
      `=> sig is bound to (actor,seq,hlc,type,payload,v) AND to the directory key`
  );
}

/* ========================================================================== */
/* 2. Excluded fields — is dropping sig/kid from the signing input a lever?   */
/* ========================================================================== */
async function excludedFields() {
  const alice = await Identity.generate("aaaa");
  const dir = new KeyDirectory();
  await dir.learn("aaaa", alice.spki, { pinned: true });
  const op = await signOp(alice, mkOp());

  // opSigningInput covers {actor,seq,hlc,type,payload,v}. It excludes sig, kid,
  // and any extra top-level junk. Try to weaponise each exclusion.

  // (a) kid is excluded from the signature. Can we point it at a different key?
  //     verifyOp requires kid === directory.fingerprint(actor), and verifies
  //     with directory.publicKey — never with a key chosen by kid.
  const kidSwap = wire({ ...op, kid: "AAAAAAAAAAAAAAAAAAAAAA" });
  const vKid = await verifyOp(kidSwap, dir);

  // (b) inject unsigned top-level fields the reducers might read.
  const extra = wire({ ...op, room: "other-room", _actor: "victim", admin: true, priority: 9 });
  const vExtra = await verifyOp(extra, dir);
  // Do those extra fields change what gets folded? Reducers read only
  // type/actor/hlc/seq/payload — all signed. Confirm fold is unaffected.
  const foldedExtra = fold([extra]);
  const foldedClean = fold([wire(op)]);
  const sameState = JSON.stringify(foldedExtra) === JSON.stringify(foldedClean);

  const held = !vKid.ok && vExtra.ok && sameState;
  verdict(
    "Excluded-field abuse (kid pivot + unsigned extra fields)",
    held ? "DEFENDED" : "EXPLOITABLE",
    `kid pointed at a bogus fingerprint => ${vKid.ok} (${vKid.reason})  [kid is constrained to the directory key]\n` +
      `op carrying unsigned extra fields still verifies: ${vExtra.ok}\n` +
      `...but the reducers ignore them — folded state identical: ${sameState}\n` +
      `=> excluding sig/kid is sound; no unsigned field is load-bearing in a reducer`
  );
}

/* ========================================================================== */
/* 3. Canonicalisation collisions — can two DIFFERENT ops sign identically?   */
/* ========================================================================== */
async function canonicalCollisions() {
  // Enumerate the classic collision families and check reachability over the
  // JSON wire (JSON.stringify is what a real op is transmitted with).
  const cases = [];
  const check = (label, a, b, note) => {
    // A collision is only a forgery lever if it SURVIVES the honest JSON wire:
    // the two ops must (1) canonicalise identically AFTER a wire round-trip and
    // (2) still be two genuinely different ops on the wire. Testing the raw
    // in-process objects (before the wire) is the wrong question — an attacker
    // can only inject what a real relay can carry as JSON.
    const wa = wire(a), wb = wire(b);
    const ca = canonical(wa), cb = canonical(wb);
    const collideAfterWire = ca === cb;
    const distinctOnWire = JSON.stringify(wa) !== JSON.stringify(wb);
    const reachable = collideAfterWire && distinctOnWire;
    cases.push({ label, ca, cb, collide: collideAfterWire, distinctOnWire, reachable, note });
  };

  check("array [undefined] vs []", { p: [undefined] }, { p: [] },
    "collides in canonical, but JSON.stringify turns [undefined] into [null] -> not wire-reachable");
  check("object undefined-value vs missing", { a: undefined, b: 1 }, { b: 1 },
    "collides, but both round-trip to the SAME wire bytes -> not two distinct ops");
  check("-0 vs 0", { n: -0 }, { n: 0 },
    "collides; -0 and 0 are the same JS value once parsed -> semantically identical");
  check("2^53+1 vs 2^53", { n: 9007199254740993 }, { n: 9007199254740992 },
    "'different' literals are the SAME float -> not two distinct ops");
  check("unicode NFC pair (\\u00e9 vs e+\\u0301)", { s: "é" }, { s: "é" },
    "canonical does NOT normalise -> distinct signing input -> no collision");
  check("dup keys {a:1,a:2}", JSON.parse('{"a":1,"a":2}'), { a: 2 },
    "JSON.parse already collapsed the duplicate before signing -> single object");

  // A pair is dangerous only if it collides AFTER the wire while remaining two
  // distinct ops on the wire.
  const dangerous = cases.filter((c) => c.reachable);

  for (const c of cases) {
    console.log(
      `   post-wire ${c.collide ? "COLLIDE " : "distinct"} | wire-distinct:${c.distinctOnWire ? "Y" : "n"} | reachable:${c.reachable ? "YES" : "no"} | ${c.label}`
    );
  }
  verdict(
    "Canonicalisation collisions (two logical ops, one signing input)",
    dangerous.length ? "EXPLOITABLE" : "DEFENDED",
    dangerous.length
      ? `reachable collision(s): ${dangerous.map((d) => d.label).join(", ")}`
      : `every collision family is either not wire-reachable as two distinct ops,\n` +
          `or is the same value. canonical() is sound for JSON-wire inputs.`
  );
}

/* ========================================================================== */
/* 4. Schema-version relabel — force a migration on a signed op.              */
/* ========================================================================== */
async function versionRelabel() {
  const alice = await Identity.generate("aaaa");
  const dir = new KeyDirectory();
  await dir.learn("aaaa", alice.spki, { pinned: true });
  const op = await signOp(alice, mkOp({ v: 2 }));

  // Flip v to trigger a different converter chain while keeping the signature.
  const bumped = wire({ ...op, v: 3 });
  const vBump = await verifyOp(bumped, dir);
  // Strip v entirely (relabel v2 -> v1 "legacy/grandfathered").
  const stripped = wire({ ...op });
  delete stripped.v;
  const vStrip = await verifyOp(stripped, dir);

  const held = !vBump.ok && !vStrip.ok;
  verdict(
    "Schema-version relabel of a signed op (v2->v3, v2->v1)",
    held ? "DEFENDED" : "EXPLOITABLE",
    `v bumped to 3: ${vBump.ok} (${vBump.reason})\n` +
      `v stripped (->legacy v1): ${vStrip.ok} (${vStrip.reason})\n` +
      `=> 'v' is inside opSigningInput; changing it changes the signed bytes`
  );
}

/* ========================================================================== */
/* 5. TOFU poisoning / key-rotation abuse in KeyDirectory.                    */
/* ========================================================================== */
async function tofuPoison() {
  // Two identities that both LABEL themselves actor "cousin-jo". One honest,
  // one the attacker's. This models a TOFU (unpinned) peer learned from gossip.
  const honest = await Identity.generate("cousin-jo");
  const evil = await Identity.generate("cousin-jo");

  const dir = new KeyDirectory();
  await dir.learn("cousin-jo", honest.spki);          // TOFU, unpinned
  const before = dir.get("cousin-jo").fingerprint === honest.fingerprint;

  // Attacker announces a *different* key for the same actor. The comment in
  // crypto.js claims "A key that changes for an actor we already know is never
  // silently accepted." Test it.
  await dir.learn("cousin-jo", evil.spki);            // conflicting announcement
  const nowEvil = dir.get("cousin-jo").fingerprint === evil.fingerprint;
  const conflictLogged = dir.conflicts.length === 1;

  // Now the attacker signs a forged op as cousin-jo and asks verifyOp.
  const forged = await signOp(
    evil,
    mkOp({
      actor: "cousin-jo",
      hlc: "000000000000999:00001:cousin-jo",
      type: "announce.post",
      payload: { id: "a1", text: "RECESS: everyone go home (forged)" },
    })
  );
  const v = await verifyOp(wire(forged), dir);

  const broken = before && nowEvil && v.ok;
  verdict(
    "TOFU poisoning / key-rotation: replace an unpinned actor's key",
    broken ? "EXPLOITABLE" : "DEFENDED",
    `honest key learned first: ${before}\n` +
      `after attacker's conflicting learn(), directory key is EVIL: ${nowEvil}\n` +
      `conflict was logged (event only, not blocking): ${conflictLogged}\n` +
      `verifyOp on the attacker's forged op => ok:${v.ok}${v.reason ? " (" + v.reason + ")" : ""}\n` +
      `=> learn() is last-writer-wins for unpinned actors: it OVERWRITES the\n` +
      `   stored key on conflict and only fires a 'conflict' event. verifyOp\n` +
      `   then authenticates the attacker's ops as cousin-jo.`
  );

  // Contrast: a PINNED actor (fingerprint came from the pairing code).
  const pinnedDir = new KeyDirectory();
  await pinnedDir.learn("cousin-jo", honest.spki, { pinned: true });
  await pinnedDir.learn("cousin-jo", evil.spki);      // attacker tries to override
  const stillHonest = pinnedDir.get("cousin-jo").fingerprint === honest.fingerprint;
  const vPinned = await verifyOp(wire(forged), pinnedDir);
  verdict(
    "Pinned-key override attempt (pairing-code peer)",
    stillHonest && !vPinned.ok ? "DEFENDED" : "EXPLOITABLE",
    `pinned key survived the override: ${stillHonest}\n` +
      `forged op against pinned dir => ok:${vPinned.ok} (${vPinned.reason})\n` +
      `=> pinning (pairing code) is the only thing that makes TOFU real here.`
  );
}

/* ========================================================================== */
/* 6. THE BIG ONE — signatures are never checked in the ingest/fold path.     */
/* ========================================================================== */
async function noVerificationInDataPath() {
  // store.ingest() -> Log.insert() gate ops with crdt.isValidOp (STRUCTURAL
  // only). verifyOp / KeyDirectory / validateEnvelope are never invoked on a
  // replicated op anywhere outside the test suite. Prove an unsigned, forged
  // op is folded into materialised state.

  // A totally unsigned op that impersonates the genesis author and rewrites a
  // real bill's stage. No key, no sig, no kid.
  const forged = {
    actor: "genesis",
    seq: 999999,
    hlc: "999999999999999:99999:genesis", // max HLC => wins every LWW merge
    type: "bill.stage",
    payload: { billId: "hr-1", stage: "LAW", stageNote: "signed by nobody" },
  };

  console.log("   verifyOp would need a key; directory is empty. But nobody calls it.");
  console.log("   isValidOp(forged) =", isValidOp(forged), "  <- the only gate the fold path applies");
  console.log("   validateEnvelope(forged) =", JSON.stringify(validateEnvelope(forged)),
    " <- would reject, but is NOT on the path");

  const log = new Log();
  // seed a legitimate-looking bill first
  log.insert([
    { actor: "genesis", seq: 0, hlc: "000000000000001:00000:genesis", type: "bill.upsert",
      payload: { id: "hr-1", title: "A Real Bill", stage: "introduced" } },
  ]);
  const before = log.state.bills["hr-1"].stage;
  const accepted = log.insert([forged]);
  const after = log.state.bills["hr-1"].stage;

  const pwned = accepted.length === 1 && after === "LAW";
  verdict(
    "Unsigned/forged op folded by Log.insert (no signature check on the path)",
    pwned ? "EXPLOITABLE" : "DEFENDED",
    `bill hr-1 stage before: "${before}"  after forged op: "${after}"\n` +
      `Log.insert accepted the forged op: ${accepted.length === 1}\n` +
      `=> the replication path (sync.js -> store.ingest -> Log.insert) authenticates\n` +
      `   NOTHING. isValidOp is purely structural; verifyOp is dead code outside tests.`
  );
}

/* ========================================================================== */
/* 7. HLC-actor-mismatch guard exists in schema, bypassed in the fold path.   */
/* ========================================================================== */
async function hlcActorSpoof() {
  // validateEnvelope forbids an hlc whose actor component != op.actor, exactly
  // to stop "borrowing someone else's identity for tie-breaking." The fold
  // path (isValidOp) does not enforce it, so an attacker sets the HLC actor to
  // a fast-clock victim and still wins ordering.
  const spoof = {
    actor: "attacker",
    seq: 0,
    hlc: "999999999999999:99999:chair", // claims the chair's clock lane
    type: "vote.close",
    payload: { id: "v-42", result: "FAILED (forced by attacker)" },
  };
  const schemaSays = validateEnvelope(spoof);
  const pathSays = isValidOp(spoof);

  // Show it actually wins a merge against an honest close.
  const honest = {
    actor: "chair", seq: 3, hlc: "000000000000500:00000:chair", type: "vote.close",
    payload: { id: "v-42", result: "PASSED" },
  };
  const st = fold([
    { actor: "chair", seq: 0, hlc: "000000000000001:00000:chair", type: "vote.open", payload: { id: "v-42" } },
    honest, spoof,
  ]);
  const winner = st.votes["v-42"].result;

  const bypassed = schemaSays !== null && pathSays === true && winner.startsWith("FAILED");
  verdict(
    "HLC-actor spoof: schema guard bypassed by the fold path",
    bypassed ? "EXPLOITABLE" : "DEFENDED",
    `validateEnvelope(spoof) => ${JSON.stringify(schemaSays)}  (would reject)\n` +
      `isValidOp(spoof)        => ${pathSays}  (the actual gate accepts it)\n` +
      `folded vote result      => "${winner}"\n` +
      `=> attacker forges a maximal HLC in someone else's clock lane and wins LWW.`
  );
}

/* ========================================================================== */
/* 8. Cross-room replay — the signature binds no room.                        */
/* ========================================================================== */
async function crossRoomReplay() {
  // opSigningInput = {actor,seq,hlc,type,payload,v}. There is no room/channel
  // id anywhere in the signed bytes, and the fold path has no room concept.
  // An op authored/captured in room "family-A" is a byte-valid, verifying op
  // in room "family-B" for the same identity.
  const alice = await Identity.generate("aaaa");
  const roomA = new KeyDirectory();
  const roomB = new KeyDirectory();
  await roomA.learn("aaaa", alice.spki, { pinned: true });
  await roomB.learn("aaaa", alice.spki, { pinned: true }); // same person, other room

  const op = await signOp(alice, mkOp({ type: "announce.post", payload: { id: "x", text: "in room A only" } }));
  const vA = await verifyOp(wire(op), roomA);
  const vB = await verifyOp(wire(op), roomB); // replayed into room B

  const replays = vA.ok && vB.ok;
  verdict(
    "Cross-room replay (no room binding in the signature)",
    replays ? "EXPLOITABLE" : "DEFENDED",
    `signing input contains: actor,seq,hlc,type,payload,v  (no room/channel)\n` +
      `verifies in room A: ${vA.ok}\n` +
      `same op verifies in room B: ${vB.ok}\n` +
      `=> a captured op is authentic in any room the identity is known in;\n` +
      `   nothing in the op or the fold path scopes it to a room.`
  );
}

/* ========================================================================== */
/* 9. Signature malleability — does it buy a duplicate/replacement op?        */
/* ========================================================================== */
async function malleability() {
  // ECDSA is malleable: (r,s) and (r, n-s) both verify. If op identity or
  // dedup keyed on the signature bytes, that would be a lever. It keys on
  // actor:seq instead, so a re-signed byte string is deduped to the same op.
  const alice = await Identity.generate("aaaa");
  const dir = new KeyDirectory();
  await dir.learn("aaaa", alice.spki, { pinned: true });
  const op = await signOp(alice, mkOp());

  const log = new Log();
  const a1 = log.insert([wire(op)]);
  // Second copy with a mangled-but-irrelevant sig (dedup is by actor:seq).
  const a2 = log.insert([wire({ ...op, sig: op.sig.slice(0, -2) + "AA" })]);

  const deduped = a1.length === 1 && a2.length === 0 && log.size === 1;
  verdict(
    "Signature malleability -> duplicate op",
    deduped ? "DEFENDED" : "EXPLOITABLE",
    `first insert accepted: ${a1.length === 1}\n` +
      `second insert (different sig bytes) accepted: ${a2.length === 1}  (log size ${log.size})\n` +
      `=> opId is actor:seq, independent of sig; a re-signed copy is a no-op replay.`
  );
}

/* ========================================================================== */
/* main                                                                       */
/* ========================================================================== */
console.log(line);
console.log("OP-AUTHENTICATION RED TEAM — signatures.attack.mjs");
console.log(line);

await transplant();
await excludedFields();
await canonicalCollisions();
await versionRelabel();
await tofuPoison();
await noVerificationInDataPath();
await hlcActorSpoof();
await crossRoomReplay();
await malleability();

console.log("\n" + line);
console.log("SUMMARY");
console.log(line);
for (const r of results) console.log(`  ${r.tag.padEnd(12)} ${r.name}`);
const exploit = results.filter((r) => r.tag === "EXPLOITABLE").length;
const defended = results.filter((r) => r.tag === "DEFENDED").length;
console.log(`\n  EXPLOITABLE: ${exploit}   DEFENDED: ${defended}   total: ${results.length}`);
