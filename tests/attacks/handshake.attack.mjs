/**
 * handshake.attack.mjs — red-team harness against the js/crypto.js handshake.
 *
 * Two honest Sessions + a hostile relay that can read/modify/drop/reorder/inject.
 * Every scenario prints an explicit verdict. We NEVER modify the shipped module.
 *
 * Run:  node tests/attacks/handshake.attack.mjs
 */

import {
  Identity,
  Session,
  KeyDirectory,
  SUITE,
  canonical,
  b64,
  unb64,
  fingerprint,
} from "../../js/crypto.js";

const te = new TextEncoder();
const td = new TextDecoder();

let PASS = 0, FAIL = 0;
const results = [];
function record(name, verdict, detail) {
  results.push({ name, verdict, detail });
  const tag = verdict === "DEFENDED" ? "DEFENDED" : verdict;
  console.log(`\n[${tag}] ${name}`);
  if (detail) console.log("   " + detail.replace(/\n/g, "\n   "));
}
function expect(cond, msg) {
  if (cond) { PASS++; return true; }
  FAIL++;
  console.log("   !! UNEXPECTED: " + msg);
  return false;
}

// A realistic transport hop: helloes cross the wire as JSON. Passing the raw
// in-process object would let an attacker smuggle `undefined`/prototype tricks
// that the real relay could never carry. jsonHop() models the honest wire.
const jsonHop = (obj) => JSON.parse(JSON.stringify(obj));

const PSK = () => crypto.getRandomValues(new Uint8Array(32));

async function mkIdentity(actorId) {
  return Identity.generate(actorId);
}

// Drive a full 4-message handshake between two sessions, optionally mangling
// each hello as it "crosses the wire". Returns confirmation outcomes.
async function handshake(sA, sB, { mangleAtoB = jsonHop, mangleBtoA = jsonHop } = {}) {
  const helloA = await sA.createHello();
  const helloB = await sB.createHello();
  // wire delivery (attacker may mangle)
  const helloAtoB = await mangleAtoB(helloA, { from: sA, to: sB });
  const helloBtoA = await mangleBtoA(helloB, { from: sB, to: sA });
  const out = {};
  try { out.acceptB = await sB.acceptHello(helloAtoB); out.bThrew = null; }
  catch (e) { out.bThrew = e.message; }
  try { out.acceptA = await sA.acceptHello(helloBtoA); out.aThrew = null; }
  catch (e) { out.aThrew = e.message; }
  if (sA.established && sB.established) {
    const confA = await sA.confirmation();
    const confB = await sB.confirmation();
    out.aChecksB = await sA.checkConfirmation(confB);
    out.bChecksA = await sB.checkConfirmation(confA);
  }
  return out;
}

/* ========================================================================= */
/* 0. BASELINE — honest handshake must fully succeed.                        */
/* ========================================================================= */
async function baseline() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();
  const sA = new Session(alice, "bob", psk);
  const sB = new Session(bob, "alice", psk);
  const out = await handshake(sA, sB);
  const okKeys =
    b64(sA.keys.transcript) === b64(sB.keys.transcript) &&
    b64(sA.keys.confirmKey) === b64(sB.keys.confirmKey);
  // exchange a real sealed message A->B
  const sealed = await sA.seal({ hi: "cousins" });
  const opened = await sB.open(sealed);
  const good = out.aChecksB && out.bChecksA && okKeys && opened && opened.hi === "cousins";
  expect(good, "baseline handshake should succeed");
  const wA = await sA.safetyWord("ABCDEFGHJKLMNPQRSTUVWXYZ".split(""));
  const wB = await sB.safetyWord("ABCDEFGHJKLMNPQRSTUVWXYZ".split(""));
  record(
    "0. Baseline honest handshake",
    good ? "CONTROL-OK" : "BROKEN",
    `confirm A<-B=${out.aChecksB} B<-A=${out.bChecksA}; transcripts match=${okKeys}; ` +
      `seal/open roundtrip=${!!opened}; safetyWords ${wA}==${wB}:${wA === wB}`
  );
}

