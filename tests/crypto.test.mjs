/**
 * Functional proof that the E2E protocol works between two honest peers, and
 * that the obvious dishonest moves fail closed. The dedicated red-team suite
 * lives under tests/attacks/; this is the "does it work at all" gate that runs
 * on every commit.
 */

import {
  Identity,
  KeyDirectory,
  Session,
  canonical,
  newPairingSecret,
  signOp,
  verifyOp,
} from "../js/crypto.js";

let failures = 0;
const ok = (name) => console.log(`ok  ${name}`);
const bad = (name, extra = "") => {
  failures += 1;
  console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
};
const assert = (name, cond, extra) => (cond ? ok(name) : bad(name, extra));

/** Run a full handshake between two fresh identities sharing a PSK. */
async function handshake(psk, { pinA = null, pinB = null } = {}) {
  const alice = await Identity.generate("aaaa");
  const bob = await Identity.generate("bbbb");

  const sa = new Session(alice, "bbbb", psk, { pinnedFingerprint: pinB });
  const sb = new Session(bob, "aaaa", psk, { pinnedFingerprint: pinA });

  const helloA = await sa.createHello();
  const helloB = await sb.createHello();

  await sa.acceptHello(helloB);
  await sb.acceptHello(helloA);

  // Key confirmation both directions.
  const confA = await sa.confirmation();
  const confB = await sb.confirmation();
  const aOk = await sa.checkConfirmation(confB);
  const bOk = await sb.checkConfirmation(confA);

  return { alice, bob, sa, sb, confirmed: aOk && bOk };
}

/* --- happy path ----------------------------------------------------------- */

{
  const psk = newPairingSecret();
  const { sa, sb, confirmed } = await handshake(psk);
  assert("handshake completes and both sides confirm", confirmed);

  const msg = { t: "ops", ops: [{ hi: "there", n: 42 }] };
  const sealed = await sa.seal(msg);
  const opened = await sb.open(sealed);
  assert("sealed message round-trips A->B", JSON.stringify(opened) === JSON.stringify(msg));

  const back = await sb.seal({ reply: true });
  const openedBack = await sa.open(back);
  assert("sealed message round-trips B->A", openedBack?.reply === true);

  // Safety words must match on both sides.
  const alphabet = [..."🦉🦊🐸🐼🦄🐙🦖🐝🌊🌱🍩🍕🎲🎨🚀🏆"];
  const wordA = await sa.safetyWord(alphabet);
  const wordB = await sb.safetyWord(alphabet);
  assert("safety words match", wordA === wordB, `${wordA} vs ${wordB}`);
}

/* --- wrong PSK must not interoperate -------------------------------------- */

{
  const alice = await Identity.generate("aaaa");
  const bob = await Identity.generate("bbbb");
  const sa = new Session(alice, "bbbb", newPairingSecret());
  const sb = new Session(bob, "aaaa", newPairingSecret()); // different PSK

  const ha = await sa.createHello();
  const hb = await sb.createHello();
  await sa.acceptHello(hb);
  await sb.acceptHello(ha);

  const confB = await sb.confirmation();
  assert("mismatched PSK fails key confirmation", !(await sa.checkConfirmation(confB)));

  const sealed = await sa.seal({ secret: "toppings" });
  assert("message under a different PSK does not open", (await sb.open(sealed)) === null);
}

/* --- pinned fingerprint enforcement --------------------------------------- */

{
  const psk = newPairingSecret();
  const alice = await Identity.generate("aaaa");
  const bob = await Identity.generate("bbbb");
  const impostor = await Identity.generate("bbbb"); // same actor id, different key

  // Alice pins Bob's real fingerprint from the pairing code.
  const sa = new Session(alice, "bbbb", psk, { pinnedFingerprint: bob.fingerprint });
  const sImp = new Session(impostor, "aaaa", psk);
  await sa.createHello();
  const impHello = await sImp.createHello();

  let rejected = false;
  try {
    await sa.acceptHello(impHello);
  } catch {
    rejected = true;
  }
  assert("pinned fingerprint rejects an impostor with the right actor id", rejected);
}

/* --- replay protection ---------------------------------------------------- */

{
  const psk = newPairingSecret();
  const { sa, sb } = await handshake(psk);
  const sealed = await sa.seal({ n: 1 });
  const first = await sb.open(sealed);
  const second = await sb.open(sealed);
  assert("first delivery opens", first?.n === 1);
  assert("replayed delivery is rejected", second === null);
}

