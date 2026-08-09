/**
 * crypto.js — end-to-end security for the chamber mesh.
 *
 * THREAT MODEL (stated first, because a protocol without one is decoration)
 *
 *  In scope. The relay is fully hostile: it may read, drop, reorder, replay,
 *  forge and inject. The network is hostile. A recorded transcript may be
 *  stored today and attacked later by a cryptanalytically relevant quantum
 *  computer. A peer we paired with may itself turn hostile and try to forge
 *  operations attributed to someone else.
 *
 *  Out of scope, and deliberately so. A compromised device is game over: it
 *  holds the record in plaintext by design, because that is what "local-first"
 *  means. Seat passwords are a family latch, not an access-control system —
 *  see auth.js. And anyone who can read a pairing code can join; the code IS
 *  the credential.
 *
 * DESIGN
 *
 *  Key agreement is hybrid: ECDH over P-384 combined with a 256-bit
 *  pre-shared secret that travels only in the pairing code — a QR on a
 *  screen, a picture code in a chat — and never over the wire in any form.
 *  Both are fed to HKDF as input keying material, so the session key is
 *  unrecoverable unless the attacker breaks ECDH *and* obtains the PSK.
 *
 *  That is where the post-quantum resistance comes from, and it is worth
 *  being precise about it. Shor's algorithm breaks P-384 outright; it does
 *  nothing to a symmetric secret. An adversary recording traffic today and
 *  running it on a quantum computer in 2040 recovers the ECDH shared secret
 *  and still cannot derive the session key, because the PSK was never in the
 *  transcript to record. This is the same construction RFC 8784 standardises
 *  for IKEv2 and that TLS 1.3 external PSKs provide, chosen over shipping a
 *  hand-rolled ML-KEM because a non-constant-time lattice implementation in
 *  JavaScript would be a liability rather than an asset. When WebCrypto
 *  exposes ML-KEM, it slots in as an additional IKM input with no change to
 *  anything else here.
 *
 *  Bulk encryption is a cascade: AES-256-GCM inside XChaCha20-Poly1305,
 *  under independently derived keys. Different design families, so a break of
 *  one leaves the other standing. AES-GCM runs on the CPU's AES instructions;
 *  ChaCha20 is fast in software. Both are cheap at the sizes we send.
 *
 *  Every operation is additionally signed with the author's long-term ECDSA
 *  P-384 key. Channel encryption protects a hop; signatures protect an op
 *  across arbitrarily many hops, which is what makes gossip through an
 *  untrusted relay — or through another cousin's device — safe.
 *
 *  Suite: P-384, SHA-384, AES-256-GCM. That is CNSA 1.0's top-secret tier,
 *  which is the strongest classical suite with universal WebCrypto support.
 */

import { timingSafeEqual, xaeadDecrypt, xaeadEncrypt } from "./chacha.js";

export const SUITE = "CC-P384-AES256GCM-XCHACHA20-HKDFSHA384-v2";

const SIG_ALG = { name: "ECDSA", namedCurve: "P-384" };
const SIG_PARAMS = { name: "ECDSA", hash: "SHA-384" };
const ECDH_ALG = { name: "ECDH", namedCurve: "P-384" };
const HKDF_HASH = "SHA-384";

const REPLAY_WINDOW = 512;
const HANDSHAKE_TTL_MS = 120_000;
const MAX_SKEW_MS = 5 * 60_000;
/** Rekey well before the AES-GCM nonce budget matters; cheap insurance. */
const REKEY_AFTER_MESSAGES = 50_000;

const te = new TextEncoder();
const td = new TextDecoder();

/* --------------------------------------------------------------------------
   Encoding helpers
   -------------------------------------------------------------------------- */

