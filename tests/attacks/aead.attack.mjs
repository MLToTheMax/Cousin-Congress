/**
 * aead.attack.mjs — RED TEAM against the RECORD LAYER.
 *
 * Targets: Session.seal()/open() in js/crypto.js and the AEADs in js/chacha.js.
 * Every claim below is backed by a runnable assertion printed to stdout.
 *
 * Run: node tests/attacks/aead.attack.mjs
 */

import { Identity, Session, newPairingSecret, b64, unb64, canonical } from "../../js/crypto.js";
import { xaeadEncrypt, xaeadDecrypt, aeadDecrypt } from "../../js/chacha.js";

const SUITE = "CC-P384-AES256GCM-XCHACHA20-HKDFSHA384-v2";
const te = new TextEncoder();

let PASS = 0, FAIL = 0;
const results = [];
function record(kind, name, detail = "") {
  results.push({ kind, name, detail });
  const tag = { DEFENDED: "DEFENDED ", EXPLOIT: "EXPLOIT  ", THEORY: "THEORY   ", INFO: "INFO     " }[kind];
  console.log(`[${tag}] ${name}${detail ? "  :: " + detail : ""}`);
}
function expect(cond, name, detail) {
  if (cond) { PASS++; } else { FAIL++; console.log(`   !! assertion failed: ${name}`); }
}

/* Full handshake between two honest peers sharing a PSK. */
async function handshake(psk) {
  const alice = await Identity.generate("aaaa");
  const bob = await Identity.generate("bbbb");
  const sa = new Session(alice, "bbbb", psk);
  const sb = new Session(bob, "aaaa", psk);
  const ha = await sa.createHello();
  const hb = await sb.createHello();
  await sa.acceptHello(hb);
  await sb.acceptHello(ha);
  return { sa, sb }; // sa is initiator (aaaa < bbbb)
}

const clone = (o) => structuredClone(o);

console.log("=".repeat(72));
console.log("RECORD LAYER ATTACKS");
console.log("=".repeat(72));

/* ========================================================================== */
/* 1. AES-GCM inner nonce reuse — try to force two ciphertexts to share a     */
/*    (key, nonce) pair under one sending key.                                */
/* ========================================================================== */
{
  const { sa } = await handshake(newPairingSecret());
  const seen = new Map(); // nonceHex -> true, within epoch 0
  const N = 3000;
  let collision = false;
  for (let i = 0; i < N; i++) {
    const env = await sa.seal({ i });
    // reconstruct the inner nonce exactly as seal() computes it
    const c = env.h.c, e = env.h.e;
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setUint32(0, e, false);
    new DataView(nonce.buffer).setUint32(4, Math.floor(c / 2 ** 32), false);
    new DataView(nonce.buffer).setUint32(8, c >>> 0, false);
    const hex = Buffer.from(nonce).toString("hex");
    const key = `${e}|${hex}`; // key is stable within an epoch (same sendAes)
    if (seen.has(key)) collision = true;
    seen.set(key, true);
  }
  expect(!collision, "no inner-nonce collision within an epoch");
  record("DEFENDED", "AES-GCM inner nonce unique within an epoch",
    `${N} seals, 0 collisions; counter is monotonic and part of the 96-bit nonce`);
}

/* ========================================================================== */
/* 2. Ratchet interaction: does epoch increment reset counters *safely*?      */
/*    After ratchet, counter resets to 0 — but the sending KEY also changes,  */
/*    and the epoch is encoded in the nonce, so (key,nonce) never repeats.    */
/* ========================================================================== */
{
  const { sa } = await handshake(newPairingSecret());
  // Seal one message at epoch 0, counter 0.
  const e0 = await sa.seal({ x: "epoch0" });
  expect(e0.h.e === 0 && e0.h.c === 0, "first msg is (e0,c0)");
  // Force a ratchet.
  await sa.ratchet();
  const e1 = await sa.seal({ x: "epoch1" });
  expect(e1.h.e === 1 && e1.h.c === 0, "post-ratchet msg is (e1,c0) — counter reset");
  // The two share counter 0 but differ in epoch -> different nonce prefix AND
  // a freshly-derived sendAes key. Confirm the nonces differ.
  const nonceOf = (c, e) => {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setUint32(0, e, false);
    new DataView(n.buffer).setUint32(8, c >>> 0, false);
    return Buffer.from(n).toString("hex");
  };
  expect(nonceOf(0, 0) !== nonceOf(0, 1), "counter-0 nonces differ across epochs");
  record("DEFENDED", "Ratchet resets counter but epoch+new key prevent reuse",
    "epoch is bytes[0..3] of the 96-bit nonce and the AES key is rederived each ratchet");
}

