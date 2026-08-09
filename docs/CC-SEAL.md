# CC‑SEAL/1 — the Cousin Congress Secure Envelope & Authentication Layer

*A plain-language specification of how Cousin Congress keeps a family's votes,
bills, and voice private and trustworthy as they travel between devices.*

Version 1.0 · Suite `CC-P384-AES256GCM-XCHACHA20-HKDFSHA384-v2`

---

## 1. What this protects, in one paragraph for a parent

When two of your devices talk to each other, everything they say is scrambled
**twice**, with two different kinds of lock, using a secret that only your
devices know — a secret that is created on your device and shared only when you
scan a code or show a picture in person, **never over the internet**. Even the
optional helper server in the middle cannot read your chamber; it only passes
sealed envelopes it cannot open. Every vote and bill is also **signed** like a
letter, so no one — not the server, not even another cousin's device — can forge
one in your name. And because the shared secret never crosses the network, a
future quantum computer that records everything today still cannot unlock it
later. What this does **not** protect: a device someone has physically taken
over, and the seat passwords, which are a friendly latch to stop a younger
cousin voting as an older one — not a bank vault.

---

## 2. Threat model

We write the threat model first, because a security design without one is just
a pile of algorithms.

### In scope — we defend against these

| Adversary | Capability | Defence |
| --- | --- | --- |
| The relay server | Read, drop, reorder, replay, forge, inject every message | End-to-end encryption; it never holds a key |
| The network | Passive recording; active tampering | AEAD + signed handshake |
| A "harvest now, decrypt later" quantum adversary | Records today, breaks ECDH in ~2040 | Pre-shared secret never on the wire (§6) |
| A hostile paired peer | Tries to forge ops as another member, seize the gavel | Per-op signatures + key pinning (§7) |
| Another page on the same origin | Shares BroadcastChannel / storage | Encryption at rest of keys; non-extractable keys |

### Out of scope — stated plainly so nothing over-promises

- **A compromised device.** It holds the record in plaintext by design — that
  is what "local-first" means. If someone has your unlocked phone, they are you.
- **A compromised origin.** The code is served from GitHub Pages; if the page
  itself is malicious, the crypto delivered by that page cannot save you. This
  is true of every web app and is not unique to us.
- **Seat and Chair passwords as cryptographic authority.** They are a UX gate
  (see `auth.js`), hashed and stored in the record. They keep honest people
  honest. They are explicitly *not* the thing standing between an attacker and
  your data — the encryption and signatures are.
- **Traffic analysis and metadata.** The relay learns who is online and when.

---

## 3. The cryptographic suite

Every primitive is one a browser ships natively in WebCrypto, except the
ChaCha family which we implement from RFC 8439 and verify against its published
test vectors (`tests/chacha.test.mjs`). No build step, no dependencies, no
network fetch of code — ever.

| Job | Algorithm | Why this one |
| --- | --- | --- |
| Device identity / signing | ECDSA **P‑384** + SHA‑384 | CNSA-tier, universal WebCrypto support |
| Key agreement | ECDH **P‑384** | Same curve, cofactor 1 (no small-subgroup traps) |
| Key derivation | **HKDF‑SHA‑384** | Standard extract-and-expand |
| Bulk encryption, inner | **AES‑256‑GCM** | Hardware-accelerated on every modern device |
| Bulk encryption, outer | **XChaCha20‑Poly1305** | Different design family; fast in pure software |
| Hashing / fingerprints | **SHA‑384** | Matches the signature hash |
| Pre-shared secret | 256-bit CSPRNG | The post-quantum floor (§6) |
| Randomness | `crypto.getRandomValues` | The only source used, anywhere |

This is CNSA 1.0's top-secret **classical** tier. It is deliberately the
strongest classical suite with universal browser support, rather than a
hand-rolled post-quantum primitive we could not audit (see §6.4).

---

## 4. Identities and trust

Each device generates, on first run, a **non-extractable** ECDSA P‑384 key pair.
Non-extractable means the private half never exists as bytes the page can read;
a script can ask it to sign, but cannot copy it out. It is stored as a live
`CryptoKey` in IndexedDB.

A device's **fingerprint** is the first 16 bytes of `SHA‑384(public key)`,
shown as a short code and — for children — as four emoji.

Author keys are collected in a **trust-on-first-use directory** (`KeyDirectory`):

- The first time we see an actor's key, we record it.
- If that actor's key ever *changes*, we do **not** silently accept it — that is
  exactly what an impersonation attempt looks like. We raise a **conflict** so a
  human can compare fingerprints out of band.
