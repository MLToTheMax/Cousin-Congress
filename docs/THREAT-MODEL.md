# Cousin Congress — Threat Model & Attack Surface

This document explains *who can attack a Cousin Congress deployment, how they
would reach it, and what they can and cannot do.* It is the map; the cryptographic
detail lives in [CC-SEAL.md](./CC-SEAL.md), and the code layout in
[ARCHITECTURE.md](./ARCHITECTURE.md).

The one sentence version: **the room secret (PSK) is the wall.** Almost every
way to change shared state requires it, and it never travels over the wire — only
inside pairing codes. An attacker who never received a pairing code, and connects
only over the internet, cannot mutate a single byte of chamber state.

---

## 1. How anyone reaches the mesh at all

There are exactly three transports, and only one of them faces the open internet:

| Transport | Reach | Internet-facing? |
|-----------|-------|------------------|
| **Tabs** (`BroadcastChannel`) | tabs of the same browser on one device | No — local to the device |
| **Peers** (WebRTC data channels) | browser ↔ browser | Only after an **offer/answer exchange** — by hand-copied pairing codes, or brokered by the relay |
| **Relay** (Cloudflare Worker) | any client that knows the relay URL | **Yes — but off by default** (`config.js` ships `apiBase: ""`) |

Consequences:

- **With the shipped config there is no relay, so there is no internet endpoint
  for the mesh.** WebRTC channels only open through pairing codes a human copies,
  so a stranger cannot spontaneously dial a browser. The realistic external
  surface is *empty*.
- Turning on the relay (`apiBase`) adds one internet-facing bridge. The design
  treats it as **fully hostile** — it carries only sealed traffic and signaling,
  and (post-hardening) cannot get any op folded.

---

## 2. The perimeter: the room secret (PSK)

"Connected to *our* mesh" means "holds the room secret." Two gates are keyed to it:

- **Room MAC (`rmac`)** — every network op carries an HMAC keyed by a secret
  derived from the PSK. An op without a valid one is dropped at ingest **before it
  can change state**. A non-member cannot forge it.
- **Encrypted handshake** — joining as a peer requires proving the PSK in
  key-confirmation. Without it the session never establishes, and (post-hardening)
  no key is even learned.

The PSK travels only inside pairing codes (a QR on a screen, a picture code), never
over any transport. So: **no PSK ⇒ cannot produce a foldable op and cannot join
the mesh.** That single fact partitions the attack surface below.

---

## 3. Adversary tiers

| Tier | What they have | What they can do |
|------|----------------|------------------|
| **T0 — Internet stranger** | The public site + `config.js`; can connect to the relay *if* it's enabled | Read public assets; (relay only) send frames that are **dropped at the rmac gate**; attempt DoS/flooding; attempt a handshake that **fails at confirmation**. Cannot change state. |
| **T1 — Hostile relay** | Sits in the middle of relayed traffic | Drop, reorder, replay, inject — all **ciphertext to it**; injected ops fail the rmac gate. Residual power is **availability** (it can slow or partition sync) and, historically, attacks on scoped guests (now closed). |
| **T2 — Malicious invitee / leaked pairing code** | The PSK (the code *is* the credential) | Is now "in-room." Can author valid ops. Bounded by **fold-time authorization**: cannot cast another claimed seat's ballot, seize an established chair, or rewrite others' records. Can spam no-effect ops (bounded by caps) and contest a *not-yet-founded* claim (documented residual). **Round 7 found three independent routes past "cannot seize an established chair" — all fixed (§6.7); treat this row as a claim the tests must keep earning, not a fact.** |
| **T3 — Compromised device** | Everything that device holds, in plaintext | Full control of that member's identity. Out of scope by design — local-first means the record lives on-device in the clear. |

The security work targets the boundary between **T0/T1 (outside)** and **T2 (inside)**:
make the outside tiers unable to affect integrity, and keep the inside tier from
becoming a confused deputy.

---

## 4. Fold-layer vs transport-layer — why most bugs are "inside only"

State only changes when an op is **folded**. To fold, an op must pass, in order:

1. **Envelope validation** (`schema.js`) — shape, size, HLC sanity.
2. **Room MAC gate** (`store.ingest`) — proves room membership (PSK).
3. **Signature verification** (`crypto.js`) — proves authorship.
4. **Fold-time authorization** (`authz.js`) — proves authority over the action.

Anything that goes wrong at layer 4 (authorization — e.g. the confused-deputy, the
compaction-refold divergence, id-collision overwrites, HLC clock-poison) can only
be *triggered* by an op that already cleared layer 2. So **those are T2 (in-room)
threats**: they require the PSK. An internet stranger (T0) is stopped at layer 2
and never reaches the fold.

The bugs that genuinely mattered for **T0/T1** were the ones at or before layer 2:

- The original **unsigned-op forgery** (layer 3 not enforced) — total remote
  compromise. *Fixed:* signatures verified on ingest.
- **Identity-minting** past signatures — *fixed by the rmac gate (layer 2)*, which
  is the change that actually walled off the internet attacker.
- **Scoped guests**, which are rmac-exempt by necessity (they hold a per-share
  secret, not the room secret) — relay-injection and pre-confirmation key-learning.
  *Fixed:* scope enforced inside ingest, `id.announce` refused in guest mode, keys
  learned only after PSK confirmation.
- **DoS / availability** — malformed-announce crash (*fixed with try/catch*),
  per-message flood (*capped*), version-vector eclipse under a lossy transport
  (*fixed by advertising the gap-free frontier*).

---

## 5. Configuration changes that widen the surface

Three switches move the boundary, each an explicit, documented choice:

- **`apiBase` set (relay on).** Adds the one internet-facing bridge (tier T1). It
  stays untrusted; integrity is unaffected, but availability now depends partly on
  a relay you may not control.
- **`roomSecret` hard-set in config (public room).** Makes the PSK *public* — every
  visitor who loads the page is instantly T2 (in-room). This is the deliberate
  "anyone can join without pairing" mode; only use it when that is what you want.
- **STUN enabled (default on, Chair-toggleable).** Contacts external STUN servers
  for NAT traversal, which reveals a peer's **public IP** to those servers. This is
  a *privacy* consideration, not an injection vector. The Chair can switch STUN off
  for a strictly local-network, no-outside-servers mode.

---

## 5b. Seat codes ("here is your seat")

The Chair can hand a cousin a **seat code** — a deep link (`…/index.html#s=…`)
rendered as a QR — that seats the scanning device as that member and prompts for
a password. It is the ordinary way a family gets onto their phones, so its
properties matter:

- **It is a credential.** It carries the room secret (so the scanner joins the
  right chamber) and names a member, so whoever holds it can enter as that
  cousin. Same honest trade as a pairing code: *the code IS the credential.*
  Show it to one cousin; don't post it publicly.