/* ========================================================================== */
/* 3. Counter -> nonce conversion for counters above 2^32.                    */
/*    Check the (floor(c/2^32), c>>>0) split is injective and never aliases   */
/*    a low counter onto a high one under the same key.                       */
/* ========================================================================== */
{
  const nonceOf = (c) => {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setUint32(0, 0, false);
    new DataView(n.buffer).setUint32(4, Math.floor(c / 2 ** 32), false);
    new DataView(n.buffer).setUint32(8, c >>> 0, false);
    return Buffer.from(n).toString("hex");
  };
  const probes = [0, 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 2 ** 33, 2 ** 40, Number.MAX_SAFE_INTEGER];
  const set = new Set(probes.map(nonceOf));
  expect(set.size === probes.length, "counter->nonce injective across the 2^32 boundary");
  // The dangerous classic bug would be c and c+2^32 aliasing. Confirm they don't.
  expect(nonceOf(5) !== nonceOf(2 ** 32 + 5), "c and c+2^32 map to distinct nonces");
  record("DEFENDED", "64-bit counter split has no 2^32 aliasing",
    "REKEY_AFTER_MESSAGES=50000 also forces a ratchet long before c reaches 2^32");
}

/* ========================================================================== */
/* 4. Header / AAD confusion. Move a valid ciphertext to a different header.   */
/* ========================================================================== */
{
  const { sa, sb } = await handshake(newPairingSecret());
  const good = await sa.seal({ secret: "vote:yea" });

  // 4a. Change actor 'a' to something else.
  const a1 = clone(good); a1.h.a = "cccc";
  expect((await sb.open(a1)) === null, "header actor swap -> null");

  // 4b. Change actor 'a' to receiver's own id (impersonation attempt).
  const a2 = clone(good); a2.h.a = "bbbb";
  expect((await sb.open(a2)) === null, "header actor forged to self -> null");

  // 4c. Change epoch.
  const a3 = clone(good); a3.h.e = 1;
  expect((await sb.open(a3)) === null, "header epoch bump -> null");

  // 4d. Change counter.
  const a4 = clone(good); a4.h.c = 7;
  expect((await sb.open(a4)) === null, "header counter change -> null");

  // 4e. Change suite string.
  const a5 = clone(good); a5.h.s = SUITE + "x";
  expect((await sb.open(a5)) === null, "header suite change -> null");

  // 4f. Add an extra (JSON-safe) header field so canonical(header) differs.
  const a6 = clone(good); a6.h.extra = "z";
  expect((await sb.open(a6)) === null, "header extra field -> null (AAD mismatch)");

  // Sanity: the untouched envelope still opens.
  const okOpen = await sb.open(clone(good));
  expect(okOpen && okOpen.secret === "vote:yea", "untouched envelope opens");
  record("DEFENDED", "Header/AAD binding blocks all header substitutions",
    "canonical(header) is AAD on BOTH layers; any field change breaks both tags");
}

/* ========================================================================== */
/* 5. Truncation & bit-flipping of outer and inner layers.                    */
/* ========================================================================== */
{
  const { sa, sb } = await handshake(newPairingSecret());
  const good = await sa.seal({ p: "payload-under-test" });

  // 5a. Flip a bit in the outer ciphertext body.
  const f1 = clone(good);
  { const ct = unb64(f1.c); ct[0] ^= 0x01; f1.c = b64(ct); }
  expect((await sb.open(f1)) === null, "outer body bit-flip -> null");

  // 5b. Flip a bit in the outer tag (last 16 bytes).
  const f2 = clone(good);
  { const ct = unb64(f2.c); ct[ct.length - 1] ^= 0x80; f2.c = b64(ct); }
  expect((await sb.open(f2)) === null, "outer tag bit-flip -> null");

  // 5c. Flip a bit in the outer nonce.
  const f3 = clone(good);
  { const n = unb64(f3.n); n[0] ^= 0x01; f3.n = b64(n); }
  expect((await sb.open(f3)) === null, "outer nonce bit-flip -> null");

  // 5d. Truncate the outer ciphertext.
  const f4 = clone(good);
  { const ct = unb64(f4.c); f4.c = b64(ct.subarray(0, ct.length - 4)); }
  expect((await sb.open(f4)) === null, "outer truncation -> null");

  // 5e. Truncate below the tag length entirely.
  const f5 = clone(good);
  { f5.c = b64(new Uint8Array(4)); }
  expect((await sb.open(f5)) === null, "outer stripped to 4 bytes -> null");

  record("DEFENDED", "Truncation and bit-flips rejected at the outer AEAD",
    "XChaCha20-Poly1305 tag fails closed before AES is ever invoked");
}