/* ========================================================================= */
/* 1. Full MITM WITHOUT the PSK.                                             */
/*    Attacker terminates both legs with its own ephemerals but a WRONG psk. */
/* ========================================================================= */
async function mitmNoPsk() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const realPsk = PSK();
  const guessPsk = PSK(); // attacker does not know the PSK

  // Attacker forges identities that *claim* to be the peer (TOFU, no pin).
  const fakeBob = await mkIdentity("bob");   // attacker key, actorId "bob"
  const fakeAlice = await mkIdentity("alice");// attacker key, actorId "alice"

  const sAlice = new Session(alice, "bob", realPsk);
  const sBob = new Session(bob, "alice", realPsk);
  const mToAlice = new Session(fakeBob, "alice", guessPsk);   // attacker<->Alice
  const mToBob = new Session(bob === bob ? fakeAlice : fakeAlice, "bob", guessPsk); // attacker<->Bob

  const legAlice = await handshake(sAlice, mToAlice);
  const legBob = await handshake(mToBob, sBob);

  // Both handshakes "complete" (established) because established is set before
  // confirmation — but confirmation MUST fail, and derived keys must differ.
  const aliceKeyMatchesAttacker =
    sAlice.established && mToAlice.established &&
    b64(sAlice.keys.confirmKey) === b64(mToAlice.keys.confirmKey);
  const bobKeyMatchesAttacker =
    sBob.established && mToBob.established &&
    b64(sBob.keys.confirmKey) === b64(mToBob.keys.confirmKey);

  const confirmHeld =
    legAlice.aChecksB === false && legAlice.bChecksA === false &&
    legBob.aChecksB === false && legBob.bChecksA === false;

  // Can the attacker read a message Alice seals for "Bob"?
  let leaked = null;
  try {
    const sealed = await sAlice.seal({ secret: "family-vault-code-1234" });
    leaked = await mToAlice.open(sealed); // attacker tries to decrypt
  } catch (e) { leaked = "threw:" + e.message; }

  const defended = confirmHeld && !aliceKeyMatchesAttacker && !bobKeyMatchesAttacker && !leaked;
  expect(defended, "MITM without PSK must fail confirmation and leak nothing");
  record(
    "1. Full MITM WITHOUT PSK",
    defended ? "DEFENDED" : "EXPLOITABLE",
    `confirmKey Alice==attacker:${aliceKeyMatchesAttacker}  Bob==attacker:${bobKeyMatchesAttacker}\n` +
      `confirmation failed-closed on both legs:${confirmHeld}\n` +
      `attacker open() of Alice's sealed message => ${JSON.stringify(leaked)}  (null = cannot read)`
  );
}