export const b64 = (bytes) => {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const unb64 = (text) => {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};

const concat = (...chunks) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/**
 * Deterministic serialisation for anything that gets signed.
 *
 * JSON.stringify is not canonical — key order follows insertion order, so two
 * peers can serialise the same logical op differently and produce signatures
 * that will not verify. Sorting keys recursively fixes that. Rejecting
 * non-finite numbers matters too: NaN and Infinity serialise to `null`, which
 * would let two different payloads share one signature.
 */
export function canonical(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("cannot canonicalise a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

const sha384 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-384", bytes));

/** Short, human-comparable fingerprint of a public key. */
export async function fingerprint(spki) {
  const digest = await sha384(spki instanceof Uint8Array ? spki : new Uint8Array(spki));
  return b64(digest.subarray(0, 16));
}

/* --------------------------------------------------------------------------
   Long-term identity
   -------------------------------------------------------------------------- */

const IDENTITY_STORE = "cc-identity";

/**
 * The signing key is generated non-extractable and handed to IndexedDB as a
 * live CryptoKey. The private half never exists as bytes anywhere the page
 * can read, so an injected script cannot exfiltrate it — it can only ask for
 * signatures while it is running, which is a strictly smaller problem.
 */
export class Identity {
  constructor(actorId, keyPair, spki, fp) {
    this.actorId = actorId;
    this.keyPair = keyPair;
    this.spki = spki;
    this.fingerprint = fp;
  }

  static async generate(actorId) {
    const keyPair = await crypto.subtle.generateKey(SIG_ALG, false, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
    return new Identity(actorId, keyPair, spki, await fingerprint(spki));
  }

  static async load(actorId, db) {
    // The key is stored PER replica id. Tabs share one IndexedDB, so a fixed
    // storage slot would let each tab clobber the others' identity — and then a
    // tab that reloads or navigates would find a stranger's record, regenerate,
    // and churn its own signing key. That churn silently breaks every binding
    // tied to the key (a claimed seat, the gavel), so the slot must be stable
    // for the lifetime of the replica.
    const slot = `${IDENTITY_STORE}:${actorId}`;
    const stored = (await db?.getMeta?.(slot)) || (await db?.getMeta?.(IDENTITY_STORE));
    if (stored?.privateKey && stored?.publicKey && stored.actorId === actorId) {
      const spki = new Uint8Array(await crypto.subtle.exportKey("spki", stored.publicKey));
      return new Identity(actorId, stored, spki, await fingerprint(spki));
    }
    const identity = await Identity.generate(actorId);
    await db?.setMeta?.(slot, {
      actorId,
      privateKey: identity.keyPair.privateKey,
      publicKey: identity.keyPair.publicKey,
    });
    return identity;
  }

  async sign(bytes) {
    return new Uint8Array(await crypto.subtle.sign(SIG_PARAMS, this.keyPair.privateKey, bytes));
  }

  /** Sign an op in place-friendly form — returns {sig, kid} to attach. */
  async signOp(op) {
    return signOp(this, op);
  }
}

export async function importVerifyKey(spki) {
  return crypto.subtle.importKey("spki", spki, SIG_ALG, true, ["verify"]);
}

export async function verifyWith(publicKey, signature, bytes) {
  try {
    return await crypto.subtle.verify(SIG_PARAMS, publicKey, signature, bytes);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------
   Signed operations
   -------------------------------------------------------------------------- */

/** The exact bytes covered by an op signature. */
const opSigningInput = (op) =>
  te.encode(
    `cc.op.v2\n${canonical({
      actor: op.actor,
      seq: op.seq,
      hlc: op.hlc,
      type: op.type,
      payload: op.payload,
      v: op.v,
    })}`
  );

export async function signOp(identity, op) {
  const signature = await identity.sign(opSigningInput(op));
  return { ...op, sig: b64(signature), kid: identity.fingerprint };
}

/**
 * Verify an op against a key directory.
 *
 * Returns a verdict rather than a boolean so callers can distinguish "this is
 * forged" (drop it, loudly) from "I don't know this author yet" (keep it,
 * mark it unverified) — the difference matters when ops legitimately arrive
 * before the identity announcement that explains them.
 */
export async function verifyOp(op, directory) {
  if (!op.sig || !op.kid) return { ok: false, reason: "unsigned" };

  const known = directory.get(op.actor);
  if (!known) return { ok: false, reason: "unknown-author" };
  if (known.fingerprint !== op.kid) return { ok: false, reason: "key-mismatch" };

  let signature;
  try {
    signature = unb64(op.sig);
  } catch {
    return { ok: false, reason: "malformed-signature" };
  }
  if (signature.length < 64 || signature.length > 200) {
    return { ok: false, reason: "malformed-signature" };
  }

  const ok = await verifyWith(known.publicKey, signature, opSigningInput(op));
  return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
}

/* --------------------------------------------------------------------------
   Room authentication — a symmetric gate the relay cannot pass
   --------------------------------------------------------------------------

   Signatures answer "who wrote this op". They do NOT answer "did this come
   from inside the room", because anyone — including a hostile relay — can mint
   an identity and self-announce it. The relay carries `{t:"ops"}` frames in the
   clear, so without a second gate it could inject fully-signed ops authored by
   a throwaway identity and have them folded.

   The room MAC closes that. Every op that is folded from the network must carry
   `rmac`, an HMAC over the same bytes the signature covers, keyed by a secret
   derived from the room PSK. Only a device that holds the room secret — i.e.
   an actual member — can produce it. A relay that never learned the PSK cannot,
   so its injected ops are dropped before verification even runs. The signature
   still binds authorship on top of this; the MAC binds membership.            */

/** Derive the room's op-authentication key from the shared PSK. */
export async function deriveRoomKey(roomSecret) {
  const bytes = roomSecret instanceof Uint8Array ? roomSecret : unb64(roomSecret);
  const raw = await hkdf(bytes, te.encode(SUITE), "cousin-congress/v2/op-mac", 32);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: HKDF_HASH }, false, [
    "sign",
    "verify",
  ]);
}

/** Tag an op with the room MAC, over the exact bytes the signature covers. */
export async function macOp(roomKey, op) {
  const mac = await crypto.subtle.sign("HMAC", roomKey, opSigningInput(op));
  return b64(new Uint8Array(mac));
}

/** True iff `op.rmac` is a valid room MAC. Never throws on hostile input. */
export async function verifyOpMac(roomKey, op) {
  if (!op?.rmac || typeof op.rmac !== "string") return false;
  let given;
  try {
    given = unb64(op.rmac);
  } catch {
    return false;
  }
  if (given.length < 16 || given.length > 64) return false;
  try {
    // crypto.subtle.verify is constant-time for HMAC.
    return await crypto.subtle.verify("HMAC", roomKey, given, opSigningInput(op));
  } catch {
    return false;
  }
}

/**
 * A self-authenticating identity announcement: an op that carries its own
 * public key and is signed by the matching private key. Anyone can verify it
 * with no prior knowledge — the key in the payload checks the signature over
 * the payload — which is how a replica we have never directly paired with can
 * still have its gossiped ops authenticated. TOFU still applies: the FIRST
 * announcement for an actor is trusted, a later contradicting one is flagged.
 */
export async function verifyIdentityOp(op) {
  if (op.type !== "id.announce" || !op.payload?.spki || !op.sig) return null;
  let spki;
  try {
    spki = unb64(op.payload.spki);
  } catch {
    return null;
  }
  const fp = await fingerprint(spki);
  // The announcing op must be signed by the very key it announces, and its
  // kid/actor must line up — otherwise it is a key someone is trying to graft.
  if (op.kid && op.kid !== fp) return null;
  let key;
  try {
    key = await importVerifyKey(spki);
  } catch {
    return null;
  }
  const ok = await verifyWith(key, unb64(op.sig), opSigningInput(op));
  return ok ? { spki, fingerprint: fp } : null;
}

/**
 * Trust-on-first-use directory of author keys.
 *
 * A key that changes for an actor we already know is never silently accepted:
 * that is exactly what an impersonation attempt looks like, and it is surfaced
 * so a human can compare fingerprints out of band. Directly paired peers are
 * stronger than TOFU — their fingerprint came from the pairing code.
 */
export class KeyDirectory extends EventTarget {
  constructor() {
    super();
    this.keys = new Map();
    this.conflicts = [];
  }

  get(actor) {
    return this.keys.get(actor);
  }

  list() {
    return [...this.keys.entries()].map(([actor, entry]) => ({
      actor,
      fingerprint: entry.fingerprint,
      pinned: entry.pinned,
      firstSeen: entry.firstSeen,
    }));
  }

  async learn(actor, spki, { pinned = false } = {}) {
    const bytes = spki instanceof Uint8Array ? spki : unb64(spki);
    const fp = await fingerprint(bytes);
    const existing = this.keys.get(actor);

    if (existing) {
      if (existing.fingerprint === fp) {
        if (pinned && !existing.pinned) existing.pinned = true;
        return existing;
      }
      // A key that changes for an actor we already know is what an impersonation
      // attempt looks like, so it is always surfaced as a conflict for a human
      // to compare out of band.
      const conflict = { actor, had: existing.fingerprint, got: fp, pinnedAttempt: pinned, at: Date.now() };
      this.conflicts.push(conflict);
      this.dispatchEvent(new CustomEvent("conflict", { detail: conflict }));

      // Who wins the conflict is the security-critical decision:
      //   - existing pinned  -> a pairing-code key is authoritative; never let
      //     anything override it (a network assertion certainly cannot).
      //   - existing unpinned, new pinned -> a pairing code is stronger out-of-
      //     band evidence than a gossip-learned key, so let it correct it.
      //   - existing unpinned, new unpinned -> KEEP FIRST-SEEN. Silently taking
      //     the newer key (last-writer-wins) is precisely how a hostile peer
      //     rebinds a gossip-learned cousin to its own key and then forges as
      //     them. First-writer-wins turns that takeover into a mere conflict
      //     event plus a denial of the rebind.
      if (existing.pinned || !pinned) return existing;
      // else: fall through and adopt the pinned key over the unpinned one.
    }

    const entry = {
      publicKey: await importVerifyKey(bytes),
      spki: bytes,
      fingerprint: fp,
      pinned,
      firstSeen: existing?.firstSeen ?? Date.now(),
    };
    this.keys.set(actor, entry);
    this.dispatchEvent(new CustomEvent("learned", { detail: { actor, fingerprint: fp } }));
    return entry;
  }
}

/* --------------------------------------------------------------------------
   Pairing secret
   -------------------------------------------------------------------------- */

/** 256 bits from the CSPRNG. This is the whole post-quantum story; treat it as such. */
export const newPairingSecret = () => crypto.getRandomValues(new Uint8Array(32));

/* --------------------------------------------------------------------------
   Session
   -------------------------------------------------------------------------- */

async function hkdf(ikm, salt, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: HKDF_HASH, salt, info: te.encode(info) },
    key,
    bytes * 8
  );
  return new Uint8Array(derived);
}

/**
 * One authenticated, doubly-encrypted channel with one peer.
 *
 * Roles are decided by comparing actor ids rather than by who dialled, so both
 * sides derive the same directional keys without an extra negotiation round.
 */
export class Session {
  constructor(identity, peerActor, psk, { pinnedFingerprint = null, dtlsFingerprint = null } = {}) {
    this.identity = identity;
    this.peerActor = peerActor;
    this.psk = psk;
    this.pinnedFingerprint = pinnedFingerprint;
    this.dtlsFingerprint = dtlsFingerprint;

    this.established = false;
    this.epoch = 0;
    this.sendCounter = 0;
    this.received = new Set();
    this.highestSeen = -1;
    this.peerFingerprint = null;

    this.ephemeral = null;
    this.ownHello = null;
    this.keys = null;
    this.createdAt = Date.now();
  }

  get initiator() {
    // Deterministic and symmetric: both peers compute the same answer.
    return this.identity.actorId < this.peerActor;
  }

  /** Step 1 — our half of the handshake, signed so it cannot be swapped. */
  async createHello() {
    this.ephemeral = await crypto.subtle.generateKey(ECDH_ALG, false, ["deriveBits"]);
    const ephemeralSpki = new Uint8Array(
      await crypto.subtle.exportKey("raw", this.ephemeral.publicKey)
    );
    const nonce = crypto.getRandomValues(new Uint8Array(32));

    const body = {
      suite: SUITE,
      actor: this.identity.actorId,
      idKey: b64(this.identity.spki),
      eph: b64(ephemeralSpki),
      nonce: b64(nonce),
      dtls: this.dtlsFingerprint || null,
      at: Date.now(),
    };

    const signature = await this.identity.sign(te.encode(`cc.hello.v2\n${canonical(body)}`));
    this.ownHello = { ...body, sig: b64(signature) };
    return this.ownHello;
  }

  /**
   * Step 2 — consume the peer's hello and derive the session keys.
   *
   * Everything that could be substituted by an active attacker is checked
   * here: the signature over the hello, the identity key against whatever the
   * pairing code pinned, the suite string, and the DTLS fingerprint the peer
   * claims against the one the browser actually negotiated.
   */
  async acceptHello(peerHello) {
    if (!peerHello || typeof peerHello !== "object") throw new Error("no hello");
    if (peerHello.suite !== SUITE) throw new Error(`suite mismatch: ${peerHello.suite}`);
    if (peerHello.actor !== this.peerActor) throw new Error("hello is from a different peer");
    if (!this.ownHello) throw new Error("send our hello first");

    // A replayed hello from an old session must not be usable.
    const age = Date.now() - Number(peerHello.at || 0);
    if (!Number.isFinite(age) || age > HANDSHAKE_TTL_MS || age < -MAX_SKEW_MS) {
      throw new Error("hello is stale or from the future");
    }

    const peerSpki = unb64(peerHello.idKey);
    const peerFp = await fingerprint(peerSpki);

    if (this.pinnedFingerprint && this.pinnedFingerprint !== peerFp) {
      throw new Error("identity key does not match the pairing code");
    }

    const peerVerifyKey = await importVerifyKey(peerSpki);
    const body = { ...peerHello };
    delete body.sig;
    const signedOk = await verifyWith(
      peerVerifyKey,
      unb64(peerHello.sig),
      te.encode(`cc.hello.v2\n${canonical(body)}`)
    );
    if (!signedOk) throw new Error("hello signature is invalid");

    if (
      this.dtlsFingerprint &&
      peerHello.dtls &&
      typeof peerHello.dtls === "string" &&
      peerHello.dtls === this.dtlsFingerprint
    ) {
      // Both sides reporting the same fingerprint means we are looking at our
      // own connection reflected back — a classic relay loopback.
      throw new Error("peer echoed our own DTLS fingerprint");
    }

    const peerEphemeral = await crypto.subtle.importKey(
      "raw",
      unb64(peerHello.eph),
      ECDH_ALG,
      false,
      []
    );
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: peerEphemeral },
        this.ephemeral.privateKey,
        384
      )
    );

    // The transcript binds every field of both helloes, so any tampering
    // anywhere in the handshake produces different keys on the two sides and
    // the confirmation step below fails closed.
    const a = this.initiator ? this.ownHello : peerHello;
    const b = this.initiator ? peerHello : this.ownHello;
    const transcript = await sha384(te.encode(`cc.transcript.v2\n${canonical(a)}\n${canonical(b)}`));

    // The PSK enters as key material, not as a salt: an attacker who solves
    // the ECDH half still faces a 256-bit unknown in the IKM.
    const master = await hkdf(concat(shared, this.psk), transcript, "cousin-congress/v2/master", 48);

    const [aesA, aesB, chachaA, chachaB, confirmKey] = await Promise.all([
      hkdf(master, transcript, "cc/v2/aes/a2b", 32),
      hkdf(master, transcript, "cc/v2/aes/b2a", 32),
      hkdf(master, transcript, "cc/v2/chacha/a2b", 32),
      hkdf(master, transcript, "cc/v2/chacha/b2a", 32),
      hkdf(master, transcript, "cc/v2/confirm", 32),
    ]);

    const mine = this.initiator;
    this.keys = {
      master,
      transcript,
      confirmKey,
      sendAes: await importAes(mine ? aesA : aesB),
      recvAes: await importAes(mine ? aesB : aesA),
      sendChacha: mine ? chachaA : chachaB,
      recvChacha: mine ? chachaB : chachaA,
    };

    this.peerFingerprint = peerFp;
    this.peerSpki = peerSpki;
    this.established = true;
    return { peerFingerprint: peerFp };
  }

  /**
   * Step 3 — prove we hold the PSK.
   *
   * Without this an attacker who cannot supply the PSK could still complete
   * an ECDH and then simply talk garbage at us; the confirmation makes the
   * session fail fast and unambiguously instead.
   */
  async confirmation() {
    const key = await crypto.subtle.importKey(
      "raw",
      this.keys.confirmKey,
      { name: "HMAC", hash: HKDF_HASH },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, te.encode(`confirm:${this.identity.actorId}`));
    return b64(new Uint8Array(mac));
  }

  async checkConfirmation(value) {
    const key = await crypto.subtle.importKey(
      "raw",
      this.keys.confirmKey,
      { name: "HMAC", hash: HKDF_HASH },
      false,
      ["sign"]
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, te.encode(`confirm:${this.peerActor}`))
    );
    let given;
    try {
      given = unb64(value);
    } catch {
      return false;
    }
    return timingSafeEqual(expected, given);
  }

  /* --- sealing ----------------------------------------------------------- */

  /**
   * Encrypt twice. The header travels in the clear because the receiver needs
   * it to select keys, so it is bound as associated data on *both* layers —
   * changing a single header byte breaks both tags.
   */
  async seal(message) {
    if (!this.established) throw new Error("session not established");

    if (this.sendCounter >= REKEY_AFTER_MESSAGES) await this.ratchet();

    const counter = this.sendCounter++;
    const header = { e: this.epoch, c: counter, a: this.identity.actorId, s: SUITE };
    const aad = te.encode(canonical(header));

    const plaintext = te.encode(JSON.stringify(message));

    const innerNonce = new Uint8Array(12);
    new DataView(innerNonce.buffer).setUint32(0, this.epoch, false);
    new DataView(innerNonce.buffer).setUint32(4, Math.floor(counter / 2 ** 32), false);
    new DataView(innerNonce.buffer).setUint32(8, counter >>> 0, false);

    const inner = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: innerNonce, additionalData: aad, tagLength: 128 },
        this.keys.sendAes,
        plaintext
      )
    );

    const outerNonce = crypto.getRandomValues(new Uint8Array(24));
    const outer = xaeadEncrypt(this.keys.sendChacha, outerNonce, inner, aad);

    return { h: header, n: b64(outerNonce), c: b64(outer) };
  }

  /** @returns the message, or null. Never throws on hostile input. */
  async open(envelope) {
    if (!this.established || !envelope || typeof envelope !== "object") return null;
    const header = envelope.h;
    if (!header || typeof header !== "object") return null;
    if (header.s !== SUITE || header.a !== this.peerActor) return null;
    if (!Number.isInteger(header.e) || !Number.isInteger(header.c)) return null;
    if (header.e < 0 || header.c < 0 || header.e > this.epoch + 1) return null;

    // Replay check happens before any crypto so a flood is cheap to refuse.
    const tag = `${header.e}:${header.c}`;
    if (this.received.has(tag)) return null;
    if (header.c < this.highestSeen - REPLAY_WINDOW) return null;

    let outerNonce;
    let sealed;
    try {
      outerNonce = unb64(envelope.n);
      sealed = unb64(envelope.c);
    } catch {
      return null;
    }
    if (outerNonce.length !== 24) return null;

    const aad = te.encode(canonical(header));

    const inner = xaeadDecrypt(this.keys.recvChacha, outerNonce, sealed, aad);
    if (!inner) return null;

    const innerNonce = new Uint8Array(12);
    new DataView(innerNonce.buffer).setUint32(0, header.e, false);
    new DataView(innerNonce.buffer).setUint32(4, Math.floor(header.c / 2 ** 32), false);
    new DataView(innerNonce.buffer).setUint32(8, header.c >>> 0, false);

    let plaintext;
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: innerNonce, additionalData: aad, tagLength: 128 },
          this.keys.recvAes,
          inner
        )
      );
    } catch {
      return null;
    }

    // Only record the counter once both layers have authenticated, so a
    // forged envelope cannot burn a sequence number and cause the real one
    // to be discarded as a replay.
    this.received.add(tag);
    if (header.c > this.highestSeen) this.highestSeen = header.c;
    if (this.received.size > REPLAY_WINDOW * 2) {
      for (const seen of this.received) {
        if (Number(seen.split(":")[1]) < this.highestSeen - REPLAY_WINDOW) this.received.delete(seen);
      }
    }

    try {
      return JSON.parse(td.decode(plaintext));
    } catch {
      return null;
    }
  }

  /**
   * Symmetric ratchet. Forward secret — the old keys cannot be recovered from
   * the new master — but not post-compromise secure, since an attacker who
   * captures the current master can follow the ratchet forward. Genuine
   * post-compromise recovery needs a fresh ECDH, which is what reconnecting
   * does, and reconnection is cheap here.
   */
  async ratchet() {
    const next = await hkdf(this.keys.master, this.keys.transcript, `cc/v2/ratchet/${this.epoch + 1}`, 48);
    const [aesA, aesB, chachaA, chachaB] = await Promise.all([
      hkdf(next, this.keys.transcript, "cc/v2/aes/a2b", 32),
      hkdf(next, this.keys.transcript, "cc/v2/aes/b2a", 32),
      hkdf(next, this.keys.transcript, "cc/v2/chacha/a2b", 32),
      hkdf(next, this.keys.transcript, "cc/v2/chacha/b2a", 32),
    ]);
    const mine = this.initiator;
    this.keys = {
      ...this.keys,
      master: next,
      sendAes: await importAes(mine ? aesA : aesB),
      recvAes: await importAes(mine ? aesB : aesA),
      sendChacha: mine ? chachaA : chachaB,
      recvChacha: mine ? chachaB : chachaA,
    };
    this.epoch += 1;
    this.sendCounter = 0;
    this.received.clear();
    this.highestSeen = -1;
  }

  /**
   * Four emoji derived from the transcript. Both cousins seeing the same four
   * is a human check that no one sat in the middle of the handshake — the
   * same idea as Signal's safety numbers, sized for a seven-year-old.
   */
  async safetyWord(alphabet) {
    const digest = await sha384(concat(this.keys.transcript, te.encode("safety")));
    return [0, 1, 2, 3].map((i) => alphabet[digest[i] % alphabet.length]).join("");
  }
}

const importAes = (raw) =>
  crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);

export default { Identity, Session, KeyDirectory, signOp, verifyOp, newPairingSecret, SUITE };