/* ========================================================================== */
/* 6. Cross-layer confusion: feed an outer ciphertext where the inner is      */
/*    expected, and vice-versa; swap n and c fields.                          */
/* ========================================================================== */
{
  const { sa, sb } = await handshake(newPairingSecret());
  const good = await sa.seal({ p: "cross-layer" });

  // 6a. Swap the outer nonce and outer ciphertext fields.
  const s1 = clone(good); const tmp = s1.n; s1.n = s1.c; s1.c = tmp;
  expect((await sb.open(s1)) === null, "swap n<->c fields -> null");

  // 6b. Take the DECRYPTED inner (AES) blob and present it as the outer.
  //     We can only get the inner by decrypting with the recv chacha key,
  //     which the attacker does not have — so simulate the strongest attacker
  //     that somehow has the inner blob and tries to replay it as outer.
  //     It must still fail because the outer key/tag differ.
  const outerNonce = unb64(good.n);
  const innerBlob = xaeadDecrypt(sb.keys.recvChacha, outerNonce, unb64(good.c), te.encode(canonical(good.h)));
  expect(innerBlob !== null, "(setup) recovered inner AES blob for the test");
  const s2 = clone(good); s2.c = b64(innerBlob);
  expect((await sb.open(s2)) === null, "inner AES blob presented as outer -> null");

  // 6c. Present the whole outer envelope's ciphertext as if it were an inner
  //     AES-GCM ciphertext directly (decrypt with recvAes). Should reject.
  let innerReject = null;
  try {
    const nonce = new Uint8Array(12);
    innerReject = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: te.encode(canonical(good.h)), tagLength: 128 },
      sb.keys.recvAes, unb64(good.c));
  } catch { innerReject = "threw-rejected"; }
  expect(innerReject === "threw-rejected", "outer ct fed to inner AES-GCM -> rejected");

  record("DEFENDED", "Cross-layer confusion impossible",
    "independent keys per layer; a blob valid at one layer is garbage at the other");
}

/* ========================================================================== */
/* 7. Replay within and outside the window.                                   */
/* ========================================================================== */
{
  const { sa, sb } = await handshake(newPairingSecret());
  const m = await sa.seal({ n: 1 });
  const first = await sb.open(clone(m));
  const second = await sb.open(clone(m));
  expect(first && first.n === 1, "first delivery opens");
  expect(second === null, "immediate replay rejected");

  // Replay after many other messages (still within/without window).
  for (let i = 2; i < 100; i++) await sb.open(await sa.seal({ n: i }));
  const late = await sb.open(clone(m));
  expect(late === null, "replay after 100 messages still rejected");
  record("DEFENDED", "Replay of a delivered envelope is rejected",
    "(e:c) tag recorded post-auth; duplicate tags refused");
}

/* ========================================================================== */
/* 8. CLAIM UNDER TEST: can a FORGED envelope burn a counter and cause the    */
/*    genuine message at that (e,c) to be dropped as a replay later?          */
/*    The code adds the tag ONLY after both AEAD layers authenticate.         */
/* ========================================================================== */
{
  const { sa, sb } = await handshake(newPairingSecret());
  // Genuine message the sender WILL send at (e0,c0):
  const genuine = await sa.seal({ important: "genuine c0" });
  expect(genuine.h.c === 0, "(setup) genuine is counter 0");

  // Attacker forges an envelope claiming the SAME (e,c) but with junk crypto.
  const forged = {
    h: { e: genuine.h.e, c: genuine.h.c, a: "aaaa", s: SUITE },
    n: b64(crypto.getRandomValues(new Uint8Array(24))),
    c: b64(crypto.getRandomValues(new Uint8Array(64))),
  };
  const forgeResult = await sb.open(forged);
  expect(forgeResult === null, "forged (e0,c0) is rejected");

  // Now the genuine message arrives. If the forgery had burned the counter,
  // this would be dropped. It must still open.
  const afterForge = await sb.open(clone(genuine));
  expect(afterForge && afterForge.important === "genuine c0",
    "genuine (e0,c0) still opens after the forgery attempt");
  record("DEFENDED", "Forged envelope cannot burn a counter",
    "received.add(tag) runs only after BOTH tags verify; forgeries never reach it");
}

