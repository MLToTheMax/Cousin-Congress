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

## 15. The second red team, and the authorisation fix

A follow-up adversarial pass accepted §13's signature fix and then made a
sharper point: **verifying *who signed* an op is not the same as checking
*whether they may do what it does*.** Two concrete defeats followed, both
reproduced against the real `store.ingest`:

> **A. The relay mints an identity.** `id.announce` is self-authenticating and
> needs no prior trust, so a hostile relay could self-announce a throwaway key,
> then author perfectly-signed ops with it. Signatures were satisfied; the ops
> were still forged.
>
> **B. The confused deputy.** Reducers keyed privileged writes off the
> *payload* — a ballot on `payload.memberId`, the gavel on a wholesale
> `session.set` merge — not off the authenticated signer. So any authenticated
> author could cast *another* member's ballot or overwrite the Chair's password
> simply by naming them in the payload.

The fix is two layers, and both are regression-tested (`tests/transport-authz.test.mjs`,
`tests/authz-fold.test.mjs`).

**Layer 1 — room membership (a symmetric gate the relay cannot pass).** Every
op folded from the network must carry `rmac`, an HMAC‑SHA‑384 over the exact
bytes the signature covers, keyed by a secret **derived from the room PSK**
(`deriveRoomKey`, `HKDF(roomSecret, …, "cousin-congress/v2/op-mac")`). Only a
device that holds the room secret — an actual member — can produce it. The relay
never learned the PSK, so **its ops (including the identity announcement it needs
to bootstrap) are dropped at ingest before signature work even runs.** This
closes defeat A wholesale, and with it the specific PoCs the red team ran (flip a
vote, seize the gavel, impersonate a cousin from the relay).

**Layer 2 — authorisation bound to keys, checked at fold (`js/authz.js`).**
Authority lives in replicated state — `session.chairKeys` and each
`members[id].keys` — and every privileged op is checked against the
**authenticated signer (`op.kid`)**, never the payload:

- A **ballot** counts only if signed by a key bound to that seat (or the Chair).
- **Chamber governance** (open/close votes, lock, moderation, dispatches, the
  docket, the gavel password) requires a **chair key**.
- Binding is **first-writer-wins**: the first key to take the gavel founds the
  chair; the first to claim an unclaimed seat binds it. After that only that key
  — or the Chair — may rebind. Recovery is Chair-driven (`member.resetKeys`,
  `chair.enroll`).

The check runs **at fold time**, as a pure function of the total-ordered log, so
every replica reaches the same verdict and the mesh stays convergent; an
unauthorised op still lives in the log (auditable) but changes nothing. This
closes defeat B for the common case and makes an attempt visible and
Chair-recoverable.

**Three supporting fixes from the same pass:**

- **Key rebind refused.** `KeyDirectory.learn` now keeps the *first* key seen
  for an actor; an unpinned network "rebind" is refused (only a stronger,
  out-of-band **pairing pin** may correct a network-learned key). Silent
  last-writer-wins was an impersonation/DoS primitive.
- **Provisioning window sealed.** Until the verifier is wired, ingest
  **quarantines** network ops instead of folding them structurally, and
  re-checks them against the room MAC once it lands.
- **Envelope limits enforced on ingest.** `validateEnvelope` now runs on the
  fold path (op-size cap, and the HLC's actor component must match the op's
  actor — no borrowing another identity for tie-breaking).

While verifying the fix, a **latent identity-churn bug** surfaced and was fixed:
the long-term key was stored under one fixed IndexedDB slot, so two tabs (shared
DB) clobbered each other's identity and a reload regenerated a fresh key —
silently breaking any binding tied to it. Keys are now stored per replica
(`tests/identity-persist.test.mjs`).

**A third adversarial pass** found and closed two more (`tests/hlc-guest.test.mjs`):

- **HLC clock-poison (was High).** One in-room op carrying a near-maximum `ms`
  dragged a victim's hybrid logical clock into the far future, so the victim's
  *own next* stamp overflowed the wire width and was silently dropped by every
  peer — a persistent, self-inflicted write-partition. `Clock.observe` now clamps
  adoption to a bounded skew (and rolls counter overflow into `ms`), and
  `validateEnvelope` rejects an out-of-range HLC, so a poison op is dropped at
  the gate and cannot take hold even if an old peer gossips one.