- Keys learned from a **pairing code are pinned**: they came from a QR you
  scanned in person, so nothing a peer merely *asserts* over the network can
  override them.

---

## 5. The handshake

When two devices open a channel, they run a three-message authenticated
handshake before a single vote is allowed across it.

```
  Alice (initiator, smaller actor id)              Bob
  ────────────────────────────────────            ────
  createHello() ──────────────────────────────▶   acceptHello(A)
      { suite, actor, idKey, eph, nonce,           (verifies A's signature,
        dtls, at, sig }                             checks pin, derives keys)
  acceptHello(B)  ◀──────────────────────────── createHello()
  confirmation()  ─────────────────────────────▶  checkConfirmation()
  checkConfirmation() ◀───────────────────────── confirmation()
                     ▼
              channel is SEALED
```

Each hello is **signed** with the sender's long-term key, so it cannot be
swapped or altered. `acceptHello` checks, in order:

1. the suite string matches (no silent downgrade),
2. the hello is from the expected peer and is fresh (replay of an old hello is
   rejected by a timestamp window),
3. the identity key matches the **pinned** fingerprint from the pairing code,
   if one was pinned,
4. the hello's **signature** verifies,
5. the peer did not echo back **our own** DTLS fingerprint (a relay loopback).

Both sides then compute:

```
  Z          = ECDH-P384(my ephemeral priv, peer ephemeral pub)      // 48 bytes
  transcript = SHA-384("cc.transcript.v2" ‖ helloA ‖ helloB)         // binds everything
  master     = HKDF-SHA-384( ikm = Z ‖ PSK, salt = transcript )
  {sendKeys, recvKeys} = HKDF(master, transcript, per-direction info)
```

Because the **transcript binds every field of both helloes**, any tampering
anywhere in the handshake makes the two sides derive different keys, and the
final step fails closed:

**Key confirmation.** Each side proves it derived the same `master` by sending
an HMAC‑SHA‑384 over its own name. If the MACs do not check, the session is
torn down — an attacker who completed an ECDH but could not supply the PSK is
stopped here, unambiguously, instead of being allowed to talk garbage.

Both sides also derive a **safety word** — four emoji from the transcript.
If two cousins see the same four emoji, no one sat in the middle. It is Signal's
"safety number", sized for a seven-year-old.

---

## 6. Post-quantum resistance — precisely what we claim

This is the part most worth being honest about.

### 6.1 The construction

The session key comes from HKDF over **`Z ‖ PSK`**, where:

- `Z` is the classical ECDH shared secret, and
- `PSK` is a **256-bit pre-shared secret** carried **only inside the pairing
  code** — the QR / picture code you scan in person. It is generated by the
  CSPRNG and is **never transmitted over any network in any form.**

### 6.2 What this buys, exactly

Shor's algorithm on a future quantum computer breaks P‑384 outright: an
adversary who recorded your traffic can recover `Z`. It does **nothing** to a
256-bit symmetric secret it never saw. Since the session key needs **both**
`Z` and the `PSK`, and the `PSK` was never in the recorded transcript, the
recorded traffic stays sealed.

This is the same hedge **RFC 8784** standardises for IKEv2 and that TLS 1.3
external PSKs provide. It gives **post-quantum confidentiality of recorded
traffic** — the "harvest now, decrypt later" defence.

### 6.3 What this does NOT buy — stated plainly

- **Post-quantum *authentication*.** Signatures are ECDSA, which a quantum
  computer breaks. So against a *live* attacker *with a quantum computer
  today*, identity can be forged. Against a *recording* attacker who breaks
  things *later*, confidentiality holds. Today, no such computer exists; this
  is a bet about which property matters when one does, and confidentiality of
  the archive is the one you cannot fix after the fact.
- **Any protection if the pairing code leaks.** The code *is* the credential.
  If it was photographed or posted in a public chat, whoever saw it can join
  and, for the quantum case, decrypt. Treat it like a house key. Codes are
  single-use for a connection and expire in about a minute.

### 6.4 Why not ship ML‑KEM (Kyber) instead?

We considered vendoring a real FIPS 203 ML‑KEM implementation. We chose not to,
and the reasoning is part of the spec:

- WebCrypto exposes no ML‑KEM and no SHAKE/Keccak, so we would ship ~2000 lines
  of unauditable lattice math with no constant-time guarantee in a JIT compiler
  (the "KyberSlash" class of timing bugs). A non-constant-time Kyber in
  JavaScript is arguably *worse* than no Kyber.
- The PSK hedge already provides a 256-bit symmetric post-quantum floor using
  **audited, native** code.