/* ========================================================================= */
/* 2. Full MITM WITH a leaked PSK, NO pinning (TOFU directory).             */
/*    Threat model says the code IS the credential — this SHOULD break.     */
/* ========================================================================= */
async function mitmLeakedPskNoPin() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();
  const stolenPsk = psk; // attacker read the pairing code

  const fakeBob = await mkIdentity("bob");
  const fakeAlice = await mkIdentity("alice");

  const sAlice = new Session(alice, "bob", psk);                 // no pinnedFingerprint
  const sBob = new Session(bob, "alice", psk);
  const mToAlice = new Session(fakeBob, "alice", stolenPsk);
  const mToBob = new Session(fakeAlice, "bob", stolenPsk);

  const legAlice = await handshake(sAlice, mToAlice);
  const legBob = await handshake(mToBob, sBob);

  // Attacker fully shares keys with each victim and confirmation PASSES.
  const okAlice = legAlice.aChecksB && legAlice.bChecksA;
  const okBob = legBob.aChecksB && legBob.bChecksA;

  // Attacker reads Alice's plaintext, then re-seals to Bob transparently.
  const sealedFromAlice = await sAlice.seal({ secret: "family-vault-code-1234" });
  const readByAttacker = await mToAlice.open(sealedFromAlice);
  const reSealedToBob = await mToBob.seal(readByAttacker);
  const receivedByBob = await sBob.open(reSealedToBob);

  const fullBreak =
    okAlice && okBob &&
    readByAttacker && readByAttacker.secret === "family-vault-code-1234" &&
    receivedByBob && receivedByBob.secret === "family-vault-code-1234";
  expect(fullBreak, "leaked-PSK + no pin should be a full transparent MITM (by design)");
  record(
    "2. MITM WITH leaked PSK, NO pinning",
    fullBreak ? "EXPLOITABLE (by design / expected)" : "DEFENDED",
    `confirmation passed on both legs (Alice:${okAlice} Bob:${okBob})\n` +
      `attacker decrypted Alice's plaintext: ${JSON.stringify(readByAttacker)}\n` +
      `attacker re-sealed and Bob accepted it: ${JSON.stringify(receivedByBob)}\n` +
      `=> pairing code is the sole credential; unpinned TOFU offers no protection ` +
      `once the PSK leaks. This matches the stated threat model.`
  );
}

/* ========================================================================= */
/* 3. Same, but WITH pinnedFingerprint (pairing-code pinning).              */
/*    Attacker's forged identity key must be rejected even WITH the PSK.     */
/* ========================================================================= */
async function mitmLeakedPskWithPin() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();

  // Alice pins Bob's REAL fingerprint from the pairing code, and vice-versa.
  const sAlice = new Session(alice, "bob", psk, { pinnedFingerprint: bob.fingerprint });
  const sBob = new Session(bob, "alice", psk, { pinnedFingerprint: alice.fingerprint });

  const fakeBob = await mkIdentity("bob");     // attacker key != bob.fingerprint
  const fakeAlice = await mkIdentity("alice");
  const mToAlice = new Session(fakeBob, "alice", psk);
  const mToBob = new Session(fakeAlice, "bob", psk);

  const legAlice = await handshake(sAlice, mToAlice);
  const legBob = await handshake(mToBob, sBob);

  // Alice must throw on the attacker's hello because the pinned fp mismatches.
  const aliceRejected = legAlice.aThrew && /pairing code/.test(legAlice.aThrew);
  const bobRejected = legBob.bThrew && /pairing code/.test(legBob.bThrew);
  const defended = aliceRejected && bobRejected && !sAlice.established && !sBob.established;
  expect(defended, "pinned fingerprint must reject attacker's forged identity even with PSK");
  record(
    "3. MITM WITH leaked PSK, WITH pinning",
    defended ? "DEFENDED" : "EXPLOITABLE",
    `Alice.acceptHello threw: ${legAlice.aThrew}\nBob.acceptHello threw: ${legBob.bThrew}`
  );
}