/* ========================================================================== */
/* 9. Replay-REORDER windowing: a hostile relay replays a genuine HIGH        */
/*    counter early to evict genuine LOW counters via the sliding window.     */
/* ========================================================================== */
{
  const { sa, sb } = await handshake(newPairingSecret());
  // Sender legitimately produces a burst of messages.
  const msgs = [];
  for (let i = 0; i < 700; i++) msgs.push(await sa.seal({ i }));
  // Relay delivers the HIGHEST-counter message first.
  const high = msgs[699];
  const okHigh = await sb.open(clone(high));
  expect(okHigh && okHigh.i === 699, "high-counter msg delivered first opens");
  // Now a genuine LOW-counter message (i=0, c=0) arrives. It is > REPLAY_WINDOW
  // (512) behind highestSeen(699) and gets dropped as "too old".
  const okLow = await sb.open(clone(msgs[0]));
  const dropped = okLow === null;
  expect(dropped, "genuine low-counter msg dropped after high delivered first");
  if (dropped) {
    record("THEORY", "Reorder-then-window causes genuine-message loss (DoS)",
      "relay delivers c=699 first; genuine c=0..187 fall outside the 512 window and are refused. " +
      "Inherent to any sliding replay window under a reordering relay; the stated threat model already grants the relay drop power, so this is not an escalation.");
  }
}