- **Guest relay injection (was Med-High).** A scoped guest is room-MAC-exempt, so
  a relay could send an `id.announce` carrying the guest's scope id to slip past
  the item filter, get its throwaway key learned, then fold forged content over
  the shared item. Guests now refuse `id.announce` entirely — the sharer's key is
  pinned during the guest handshake, so no network key-learning is ever needed —
  and the one-item scope is enforced inside `store.ingest` for every path.

Also hardened in the same pass: the per-call ingest batch is capped at
`LIMITS.opsPerMessage` (a hostile server pull can no longer force unbounded
signature work), and `comment.retract` is now Chair-only moderation rather than
open to any member.

A **fourth verification pass** confirmed the above are airtight and found no new
integrity break; it did surface one availability weakness, now fixed
(`tests/vv-frontier.test.mjs`): the version vector we advertised tracked the
*max* seq seen, so a lossy or hostile transport that delivered a later op before
an earlier one left a permanent mid-sequence gap that anti-entropy never healed
(the advertised vector claimed ops we didn't hold). We now advertise the
**gap-free frontier** (`Log.advertisedVv`), so a peer resends from the gap and
already-held ops dedupe on arrival — it can only cause more resends, never fewer,
so convergence is unaffected, and for a gapless log it equals the old value.

A **broad fifth pass** (one attacker per surface) confirmed five surfaces fully
blocked (chair authz, ingest pipeline, cipher cascade, handshake, capability
shares) and found six more issues, all now fixed and regression-tested
(`tests/redteam-round5.test.mjs`):

- **Pairing answer-leg hijack (Critical).** `completeInvite()` absorbed a reply
  ticket without validation, so a hostile answer could overwrite the inviter's
  room secret, demote them to a scoped guest, and pin a chosen key. Fixed: the
  answer leg validates the room, **never adopts a room secret or scope**, and a
  ticket only sets the handshake's *expected* key — never a durable directory
  entry.
- **Key learned before PSK proof (Critical/High).** The mesh handshake wrote a
  peer's key into the trusted directory on `hello`, before key confirmation, so
  a relay that never held the PSK could teach a device a throwaway key. Fixed:
  the durable `directory.learn` now happens only in `#secure()`, **after**
  `checkConfirmation` proves room membership.
- **Compaction refold divergence (Critical).** The refold folded the whole log
  *over the snapshot* (which already contained it); with order-sensitive
  authorisation an op unauthorised at its real position could be resurrected on
  the second application, and replicas that compacted at different points would
  diverge. Fixed: the refold folds from empty (the full log is retained).
- **Id-collision overwrites (High).** A create/post op (`status.post`,
  `chat.post`, `amendment.file`, member-note `news.post`, and **`share.grant`**)
  that reused an existing record's id was scoped to the payload's claimed author,
  so a member could clobber another's record — or re-enable a revoked share.
  Fixed: when the id already exists, authority is the **existing** owner (or the
  chair), matching the retract rules.
- **id.announce DoS (High).** `verifyIdentityOp` decoded the signature without a
  guard, so one malformed announcement threw and stopped the ingest loop. Fixed
  with the same try/catch `verifyOp` uses.
- **Provisioning-window announce (Low).** A network `id.announce` is now
  quarantined until the verifier is wired, closing the last unsealed corner of
  the window.

### Residual risk — stated plainly

- **Same-room founding races.** First-writer-wins is ordered by the HLC, which a
  *same-room* adversary (one who already holds the room PSK — the "family latch"
  tier of §2) could backdate to contest a founding claim **before** the
  legitimate Chair/seat is established. It cannot rewrite an already-established
  binding without being visible and Chair-recoverable, and it does not apply to
  the relay (Layer 1 stops non-members entirely). The specced hardening is to
  **pin the founding Chair fingerprint out-of-band in the invite**, anchoring the
  root to the same channel that already carries the room secret; it is the
  recommended next step.
- **Multi-device / multi-tab seats.** Because authority is per key, a second
  device (or a second browser tab, which is a distinct replica) on an
  already-claimed seat is refused by the mesh until the Chair enrols it
  (Chair's Office → Seats / Chair devices). This is the deliberate cost of
  binding votes to keys instead of to a shared password.
- **Unbounded in-room log growth.** The op log is append-only and retains every
  op (compaction snapshots state, not history), so a *same-room* member can
  append validly-signed **no-effect** ops (e.g. ballots for seats they don't own)
  that fold to nothing but still consume storage and gossip bandwidth. It is
  attributable (every op is signed) and cannot change any tally or binding, and
  the per-message cap bounds any single flood, but there is no per-actor rate
  budget on the fold path — a storage-quota / rate limit is the recommended
  next step for the insider-DoS tier.

---

## 16. The single highest-value hardening available today

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

## 17. Chair recovery — getting the gavel back

Enrolling a new Chair device normally needs an existing Chair device to approve
it. That is the right rule right up until the only Chair device is lost, at
which point it deadlocks: the person who knows the password cannot get their new
phone recognised, and nobody is left who can say yes.

There are two ways out, and they are deliberately different in cost.

### 17.1 The password route (ordinary)

The naive version — "prove you know the password" — does not work. `chairAuth`
is a salted hash sitting in replicated state, so **every replica already holds
everything needed to fabricate a hash-based proof**. A proof has to rest on
something that is *not* in the record.

So when the Chair's password is set, the app mints an ECDSA P-384 keypair and
stores:

| field | where | who can use it |
|---|---|---|
| `chairRecovery.pub` | replicated state | everyone, to verify |
| `chairRecovery.wrapped` | replicated state | only a password holder, to sign |

`wrapped` is the PKCS#8 private key under AES-256-GCM, keyed by
PBKDF2-SHA-256(password, salt, 310 000). The iteration count is high on purpose:
this ciphertext replicates to every device in the chamber, which makes it the one
piece of state worth grinding offline.

Recovery is then: unwrap, sign `cc.chair.recover.v1 ‖ room ‖ kid ‖ ts`, and
dispatch `chair.recover` carrying the signature. Every replica verifies it
against `pub` independently — no surviving Chair device, and no server.

The challenge binds **room**, **device key** and **timestamp**, so a proof
observed on the wire cannot be re-aimed at another device, replayed into another
chamber, or reused later.

**Where it is checked.** The signature is verified in `store.ingest`, beside the
op signatures, because it needs WebCrypto and `authorize()` is synchronous by
design. `authorize()` still enforces the shape — the op must enrol the *signer's
own* key, must carry a proof, and the chamber must have a verifier at all. A
chamber founded before verifiers existed refuses recovery rather than waving it
through.

**What this trades away.** Anyone who learns the Chair's password can enrol a
device without asking. That is a real widening: previously the password alone
unlocked the gavel only on the device typing it. It is accepted deliberately —
the alternative is a family permanently locked out of their own chamber — and it
is why changing the password re-mints the verifier, so the *previous* password
stops recovering anything.

### 17.2 The supermajority route (last resort)

For when the password is gone as well. Two-thirds of the seated chamber may move
the gavel to another seat, subject to two conditions that are both checked in the
fold, on every replica:

1. **A supermajority.** `ceil(seats × 2 / 3)`, minimum 2, each endorsement signed
   by the cousin making it — `authorize()` refuses an endorsement filed in
   someone else's name.
2. **A silent Chair.** Dormancy is measured *inside the record* — the newest op
   anyone authored against the newest op a Chair device authored — never from
   `Date.now()`. That is what lets every replica reach the same verdict from the
   same history. The window is 21 days.

And the strongest guard of the three: **any act by a Chair device clears every
pending petition.** A Chair does not have to notice a petition or argue with it.
Turning up ends it.

When a succession carries, the old Chair's device keys are dropped along with the
gavel — leaving them enrolled would hand the lost device its authority back the
moment it resurfaced.

The entry point is two `<details>` deep at the foot of the About page. That is
not security by obscurity — the rules above are the security — it is so that
nobody stumbles into a constitutional crisis looking for the standing orders.

Covered by `tests/chair-recovery.test.mjs`.

## 18. Red team round 7 — the plumbing, not the primitives

Six defects, four of them critical, found by an adversarial sweep with two
independent skeptics per claim. Every one is fixed and pinned by
`tests/redteam-round7.test.mjs`.

The result worth internalising is not any individual bug. **The cryptography
held everywhere it was attacked** — the seal, the room MAC, the key directory,
the recovery ECDSA construction, guest scoping, pairing tickets, and every
HTML-escaping path survived direct assault with executable proofs. What broke
was the *plumbing around* the trust boundary, in four recognisable shapes:

**A second code path that forgot a check.** `chair.recover`'s password proof was
verified in `ingest()`'s inline loop and nowhere else. `#drainQuarantine` is an
equally valid road into `log.insert` — it re-checked the signature and the room
MAC and released the op unproven. So: send `chair.recover` with a garbage proof
*before* your own `id.announce`, get quarantined for "unknown-author", then
announce. The gavel, to anyone holding the room secret. Fixed by factoring one
`#postVerifyGate(op, source)` that both paths call, so the next async-verified
op type cannot be forgotten on one of them.

**A tally whose halves were measured at different times.** `chair.petition`
banked endorsements permanently but recomputed the supermajority denominator
from the *live* roster. Endorse from seats you control, retract those seats, and
the historical numerator carries a chamber that never agreed — the audit record
even read `{backers: 4, of: 4}`, unanimous. Fixed by recounting backers against
current standing (still seated, still holding the key they signed with), and by
making the selector use the identical expression so the interface cannot show a
tally the rule disagrees with.

**A clock trusted from the wire.** `session.set` shallow-merged its payload, so
`lastOpAt` and `chairLastSeen` — the only two inputs to `chairIsDormant()` —
were settable by any op. Forward: an active Chair reads as decades silent and a
supermajority deposes them. Backward: a lost Chair reads as eternally present
and the chamber's last-resort recovery is destroyed forever. Fixed by stripping
every fold-owned field, and by bounding HLC plausibility at ingest.

The ingest bound deserves a note, because the obvious fold-side fix is wrong.
Capping how far one op may advance the clock was tried and reverted: dormancy
exists to measure a long real silence, so a chamber quiet for a month must be
able to record a month. Wall-clock plausibility needs a trusted `now`, and the
fold has none — it must stay a pure function of the log so replicas converge. So
the window lives at the only layer with a clock, and it **fails open when our own
clock is unusable**: a tablet fresh from a factory reset must not become a device
that can never sync again.

**A sanitiser applied to the wrong grammar.** `esc()` escapes `& < > " '` — correct
for element content and for quoted attribute values. It does not escape the
space character, and `class="member member--${raw(esc(presence))}"` is not an
opaque value: a space ends one class token and starts another. A cousin setting
their own presence to `away frozen-overlay` added the Chair's chamber-lock class
to their own roster card — `position: fixed; inset: 0` over the whole viewport,
carrying their own name and text. A convincing "the Chair has locked the
chamber, send the password to…" screen, built from the app's own CSS,
replicated to every device and surviving reload. Fixed with `cls()` in `js/ui.js`
(identifier characters only) at all four sites.

**And one design that was hardened in name only.** The recovery key is wrapped
under PBKDF2 at 310,000 iterations *because the blob replicates*. But the same
password was also stored as a single SHA-256 `chairAuth`, in the same replicated
record. Nobody grinds the expensive verifier when a cheap one for the same
secret sits beside it — one hash per candidate instead of 310,000, and on a GPU
that is a factor of about a million. Fixed by stretching `chairAuth` (and seat
passwords, which replicate for the same reason) with the same KDF. The algorithm
rides in the hash prefix, so chambers founded earlier keep verifying; and a
legacy hash is re-stored at full strength the moment it is next proved, which is
the one time we legitimately hold the plaintext.

The general lesson for this codebase: **a check that exists once is a check that
exists on one path.** Where a verification cannot live in `authorize()` — because
it is async, or needs a clock — it needs a single named gate that every route
into the log calls, and a test that exercises the route nobody thinks about.