When WebCrypto ships ML‑KEM, it slots in as **one more input to the same HKDF**
with no change to anything else here — and the versioned schema (§10) is exactly
how we roll that upgrade out to devices in the field.

---

## 7. Sealing a message — the double lock

Every application message is encrypted twice, under independently derived keys
from **different cipher families**, so that a future break of one cipher leaves
the other standing:

```
  plaintext
    ─▶ AES-256-GCM      (inner; nonce = epoch‖counter, header as AAD)
    ─▶ XChaCha20-Poly1305 (outer; random 24-byte nonce, header as AAD)
    ─▶ { header, outerNonce, ciphertext }
```

- The **header** (`epoch`, `counter`, `actor`, `suite`) travels in the clear
  because the receiver needs it to pick keys — so it is bound as **associated
  data on both layers**. Flip one header byte and both tags fail.
- The **inner nonce** is `epoch ‖ counter`. Because each session derives a
  **fresh key from a fresh ephemeral ECDH**, the AES‑GCM key is unique per
  session, so a counter nonce is never reused under a given key. The outer
  XChaCha nonce is random over 24 bytes — collision probability negligible.
- **Replay** is refused before any crypto runs: a sliding window of seen
  `(epoch, counter)` pairs, and a counter far below the window is dropped. A
  **forged** envelope cannot burn a counter, because the counter is only
  recorded *after* both layers authenticate.
- `open()` **never throws** on hostile input — it returns `null`. Fuzzed with
  thousands of malformed envelopes (`tests/attacks/`), it stays quiet.

### Forward secrecy

A symmetric **ratchet** advances the keys every 50 000 messages (or on demand).
Old keys cannot be derived from the new master, so a key captured later does not
open earlier traffic. Full **post-compromise** recovery needs a fresh ECDH,
which is simply what reconnecting does — and reconnection here is cheap.

---

## 8. Per-operation signatures — trust through the mesh

Channel encryption protects **one hop**. But an op gossips `A → B → C`, and C
must trust an op that came *through* B without B being able to forge it. So
**every operation is signed** with its author's long-term ECDSA key, over a
**canonical** serialisation:

- `canonical()` sorts object keys recursively and rejects non-finite numbers,
  so two devices always sign identical bytes for the same logical op, and two
  *different* ops can never share one signing input.