/* --- open() never throws on hostile input --------------------------------- */

{
  const psk = newPairingSecret();
  const { sb } = await handshake(psk);
  const garbage = [
    null, undefined, 42, "string", [], {}, { h: null }, { h: {} },
    { h: { s: "wrong" } }, { h: { s: "CC-P384-AES256GCM-XCHACHA20-HKDFSHA384-v2", a: "aaaa", e: 0, c: 0 }, n: "!!", c: "!!" },
    { h: { s: "CC-P384-AES256GCM-XCHACHA20-HKDFSHA384-v2", a: "aaaa", e: -1, c: 0 } },
    { h: { s: "CC-P384-AES256GCM-XCHACHA20-HKDFSHA384-v2", a: "aaaa", e: 1e9, c: 1e9 }, n: "AAAA", c: "AAAA" },
  ];
  let threw = false;
  for (const g of garbage) {
    try {
      await sb.open(g);
    } catch (e) {
      threw = true;
      console.error("  threw on", JSON.stringify(g), e.message);
    }
  }
  assert("open() never throws across malformed inputs", !threw);
}

/* --- op signing and verification ------------------------------------------ */

{
  const alice = await Identity.generate("aaaa");
  const directory = new KeyDirectory();
  await directory.learn("aaaa", alice.spki, { pinned: true });

  const op = { actor: "aaaa", seq: 3, hlc: "0000000000000000042:00001:aaaa", type: "ballot.cast", payload: { voteId: "v1", choice: "yea" }, v: 2 };
  const signed = await signOp(alice, op);
  assert("signed op verifies", (await verifyOp(signed, directory)).ok);

  // Tamper the payload; signature must fail.
  const tampered = { ...signed, payload: { voteId: "v1", choice: "nay" } };
  const verdict = await verifyOp(tampered, directory);
  assert("tampered op fails verification", !verdict.ok && verdict.reason === "bad-signature");

  // Signature transplant onto a different op from the same author.
  const other = { actor: "aaaa", seq: 4, hlc: "0000000000000000043:00001:aaaa", type: "ballot.cast", payload: { voteId: "v2", choice: "yea" }, v: 2, sig: signed.sig, kid: signed.kid };
  assert("transplanted signature fails", !(await verifyOp(other, directory)).ok);

  // Unknown author is distinguished from forged.
  const bob = await Identity.generate("bbbb");
  const bobOp = await signOp(bob, { actor: "bbbb", seq: 0, hlc: "0000000000000000044:00001:bbbb", type: "status.post", payload: { text: "hi" }, v: 2 });
  const unknown = await verifyOp(bobOp, directory);
  assert("unknown author reported as unknown, not forged", !unknown.ok && unknown.reason === "unknown-author");
}

/* --- canonicalisation ----------------------------------------------------- */

{
  assert("canonical sorts keys", canonical({ b: 1, a: 2 }) === '{"a":2,"b":1}');
  assert("canonical is order-independent", canonical({ a: 1, b: 2 }) === canonical({ b: 2, a: 1 }));
  assert("canonical nests", canonical({ x: { c: 3, a: 1 } }) === '{"x":{"a":1,"c":3}}');
  let threw = false;
  try {
    canonical({ n: Infinity });
  } catch {
    threw = true;
  }
  assert("canonical rejects non-finite numbers", threw);
}

/* --- TOFU key-change conflict --------------------------------------------- */

{
  const directory = new KeyDirectory();
  const real = await Identity.generate("aaaa");
  const fake = await Identity.generate("aaaa");
  await directory.learn("aaaa", real.spki);
  let conflicted = false;
  directory.addEventListener("conflict", () => (conflicted = true));
  await directory.learn("aaaa", fake.spki);
  assert("unpinned key change raises a conflict", conflicted);

  const pinnedDir = new KeyDirectory();
  await pinnedDir.learn("aaaa", real.spki, { pinned: true });
  await pinnedDir.learn("aaaa", fake.spki); // attempt to override a pin
  assert("pinned key is not overridden by a network assertion", pinnedDir.get("aaaa").fingerprint === real.fingerprint);
}

console.log(failures ? `\n${failures} FAILURES` : "\ncrypto: handshake, sealing, signing and TOFU all pass");
process.exit(failures ? 1 : 0);