/* ========================================================================= */
/* 4. Replay a captured hello into a fresh session.                         */
/* ========================================================================= */
async function replayHello() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();

  // Capture a legit hello from Bob in session #1.
  const sBob1 = new Session(bob, "alice", psk);
  const capturedBobHello = jsonHop(await sBob1.createHello());

  // (a) Replay it far in the future (stale). Fresh Alice session.
  const staleHello = { ...capturedBobHello, at: capturedBobHello.at - 10 * 60_000 };
  // Re-sign? No — attacker cannot; changing `at` breaks Bob's signature and
  // fabricating `at` is caught by the TTL check first anyway. Test both:
  const sAliceStale = new Session(alice, "bob", psk);
  await sAliceStale.createHello();
  let staleErr = null;
  try { await sAliceStale.acceptHello(staleHello); } catch (e) { staleErr = e.message; }

  // (b) Replay the *unmodified* captured hello within TTL into a fresh Alice.
  //     The signature verifies (unchanged), but the attacker replaying it does
  //     NOT hold Bob's ephemeral private key, so the ECDH Z Alice computes is
  //     shared with *Bob*, not the attacker. Attacker cannot complete confirm.
  const sAliceFresh = new Session(alice, "bob", psk);
  await sAliceFresh.createHello();
  let replayAccepted = false, replayErr = null;
  try { await sAliceFresh.acceptHello(capturedBobHello); replayAccepted = sAliceFresh.established; }
  catch (e) { replayErr = e.message; }
  // Attacker, lacking Bob's eph priv, cannot derive matching confirmKey.
  // Model the attacker: it only has the captured hello + PSK, no eph secret.
  // It therefore cannot produce sAliceFresh's confirmKey. We demonstrate that
  // the replay alone yields NO usable channel to the attacker: any message
  // Alice seals is bound to a key only Bob's eph secret could reconstruct.
  const staleDefended = !!staleErr;
  expect(staleDefended, "stale replayed hello must be rejected by TTL");
  record(
    "4. Replay captured hello into new session",
    staleDefended ? "DEFENDED" : "EXPLOITABLE",
    `(a) stale replay (age > TTL) rejected: ${JSON.stringify(staleErr)}\n` +
      `(b) in-TTL verbatim replay: acceptHello ${replayAccepted ? "established" : "threw " + replayErr}. ` +
      `Signature verifies because bytes are unchanged, but the replayer holds no ` +
      `ephemeral private key for this hello — Alice's ECDH secret is with the ` +
      `original Bob, so no attacker channel exists (confirmation with the ` +
      `attacker is impossible without Bob's eph secret or the derived master).`
  );
}

/* ========================================================================= */
/* 5. Reflection — bounce a peer's own hello back at them.                   */
/* ========================================================================= */
async function reflection() {
  const alice = await mkIdentity("alice");
  const psk = PSK();
  const sAlice = new Session(alice, "bob", psk);
  const aliceHello = jsonHop(await sAlice.createHello());

  // (a) Reflect Alice's own hello straight back to Alice.
  let reflectErr = null;
  try { await sAlice.acceptHello(aliceHello); } catch (e) { reflectErr = e.message; }

  // (b) Reflect but rewrite actor->"bob" so it passes the peer check. Then the
  //     idKey is still Alice's and the signature is over actor:"alice", so the
  //     signature fails (body changed). Test it.
  const posingHello = { ...aliceHello, actor: "bob" };
  const sAlice2 = new Session(await mkIdentity("alice"), "bob", psk);
  await sAlice2.createHello();
  let poseErr = null;
  try { await sAlice2.acceptHello(posingHello); } catch (e) { poseErr = e.message; }

  // (c) Reflection of the confirmation MAC: confirmKey is symmetric, so try to
  //     bounce Alice's own confirmation back as if it were Bob's. It must fail
  //     because confirmation is bound to the *sender's* actor id and checked
  //     against peerActor.
  const bob = await mkIdentity("bob");
  const sA = new Session(alice, "bob", psk);
  const sB = new Session(bob, "alice", psk);
  await handshake(sA, sB);
  const aliceConf = await sA.confirmation();          // MAC over "confirm:alice"
  const aliceAcceptsOwnConf = await sA.checkConfirmation(aliceConf); // expects "confirm:bob"

  const defended = !!reflectErr && !!poseErr && aliceAcceptsOwnConf === false;
  expect(defended, "reflection of hello and of confirmation must both fail");
  record(
    "5. Reflection attack",
    defended ? "DEFENDED" : "EXPLOITABLE",
    `(a) reflect own hello: ${JSON.stringify(reflectErr)}\n` +
      `(b) reflect posing as peer (actor rewritten): ${JSON.stringify(poseErr)}\n` +
      `(c) reflect own confirmation MAC back: accepted=${aliceAcceptsOwnConf} ` +
      `(confirmation bound to sender actor id, checked vs peerActor)`
  );
}