- **First scanner wins.** Redeeming binds that device's signing key to the seat
  (`member.claimKey`), and the authorisation rules give an unclaimed seat to the
  first key that claims it. A code that leaks *after* the cousin has used it does
  not hand the seat over — a second device is refused until the Chair enrols it
  (Chair's Office → Members → Reset devices to re-issue).
- **The payload never reaches a server.** It lives in the URL *fragment*, which
  browsers do not transmit, so even a hosted deployment never sees it. The app
  scrubs it from the address bar immediately after redeeming, so a screenshot of
  the opened page cannot pass it on.
- **It does not weaken the perimeter.** A seat code is issued by the Chair from
  inside the room; it moves someone from outsider to member deliberately, exactly
  as handing them a pairing code does. It grants no chair authority.

## 6. Residual risks (stated plainly)

Carried from CC-SEAL §15, in decreasing order of concern for a real family deployment:

- **Same-room founding races (T2).** First-writer-wins is ordered by HLC, which a
  same-room adversary could backdate to contest a *not-yet-founded* chair/seat claim.
  It cannot rewrite an already-established binding, and it does not apply to T0/T1.
  Specced hardening: pin the founding Chair fingerprint out-of-band in the invite.
- **Insider log growth (T2).** The append-only log has no per-actor rate budget, so
  an in-room member can spam validly-signed **no-effect** ops (bounded per message,
  attributable, cannot change any tally). Specced: a per-actor storage/rate budget.
- **Multi-device / multi-tab seats (usability).** Authority is per key, so a second
  device on a claimed seat must be Chair-enrolled (request → approve).
- **Compromised device (T3) and leaked pairing code (→ T2).** Out of scope by
  design; the code *is* the credential.

---

## 7. Quick reference — "can an internet stranger…?"

| …do this to a default (no-relay) deployment? | Answer |
|---|---|
| Connect to the mesh at all | **No** — no internet endpoint exists |
| Flip a vote / seize the chair / forge an op | **No** — needs the PSK to fold anything |
| Read chamber state | **No** — never reaches a peer |
| …to a relay-enabled deployment? | |
| Inject a state-changing op | **No** — dropped at the rmac gate |
| Join the encrypted mesh | **No** — handshake fails without the PSK |
| Crash a peer's ingest | **No** — malformed input is caught, batches capped |
| Slow or partition sync (DoS) | **Partially** — inherent to using an untrusted relay; integrity is never affected |
| Attack a live scoped-guest session | **No** (post-hardening) — scope + author are enforced |

*Last updated alongside the fifth red-team round. See CC-SEAL.md §15 for the
per-finding history and the regression tests that pin each fix.*

## 6.7 What round 7 changed about all of this

An adversarial sweep (documented in CC-SEAL §18) found six defects, four
critical, and every one of them lived on the *inside* of the perimeter. The
document's central claim survived intact — **the room secret is still the wall**,
and an attacker without a pairing code could not mutate a byte in any test. What
was wrong was this document's account of what an in-room device *cannot* do once
it is through that wall. Three separate roads led an ordinary cousin to a
permanent, convergent, mesh-wide chair takeover. All three are closed and
pinned by `tests/redteam-round7.test.mjs`, but the correction to record is:

**§3's T2 row was too confident.** "Cannot seize an established chair" was a
statement about intent, not a proven property. It is now a claim the test suite
has to keep earning.

### Residuals now stated plainly

**A pairing code is a gavel-equivalent secret, not merely a room ticket.**
Anyone who has ever read one holds the entire replicated record for good. Until
round 7 that record contained a single-SHA-256 verifier of the Chair password,
making the password grindable offline regardless of the expensive KDF protecting
the recovery blob. That specific hole is fixed, but the shape remains: **PSK
possession is a permanent, unrevocable grant of everything the fold trusts.**
Hand pairing codes out accordingly.

**The HLC ceiling is not a security boundary on its own.** The year-2100 bound
in `schema.js` is a sanity check, not a defence: it left 26,928 days of room, and
the fold reads wall time out of that stamp. Ops arriving over the network are now
bounded to a window around the receiving device's clock (`store.js`), which is
where a trusted `now` exists. Two consequences worth knowing: a **trusted import**
(a state file the user chooses to load) deliberately skips that window, so
importing a hostile file is importing hostile time; and the window **fails open**
when the receiving device's own clock is nonsense, because a factory-reset tablet
that can never sync again is a worse outcome than the attack.

**Chair-authority state is monotonic and has no rollback.** A carried succession
clears `chairKeys`; `lastOpAt` and `chairLastSeen` only ever rise. Nothing here
can be undone from inside the app — the remedy is every replica pruning its log,
which is not something a family can execute. This is an accepted residual, and a
chair-attested rollback path is the obvious future work.

**Replicated text that reaches a *class* attribute is a UI-control primitive.**
`esc()` is correct for element content and for quoted attribute values, but it
preserves spaces, so any member-authored value interpolated into `class="…"`
hands the attacker arbitrary CSS selection — including the Chair's own lock
screen, and with it a credible password-phishing surface. The invariant to hold:
**no member-authored value reaches a class, id, style, or event-handler attribute
without allow-listing** (`cls()` in `js/ui.js`, or a known-token table).

**"Low-stakes" unauthenticated ops are only low-stakes if nothing they write
reaches markup structurally.** `comment.post` is deliberately open to any device
past the room-MAC gate. That is defensible for text; it was not defensible while
`comment.stance` reached a class attribute. Tie the exemption to that condition
explicitly whenever a new open op type is added.