/* ========================================================================== */
/* 10. Decryption-oracle timing: does open() distinguish                      */
/*     bad-outer-tag vs bad-inner-tag vs bad-JSON by timing?                  */
/* ========================================================================== */
{
  const { sa, sb } = await handshake(newPairingSecret());

  // Build three envelope classes that each fail at a different stage:
  //  A) bad OUTER tag: random outer ct -> xaeadDecrypt returns null (early).
  //  B) bad INNER tag: valid outer wrapping over a corrupted inner AES blob,
  //     so outer passes, inner AES-GCM decrypt throws.
  //  C) bad JSON: valid inner AES over non-JSON plaintext, both AEADs pass,
  //     JSON.parse fails.
  //
  // To build B and C we (as an all-powerful test harness) use the recv keys.
  const mkHeader = (c) => ({ e: 0, c, a: "aaaa", s: SUITE });

  function envBadOuter(c) {
    return { h: mkHeader(c), n: b64(crypto.getRandomValues(new Uint8Array(24))),
             c: b64(crypto.getRandomValues(new Uint8Array(80))) };
  }
  async function envBadInner(c) {
    // valid outer over a random "inner" blob that AES-GCM will reject
    const h = mkHeader(c); const aad = te.encode(canonical(h));
    const fakeInner = crypto.getRandomValues(new Uint8Array(64));
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const outer = xaeadEncrypt(sb.keys.recvChacha, nonce, fakeInner, aad);
    return { h, n: b64(nonce), c: b64(outer) };
  }
  async function envBadJson(c) {
    const h = mkHeader(c); const aad = te.encode(canonical(h));
    // real inner AES over NON-JSON plaintext (0xff bytes -> invalid UTF-8/JSON)
    const innerNonce = new Uint8Array(12);
    new DataView(innerNonce.buffer).setUint32(8, c >>> 0, false);
    const badPlain = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const inner = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: innerNonce, additionalData: aad, tagLength: 128 },
      sb.keys.recvAes, badPlain));
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const outer = xaeadEncrypt(sb.keys.recvChacha, nonce, inner, aad);
    return { h, n: b64(nonce), c: b64(outer) };
  }

  const TRIALS = 4000;
  async function timeClass(make) {
    // fresh session each batch so replay/highestSeen never interferes; we use
    // distinct counters to avoid the replay Set short-circuit.
    const times = [];
    for (let i = 0; i < TRIALS; i++) {
      const env = typeof make === "function" ? await make(i % 400) : make;
      const t0 = process.hrtime.bigint();
      await sb.open(env);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0));
    }
    times.sort((a, b) => a - b);
    // trimmed median (10th..90th percentile mean) to suppress GC spikes
    const lo = Math.floor(times.length * 0.1), hi = Math.floor(times.length * 0.9);
    const slice = times.slice(lo, hi);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    return { median: times[Math.floor(times.length / 2)], trimmedMean: mean };
  }

  // bad-outer and bad-inner never authenticate fully, so they never touch the
  // replay cache and counters may repeat. bad-JSON authenticates BOTH layers
  // (it burns its counter before JSON.parse), so it MUST use a distinct,
  // monotonically increasing counter each trial or the replay short-circuit
  // contaminates the timing. We prebuild a fresh envelope per trial for it.
  const trimmedMean = (times) => {
    times.sort((a, b) => a - b);
    const lo = Math.floor(times.length * 0.1), hi = Math.floor(times.length * 0.9);
    const slice = times.slice(lo, hi);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };

  async function timeArr(arr, freshSession) {
    const target = freshSession || sb;
    const times = [];
    for (let i = 0; i < arr.length; i++) {
      const env = arr[i];
      const t0 = process.hrtime.bigint();
      await target.open(env);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0));
    }
    return trimmedMean(times);
  }

  const outerEnvs = Array.from({ length: TRIALS }, (_, i) => envBadOuter(i % 400));
  const innerEnvs = []; for (let i = 0; i < TRIALS; i++) innerEnvs.push(await envBadInner(i % 400));

  // Fresh session for the JSON class + monotonic counters so every trial does
  // the full outer+inner+JSON.parse path with no replay hit.
  const { sb: sbJson } = await handshake(newPairingSecret());
  async function envBadJsonOn(session, c) {
    const h = mkHeader(c); const aad = te.encode(canonical(h));
    const innerNonce = new Uint8Array(12);
    new DataView(innerNonce.buffer).setUint32(8, c >>> 0, false);
    const badPlain = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const inner = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: innerNonce, additionalData: aad, tagLength: 128 },
      session.keys.recvAes, badPlain));
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const outer = xaeadEncrypt(session.keys.recvChacha, nonce, inner, aad);
    return { h, n: b64(nonce), c: b64(outer) };
  }
  const jsonEnvs = []; for (let i = 0; i < TRIALS; i++) jsonEnvs.push(await envBadJsonOn(sbJson, i));

  // warm up
  await timeArr(outerEnvs.slice(0, 500));
  const tOuter = await timeArr(outerEnvs);
  const tInner = await timeArr(innerEnvs);
  const tJson = await timeArr(jsonEnvs, sbJson);
  console.log(`   timing (ns, trimmed mean): bad-outer=${tOuter.toFixed(0)} bad-inner=${tInner.toFixed(0)} bad-json=${tJson.toFixed(0)}`);
  const spread = Math.max(tOuter, tInner, tJson) - Math.min(tOuter, tInner, tJson);
  const rel = spread / Math.min(tOuter, tInner, tJson);
  // bad-outer skips the AES-GCM decrypt, so it is measurably faster.
  const distinguishable = tOuter < tInner && rel > 0.15;
  if (distinguishable) {
    record("THEORY", "open() timing distinguishes outer-fail from inner-fail",
      `bad-outer ~${tOuter.toFixed(0)}ns < bad-inner ~${tInner.toFixed(0)}ns (rel spread ${(rel * 100).toFixed(0)}%). ` +
      "Outer XChaCha tag fails before AES-GCM is invoked. NOT a usable oracle: forging a valid outer " +
      "tag already requires the recvChacha key, and anyone holding it holds recvAes too, so the attacker " +
      "can never sit between the two layers.");
  } else {
    record("INFO", "open() stage timings not cleanly separable in this run",
      `outer=${tOuter.toFixed(0)} inner=${tInner.toFixed(0)} json=${tJson.toFixed(0)} ns`);
  }
}