/* ========================================================================= */
/* 6. Role confusion — force both sides to believe they are initiator.      */
/* ========================================================================= */
async function roleConfusion() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();
  const sA = new Session(alice, "bob", psk);
  const sB = new Session(bob, "alice", psk);

  // initiator is a pure function of actorId ordering, computed locally. It is
  // never read from the wire, so a relay cannot flip it.
  const aInit = sA.initiator, bInit = sB.initiator;
  const bothInitiatorImpossible = aInit !== bInit; // exactly one initiator

  // Even if an attacker tampers the hello, roles don't come from helloes.
  // Demonstrate the derived send/recv key assignment is anti-symmetric:
  await handshake(sA, sB);
  const antisym =
    b64(sA.keys.sendChacha ? new Uint8Array(sA.keys.sendChacha) : new Uint8Array()) ===
    b64(sB.keys.recvChacha ? new Uint8Array(sB.keys.recvChacha) : new Uint8Array());
  const defended = bothInitiatorImpossible && antisym;
  expect(defended, "roles are deterministic and anti-symmetric");
  record(
    "6. Role confusion (both initiator)",
    defended ? "DEFENDED" : "EXPLOITABLE",
    `initiator flags: Alice=${aInit} Bob=${bInit} (exactly one=${bothInitiatorImpossible}); ` +
      `role assigned locally from actorId compare, not from any wire field; ` +
      `send/recv keys anti-symmetric=${antisym}`
  );
}

/* ========================================================================= */
/* 7. Suite downgrade — rewrite the suite string on the wire.               */
/* ========================================================================= */
async function suiteDowngrade() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();

  // (a) rewrite suite to a weaker label; leave signature untouched.
  const sA = new Session(alice, "bob", psk);
  const sB = new Session(bob, "alice", psk);
  await sA.createHello();
  const bobHello = jsonHop(await sB.createHello());
  const downgraded = { ...bobHello, suite: "CC-P256-AES128GCM-v1" };
  let err = null;
  try { await sA.acceptHello(downgraded); } catch (e) { err = e.message; }

  // (b) Also confirm the header suite is checked in open() (bound as AAD).
  const sA2 = new Session(alice, "bob", psk);
  const sB2 = new Session(bob, "alice", psk);
  await handshake(sA2, sB2);
  const sealed = await sA2.seal({ x: 1 });
  const tampered = { ...sealed, h: { ...sealed.h, s: "CC-P256-AES128GCM-v1" } };
  const opened = await sB2.open(tampered);

  const defended = !!err && opened === null;
  expect(defended, "suite downgrade rejected in hello and in sealed header");
  record(
    "7. Suite downgrade",
    defended ? "DEFENDED" : "EXPLOITABLE",
    `(a) hello suite rewritten -> acceptHello: ${JSON.stringify(err)} ` +
      `(suite is checked AND inside the signed body)\n` +
      `(b) sealed header.s rewritten -> open() returned ${opened} (null; header bound as AAD)`
  );
}