- `verifyOp` returns a **verdict**, not a boolean: `unknown-author` (keep it,
  mark unverified — it may have arrived before its author's announcement) is
  distinct from `bad-signature` (drop it, loudly). Signature transplant onto a
  different op, or a tampered payload, both fail.

This is what makes gossip through an untrusted relay — or through another
cousin's device — safe.

---

## 9. Pairing — how the secret actually travels

Two paths, both carrying the identity key, DTLS fingerprint, and the room's
`PSK` **only out of band**:

- **Picture / QR code (no server).** One device shows a code; the other scans
  it, uploads a photo of it, or pastes the emoji string. The code can be a
  plain QR or a **Seal Card** — a playful invite picture that is a scannable
  code in disguise (`sealcard.js`), keeping the finder patterns and contrast a
  decoder needs.
- **Brokered (with the relay).** Two devices that *already share the room `PSK`*
  auto-pair; the relay carries only the WebRTC handshake, never a key.

Once paired, devices trade rosters and **every device connects to every other
device** (full mesh), so a vote propagates to all screens at once with no peer
acting as relay-of-record.

---

## 10. Versioning and upgrades

Operations carry a schema version. An op from a *newer* build is **never
discarded** — it is quarantined out of the fold and replicated onward, then
replayed once a converter for it arrives. Converters are fetched at runtime as
**declarative data manifests**, not code (`migrate.js`): a fixed vocabulary of
rename/default/map steps applied by a local interpreter, with **no `eval`, no
dynamic import**, optional **hash-pinning**, and prototype-pollution guards.
This is how a future migration — including "WebCrypto shipped ML‑KEM, mix it
into the KDF" — reaches devices in the field without ever running remote code
next to the keys.

---

## 11. What an attacker gains, by scenario

| Attacker | Against recorded traffic | Against a live session |
| --- | --- | --- |
| The relay (today) | Nothing (sealed) | Nothing (sealed + signed) |
| Network eavesdropper (today) | Nothing | Nothing |
| Quantum adversary (future) | **Nothing** — PSK never recorded | Can forge *identity* (ECDSA), cannot decrypt without PSK |
| Someone who saw your pairing code | Can join and decrypt | Can join |
| Someone with your unlocked device | Everything (by design) | Everything |

The honest conclusion: **the cryptography is very unlikely to be the weak
point.** Endpoint compromise, a malicious browser extension, or the GitHub
Pages trust root are all more realistic than breaking P‑384 + a 256-bit PSK +
AES‑256 + ChaCha20. We spent the effort on the crypto so it is *not* the weak
link; the remaining risks are the ones every web app shares.

---

## 12. Longevity — the numbers

Per-component security level as configured, and what a quantum computer does to
each. This is the honest bottom line: **the cryptography is comfortably the
strongest link, and it is not close.**

| Component | Classical strength | Under a quantum adversary |
| --- | --- | --- |
| ECDH P‑384 (key agreement) | ~192-bit | **Broken by Shor** — but only reveals `Z`, never the PSK |
| ECDSA P‑384 (signatures) | ~192-bit | **Broken by Shor** — affects *live* forgery, not recorded confidentiality |
| AES‑256‑GCM | 256-bit | Grover → ~128-bit effective, and Grover barely parallelises, so this stays out of reach |
| XChaCha20‑Poly1305 | 256-bit | Same as AES‑256: ~128-bit effective, safe |
| The 256-bit PSK | 256-bit | Grover → ~128-bit, and it was **never transmitted**, so a recording attacker has nothing to run Grover *on* |
| HKDF‑SHA‑384 | 192-bit (collision) | ~128-bit under Grover, safe |

**What this means in plain terms.** Against a *classical* attacker, every part
is beyond reach for the foreseeable future (the binding constraint is P‑384's
~192 bits). Against a *future quantum* attacker: **recorded** traffic stays
confidential forever, because the session key needs the PSK and the PSK was
never on the wire (§6). **Live** sessions lose their *authentication* guarantee
once Shor is practical (ECDSA falls), so the migration when WebCrypto ships
ML‑DSA is to add a PQ signature — a versioned schema bump (§10), not a rewrite.

**Timeline.** A cryptographically-relevant quantum computer is widely estimated
at 2030s–2040s. The confidentiality hedge is already in place today; the
authentication migration is a drop-in when the browser primitive arrives.

**Nation-state / APT reality.** Ranked honestly, the crypto is the *least*
likely thing to break. Far more realistic, for any web app, are: a compromised
device, a malicious browser extension, or the GitHub Pages trust root (whoever
serves the page serves the crypto). Those are the residual risks — the ones
every web app shares — and they are exactly why the effort went into making the
cryptography *not* be the weak point.

## 13. The red team, and one critical fix

This protocol was adversarially pentested with **executable** attacks (not just
review), in `tests/attacks/`. The handshake, the cascade AEAD, replay
protection, and the ChaCha primitives all held. One **critical** finding was
confirmed and **fixed**:

> **Op signatures were verified nowhere on the receive path.** `verifyOp`
> existed but was never called, so a hostile relay — which carries ops in
> plaintext — could inject a forged, unsigned op and every device would fold
> it, flipping a vote or seizing the Chair. The signatures were dead weight
> against exactly the adversary they were meant to stop.

The fix (now in `store.ingest`, regression-tested in `tests/ingest-auth.test.mjs`):
every op is authenticated before it is folded — good signature folds, forgery
is dropped loudly, an op from an as-yet-unknown author is **quarantined** (kept
and replicated, but not folded) until a self-signed `id.announce` for that
author arrives, and networked "genesis" ops are refused so the seed cannot be
spoofed. This is what makes the per-op signatures actually protect gossip
through an untrusted relay, as §8 claims.

## 14. Migration triggers

- **WebCrypto ships ML‑KEM** → mix its shared secret into the same HKDF as a
  third IKM input (§6.4). No other change.
- **WebCrypto ships ML‑DSA** → add a PQ signature alongside ECDSA for
  post-quantum *authentication*. A versioned op-envelope bump (§10).
- Both roll out through the runtime converter system without a redeploy.

---

## 13. The single highest-value hardening available today

Compare pairing **safety words** out loud, every time you pair a new device. It
is four emoji, it takes three seconds, and it closes the one gap the pairing
code cannot close on its own: a relay that tries to sit between two auto-pairing
devices is defeated the instant the two humans confirm they see the same four
pictures.

---

*Implementation: `js/crypto.js` (protocol), `js/chacha.js` (RFC 8439 ciphers),
`js/sync-peers.js` (mesh), `js/schema.js` + `js/migrate.js` (versioning).
Conformance and adversarial tests: `tests/chacha.test.mjs`,
`tests/crypto.test.mjs`, `tests/attacks/`.*