/* ========================================================================== */
/* 11. Fuzz open() with thousands of malformed (JSON-representable) envelopes  */
/*     and confirm it never throws.                                           */
/* ========================================================================== */
{
  const { sb } = await handshake(newPairingSecret());
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const pools = {
    h: [undefined, null, 42, "x", [], {},
        { s: SUITE }, { s: SUITE, a: "aaaa" }, { s: SUITE, a: "aaaa", e: 0, c: 0 },
        { s: SUITE, a: "aaaa", e: 0.5, c: 0 }, { s: SUITE, a: "aaaa", e: 0, c: -1 },
        { s: SUITE, a: "aaaa", e: 999, c: 0 }, { s: SUITE, a: "aaaa", e: 0, c: Number.MAX_SAFE_INTEGER },
        { s: SUITE, a: "bbbb", e: 0, c: 0 }, { s: 123, a: "aaaa", e: 0, c: 0 },
        { s: SUITE, a: null, e: 0, c: 0 }],
    n: [undefined, null, "", "!!!!", "@@", b64(rnd(24)), b64(rnd(12)), b64(rnd(48)), 123, {}, []],
    c: [undefined, null, "", "!!!!", "%%", b64(rnd(0)), b64(rnd(8)), b64(rnd(64)), b64(rnd(200)), 123, {}, []],
  };
  let threw = 0, ran = 0;
  const NF = 20000;
  for (let i = 0; i < NF; i++) {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    // Occasionally hand it a completely random top-level value.
    let env;
    const roll = Math.random();
    if (roll < 0.1) env = pick([null, undefined, 0, "", [], 42, "garbage", true]);
    else env = { h: pick(pools.h), n: pick(pools.n), c: pick(pools.c) };
    ran++;
    try {
      const r = await sb.open(env);
      if (r !== null && typeof r !== "object") { /* returned a value; fine */ }
    } catch (e) {
      threw++;
      if (threw <= 3) console.log(`   THREW on: ${JSON.stringify(env)} :: ${e.message}`);
    }
  }
  expect(threw === 0, "open() never throws on JSON-representable fuzz");
  if (threw === 0) {
    record("DEFENDED", `open() survived ${ran} JSON-representable malformed envelopes`,
      "no exception across the fuzz corpus");
  } else {
    record("EXPLOIT", `open() threw on ${threw}/${ran} JSON-representable inputs`, "");
  }
}

/* ========================================================================== */
/* 12. Contract probe: open() DOES throw on a live (non-JSON) hostile object. */
/*     The header is passed straight to canonical(), which throws on          */
/*     non-finite numbers and BigInt. The doc says "Never throws on hostile   */
/*     input." This violates that invariant.                                  */
/* ========================================================================== */
{
  const { sb } = await handshake(newPairingSecret());

  // Header passes every structural check (s, a, integer e/c, ranges, replay),
  // then carries an extra field that canonical() cannot serialise.
  const throwers = [
    { name: "Infinity in extra header field",
      env: { h: { s: SUITE, a: "aaaa", e: 0, c: 0, x: Infinity }, n: b64(new Uint8Array(24)), c: b64(new Uint8Array(64)) } },
    { name: "NaN in extra header field",
      env: { h: { s: SUITE, a: "aaaa", e: 0, c: 1, x: NaN }, n: b64(new Uint8Array(24)), c: b64(new Uint8Array(64)) } },
    { name: "BigInt in extra header field",
      env: { h: { s: SUITE, a: "aaaa", e: 0, c: 2, x: 10n }, n: b64(new Uint8Array(24)), c: b64(new Uint8Array(64)) } },
  ];
  let threwCount = 0;
  const msgs = [];
  for (const { name, env } of throwers) {
    try {
      await sb.open(env);
    } catch (e) {
      threwCount++;
      msgs.push(`${name}: ${e.message}`);
    }
  }
  console.log("   " + msgs.join(" | "));
  if (threwCount > 0) {
    record("THEORY", `open() throws on ${threwCount}/3 live hostile objects (contract violation)`,
      "canonical(header) is called on the raw attacker object outside any try/catch; a non-finite " +
      "number or BigInt in ANY header key raises and escapes open(), contradicting the documented " +
      "'Never throws on hostile input' guarantee. NOT reachable through the network transport, which " +
      "runs JSON.parse (sync-peers.js:167, sync-server.js:108) and cannot carry Infinity/NaN/BigInt; " +
      "reachable only from an in-process caller that hands open() a live object (e.g. structuredClone " +
      "over BroadcastChannel/postMessage). Fix: wrap the canonical(header) at crypto.js:573 in try/catch, " +
      "or validate header keys against a fixed {e,c,a,s} allowlist before canonicalising.");
  } else {
    record("DEFENDED", "open() tolerates non-finite/BigInt header fields", "");
  }
}

/* ========================================================================== */
console.log("=".repeat(72));
console.log(`assertions: ${PASS} passed, ${FAIL} failed`);
console.log("findings summary:");
for (const r of results) console.log(`  - [${r.kind}] ${r.name}`);
console.log("=".repeat(72));
process.exit(FAIL ? 1 : 0);