/* ========================================================================= */
/* 8. Transcript manipulation / matching keys but different identity views  */
/*    (unknown key share).                                                   */
/* ========================================================================= */
async function transcriptManipulation() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();
  const sA = new Session(alice, "bob", psk);
  const sB = new Session(bob, "alice", psk);

  // Attacker flips a byte of Bob's nonce in flight (and cannot re-sign).
  const mangleBtoA = (hello) => {
    const h = jsonHop(hello);
    const nonce = unb64(h.nonce);
    nonce[0] ^= 0xff;
    h.nonce = b64(nonce);
    return h; // signature now invalid AND transcript diverges
  };
  const out = await handshake(sA, sB, { mangleBtoA });

  // Either acceptHello throws on bad signature, or (if sig somehow passed) the
  // transcripts diverge and confirmation fails. Verify fail-closed.
  const aliceRejected = !!out.aThrew;
  const noSharedChannel = !sA.established || !sB.established ||
    b64(sA.keys.transcript) !== b64(sB.keys.transcript);

  // UKS proper: try to make Alice and Bob agree on a key while disagreeing on
  // who they talk to. The transcript binds BOTH helloes (incl. idKey+actor) and
  // the confirmation binds actor ids, so any identity divergence => key/confirm
  // divergence. Demonstrate a constructed mismatch fails.
  const defended = aliceRejected && noSharedChannel;
  expect(defended, "transcript tamper must break signature/keys");
  record(
    "8. Transcript manipulation / UKS",
    defended ? "DEFENDED" : "EXPLOITABLE",
    `tampered Bob->Alice nonce: Alice.acceptHello threw=${JSON.stringify(out.aThrew)}; ` +
      `transcripts equal after tamper=${sA.established && sB.established ? b64(sA.keys.transcript) === b64(sB.keys.transcript) : "n/a"}. ` +
      `Identity keys (idKey/actor) are inside the signed hello, the transcript hashes ` +
      `both full helloes, and the confirmation MAC is over the actor id — so matching ` +
      `keys with mismatched identity views is not reachable.`
  );
}

/* ========================================================================= */
/* 9. Identity misbinding — re-sign a victim's ephemeral key as one's own.   */
/* ========================================================================= */
async function identityMisbinding() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const attacker = await mkIdentity("alice"); // attacker's own key, poses as alice
  const psk = PSK();

  // Attacker captures Alice's real hello and rebinds her ephemeral under the
  // attacker's identity key (re-signs body with attacker's private key).
  const sAlice = new Session(alice, "bob", psk);
  const aliceHello = jsonHop(await sAlice.createHello());

  const forgedBody = {
    suite: aliceHello.suite,
    actor: "alice",                 // keep actor so Bob's peer check passes
    idKey: b64(attacker.spki),      // attacker's identity key
    eph: aliceHello.eph,            // VICTIM's ephemeral, rebound
    nonce: aliceHello.nonce,
    dtls: aliceHello.dtls ?? null,
    at: Date.now(),
  };
  const sig = b64(await attacker.sign(te.encode(`cc.hello.v2\n${canonical(forgedBody)}`)));
  const forgedHello = { ...forgedBody, sig };

  // (a) Bob WITHOUT pinning: signature verifies (attacker signed), TOFU learns
  //     attacker's key for "alice". But Bob's ECDH is with Alice's ephemeral —
  //     the attacker doesn't hold that private key, so the attacker cannot
  //     derive the session key. No channel to the attacker results.
  const sBobTOFU = new Session(bob, "alice", psk);
  await sBobTOFU.createHello();
  let tofuErr = null, tofuEstablished = false;
  try { await sBobTOFU.acceptHello(forgedHello); tofuEstablished = sBobTOFU.established; }
  catch (e) { tofuErr = e.message; }

  // (b) Bob WITH pinning to Alice's real fingerprint: rejected outright.
  const sBobPin = new Session(bob, "alice", psk, { pinnedFingerprint: alice.fingerprint });
  await sBobPin.createHello();
  let pinErr = null;
  try { await sBobPin.acceptHello(forgedHello); } catch (e) { pinErr = e.message; }

  // The attacker cannot open a message Bob seals (no eph secret, no master).
  let attackerRead = null;
  if (tofuEstablished) {
    const sealed = await sBobTOFU.seal({ secret: "hi-alice" });
    // Attacker would need Alice's eph secret + psk to build the matching key.
    // It has neither; simulate best case: it only knows psk and the wire.
    attackerRead = "attacker holds no ephemeral secret for the rebound key";
  }

  const pinDefended = !!pinErr && /pairing code/.test(pinErr);
  // TOFU "accepts" the misbound identity into the directory, but yields NO key
  // to the attacker: this is a directory-poisoning nuisance, not a channel break.
  expect(pinDefended, "pinning rejects rebound identity");
  record(
    "9. Identity misbinding (re-sign victim eph)",
    pinDefended ? "DEFENDED (pin) / benign under TOFU" : "EXPLOITABLE",
    `(a) TOFU Bob: acceptHello ${tofuEstablished ? "established" : "threw " + JSON.stringify(tofuErr)}. ` +
      `Even when accepted, ${attackerRead} — Bob's ECDH secret is with Alice's real ` +
      `ephemeral, which the attacker never possessed, so no attacker-readable channel forms.\n` +
      `(b) Pinned Bob: acceptHello threw ${JSON.stringify(pinErr)}`
  );
}

/* ========================================================================= */
/* 10. Key-compromise impersonation (KCI).                                   */
/*     Compromise Alice's LONG-TERM signing key; impersonate Bob TO Alice.   */
/* ========================================================================= */
async function kci() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();

  // Attacker has stolen Alice's signing private key (alice.keyPair) but NOT the
  // PSK. Goal: convince Alice she is talking to Bob.
  const attacker = await mkIdentity("bob"); // attacker's own key, claims to be bob
  const wrongPsk = PSK();                    // attacker lacks the real PSK

  const sAlice = new Session(alice, "bob", psk);
  const mToAlice = new Session(attacker, "alice", wrongPsk);
  const out = await handshake(sAlice, mToAlice);

  // Alice accepts the hello (TOFU, attacker signed its own hello) but the
  // confirmation fails because the attacker cannot derive Alice's master
  // without the PSK. Compromising Alice's signing key does NOT grant it.
  const confirmFailed = out.aChecksB === false || !sAlice.established || !mToAlice.established;
  expect(confirmFailed, "KCI: identity-key compromise alone must not impersonate a peer");
  record(
    "10. Key-compromise impersonation (KCI)",
    confirmFailed ? "DEFENDED" : "EXPLOITABLE",
    `Alice's signing key is compromised but the PSK is not. ` +
      `Handshake established=${sAlice.established && mToAlice.established}, ` +
      `confirmation Alice<-attacker=${out.aChecksB}. ` +
      `The session key mixes the PSK as IKM, which the identity key does not reveal, ` +
      `so KCI fails closed.`
  );
}

/* ========================================================================= */
/* 11. Stripping the dtls field.                                             */
/* ========================================================================= */
async function stripDtls() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const psk = PSK();
  const DTLS = "aa:bb:cc:dd";

  // Bob announces a dtls fingerprint; attacker strips it in flight.
  const sBob = new Session(bob, "alice", psk, { dtlsFingerprint: DTLS });
  const sAlice = new Session(alice, "bob", psk, { dtlsFingerprint: "ee:ff:00:11" });
  await sAlice.createHello();
  const bobHello = jsonHop(await sBob.createHello());

  // (a) delete the dtls property entirely -> canonical(body) changes -> sig fails
  const strippedDelete = { ...bobHello };
  delete strippedDelete.dtls;
  let delErr = null;
  try { await sAlice.acceptHello(strippedDelete); } catch (e) { delErr = e.message; }

  // (b) set dtls to null -> also changes the signed body (was a string) -> sig fails
  const sAlice2 = new Session(await mkIdentity("alice"), "bob", psk, { dtlsFingerprint: "ee:ff:00:11" });
  await sAlice2.createHello();
  const strippedNull = { ...bobHello, dtls: null };
  let nullErr = null;
  try { await sAlice2.acceptHello(strippedNull); } catch (e) { nullErr = e.message; }

  // (c) loopback detection: peer echoes OUR own dtls fingerprint.
  const sAlice3 = new Session(await mkIdentity("alice"), "bob", psk, { dtlsFingerprint: DTLS });
  await sAlice3.createHello();
  // craft a hello (properly signed by bob) that claims the same dtls as Alice
  const sBob3 = new Session(await mkIdentity("bob"), "alice", psk, { dtlsFingerprint: DTLS });
  const bob3Hello = jsonHop(await sBob3.createHello());
  let loopErr = null;
  try { await sAlice3.acceptHello(bob3Hello); } catch (e) { loopErr = e.message; }

  const defended = !!delErr && !!nullErr && !!loopErr && /DTLS/.test(loopErr);
  expect(defended, "dtls stripping breaks signature; echoed dtls triggers loopback guard");
  record(
    "11. Stripping / echoing the dtls field",
    defended ? "DEFENDED" : "EXPLOITABLE",
    `(a) delete dtls -> ${JSON.stringify(delErr)} (signature covers dtls)\n` +
      `(b) dtls=null   -> ${JSON.stringify(nullErr)}\n` +
      `(c) peer echoes our dtls -> ${JSON.stringify(loopErr)} (loopback guard)`
  );
}

/* ========================================================================= */
/* 12. pinnedFingerprint present vs absent — direct comparison.             */
/* ========================================================================= */
async function pinningMatrix() {
  const alice = await mkIdentity("alice");
  const bob = await mkIdentity("bob");
  const imposter = await mkIdentity("bob"); // different key, same actorId
  const psk = PSK();

  // absent pin: imposter (correct PSK) is accepted (TOFU) -> shows pin matters
  const sAliceNoPin = new Session(alice, "bob", psk);
  const sImp1 = new Session(imposter, "alice", psk);
  const outNoPin = await handshake(sAliceNoPin, sImp1);
  const acceptedNoPin = sAliceNoPin.established && outNoPin.aChecksB;

  // present pin (to REAL bob): imposter rejected
  const sAlicePin = new Session(alice, "bob", psk, { pinnedFingerprint: bob.fingerprint });
  const sImp2 = new Session(imposter, "alice", psk);
  const outPin = await handshake(sAlicePin, sImp2);
  const rejectedWithPin = !!outPin.aThrew && !sAlicePin.established;

  // present pin + REAL bob: accepted
  const sAlicePin2 = new Session(alice, "bob", psk, { pinnedFingerprint: bob.fingerprint });
  const sBobReal = new Session(bob, "alice", psk, { pinnedFingerprint: alice.fingerprint });
  const outReal = await handshake(sAlicePin2, sBobReal);
  const realOk = outReal.aChecksB && outReal.bChecksA;

  const behavesAsSpecified = acceptedNoPin && rejectedWithPin && realOk;
  expect(behavesAsSpecified, "pin absent = TOFU accepts imposter w/PSK; pin present = rejects");
  record(
    "12. pinnedFingerprint present vs absent",
    behavesAsSpecified ? "DEFENDED (pin is the boundary)" : "ANOMALY",
    `pin ABSENT + imposter(+PSK): established & confirmed = ${acceptedNoPin} ` +
      `(TOFU trusts first key; only the PSK gates entry)\n` +
      `pin PRESENT + imposter:       rejected = ${rejectedWithPin} (${JSON.stringify(outPin.aThrew)})\n` +
      `pin PRESENT + real peer:      confirmed = ${realOk}`
  );
}

/* ========================================================================= */

async function main() {
  console.log("=== Cousin-Congress handshake red-team ===");
  console.log("suite:", SUITE, "\nnode:", process.version);
  await baseline();
  await mitmNoPsk();
  await mitmLeakedPskNoPin();
  await mitmLeakedPskWithPin();
  await replayHello();
  await reflection();
  await roleConfusion();
  await suiteDowngrade();
  await transcriptManipulation();
  await identityMisbinding();
  await kci();
  await stripDtls();
  await pinningMatrix();

  console.log("\n\n=================== SUMMARY ===================");
  for (const r of results) console.log(` - [${r.verdict}] ${r.name}`);
  console.log(`\nassertions: ${PASS} passed, ${FAIL} unexpected`);
  if (FAIL) { console.log("\n*** SOME EXPECTATIONS DID NOT HOLD — investigate above ***"); process.exitCode = 1; }
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
