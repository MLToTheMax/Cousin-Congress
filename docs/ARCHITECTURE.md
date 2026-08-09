# Cousin Congress — Complete Application Specification

*Everything needed to rebuild this application from scratch. Read this and you
could re-implement Cousin Congress in any stack without seeing the original
code.*

---

## 1. What it is

Cousin Congress is a **private, local-first, peer-to-peer legislature for a
family**. It lets a group of people (children through adults) run their shared
decisions like a parliament: members take seats, the Chair calls votes, cousins
cast Yea/Nay/Present ballots, bills are drafted and move through a pipeline,
and everything is recorded in a permanent public record.

The defining properties:

- **Static site.** Plain HTML/CSS/JS. No build step, no framework, no npm
  dependencies in shipped code. Hostable on GitHub Pages or any static host,
  or opened from a USB stick.
- **Local-first.** Every device holds the complete record. All actions apply
  locally and instantly; the network is an optimization, never a requirement.
  Works fully offline.
- **Peer-to-peer.** Devices sync directly (WebRTC), across tabs
  (BroadcastChannel), and optionally through a relay. No server is required for
  any core function.
- **End-to-end encrypted.** All peer traffic is doubly encrypted and every
  operation is signed (see `docs/CC-SEAL.md`).
- **Kid-friendly.** Big buttons, emoji, playful copy — but it keeps real
  congressional vocabulary so it teaches as it plays.

---

## 2. Core architecture — the CRDT op log

The entire application state is a **fold over an append-only log of signed
operations** (a CRDT). This is the single most important idea; everything else
follows from it.

### 2.1 Operations

An operation is:

```
{
  actor:   string,   // replica id: "<deviceId>.<tabSuffix>"
  seq:     integer,  // per-actor monotonic sequence, from 0
  hlc:     string,   // hybrid logical clock "<ms>:<counter>:<actor>"
  type:    string,   // e.g. "ballot.cast" (namespace.verb)
  payload: object,   // the operation's data
  v:       integer,  // schema version (currently 2)
  sig:     string,   // ECDSA-P384 signature (base64url) — added after authoring
  kid:     string,   // signer's key fingerprint
}
```

### 2.2 Hybrid Logical Clock (HLC)

Total ordering with a deterministic tiebreak. Format `ms:counter:actor`,
zero-padded so string comparison == chronological comparison:
- `ms` = wall clock, keeps stamps humane;
- `counter` = per-ms counter, survives bursts;
- `actor` = final tiebreak between concurrent writers.
On receiving any op, advance the local clock past the observed stamp (so no
replica with a fast clock permanently wins conflicts).

### 2.3 Reducers (last-writer-wins)

Each op type has a pure reducer `(state, op) -> void`. Two conventions make
everything conflict-free:
- **Entity tables** keyed by id; a `put` does a shallow LWW merge stamped with
  the op's HLC. Later HLC wins.
- **Ballots keyed by `(voteId, memberId)`** — this single key choice makes the
  vote tally a CRDT: two devices casting for the same member converge on the
  later cast, never double-count.
- **Deletes are tombstones** (`_deleted: true`), never removals — you cannot
  replicate a removal to a peer that never saw the thing.

### 2.4 Version vectors & anti-entropy

Each replica keeps `{actor: highestSeq}`. To sync, peers exchange vectors and
send only what the other lacks (the "delta"). A periodic sweep re-exchanges
vectors to heal any gap. Ops gossip onward through every connection, so pairing
with **one** peer converges you on the **whole** mesh.

### 2.5 Convergence guarantee

Because ops are content-addressed (`actor:seq`), carry a totally-ordered HLC,
and every reducer is a commutative LWW merge under that order, **all replicas
that have seen the same set of ops are in byte-identical state, regardless of
arrival order.** Verified in `tests/crdt.test.mjs`.

---

## 3. State shape (the reduced projection)

```
session:        { inSession, recess, sitting, congress, sessionName,
                  chairAuth:{salt,hash}, locked, stun, talkiePolicy,
                  chatPolicy, memberDefaults, ipRules, geoRules, demo }
members:        { id -> { name, icon, role, district, presence, location,
                          auth:{salt,hash}, canChat, canTalk, frozen, frozenBy,
                          dnd, seniority, demo, _deleted } }
committees:     { id -> { name, chair, members[], scope } }
votes:          { id -> { number, title, summary, billId, threshold,
                          state:"open"|"closed", opensAt, closesAt, result } }
ballots:        { "voteId::memberId" -> { choice:"yea"|"nay"|"present", ... } }
bills:          { id -> { number, title, summary, text, sponsor, committee,
                          stage:"drafted"|"introduced"|"committee"|"floor"|"enacted",
                          introduced, session } }
cosponsors:     { "billId::memberId" -> { signed } }
amendments:     { id -> { billId, author, number, text, filed } }
comments:       { id -> { targetId, author, stance, body } }
news:           { id -> { title, category, excerpt, body, author, published,
                          memberNote, authorId } }
docket:         { id -> { title, kind, starts, durationMin, room, note } }
proxies:        { memberId -> { to, scope } }
statuses:       { id -> { memberId, text, location } }
announcements:  { id -> { text, tone, icon, by, until } }
shares:         { id -> { itemType, itemId, by, revoked, revokedBy, expiresAt } }
chat:           { id -> { memberId, name, icon, text } }
```

Op types (namespace.verb): `session.set`, `member.upsert/presence/auth/retract`,
`committee.upsert`, `vote.open/close/retract`, `ballot.cast`,
`bill.upsert/stage/retract`, `cosponsor.add/remove`, `amendment.file/withdraw`,
`comment.post/retract`, `news.post/retract`, `docket.add/remove`,
`proxy.delegate/revoke`, `status.post/retract`, `announce.post/retract`,
`share.grant/revoke`, `chat.post/retract`, `id.announce`.

---

## 4. Persistence

- **IndexedDB** stores the op log (one record per op, keyed `actor:seq`) plus
  meta (clock snapshot, per-replica seq, the non-extractable identity
  `CryptoKey`). Falls back to a localStorage blob in private windows; if even
  that fails, the device runs read-only and says so.
- **Genesis seeding.** `data/seed.json` is deterministically turned into ops
  with fixed ids and fixed zero-timestamps, so every replica derives byte-
  identical genesis ops and they dedupe on contact. Networked genesis ops are
  rejected (trust anchor); each replica self-seeds.

---

## 5. Identity, auth, and the Chair

Three distinct layers, do not conflate them:

1. **Cryptographic identity** (`crypto.js`): a per-device non-extractable
   ECDSA‑P384 keypair. Signs every op. This is the real authenticity layer.
2. **Seat passwords** (`auth.js`): a member claims a seat with a secret word.
   Salted-SHA-256 hashed **client-side**; the hash lives in the replicated
   record. A *UX latch* to stop a younger cousin voting as an older one — not a
   security boundary. Case/space-insensitive, visible text, 3 retries.
3. **The Chair** 🔨: a chamber-wide password (`session.chairAuth`). Gates all
   privileged actions. First chair action sets it; unlock is per-tab
   (sessionStorage).

**Chair-gated actions:** call/close votes, advance a bill's stage, docket
entries, news dispatches, announcements, enroll/reset/retire members, all
moderation (freeze, isolate, disconnect, IP rules), chamber toggles (lock,
STUN, chat/talkie policy), clear demo data.

---

## 6. Networking & sync (`sync.js` + transports)

One wire protocol over three interchangeable transports:

- `sync-tabs.js` — **BroadcastChannel**, same-device tabs.
- `sync-peers.js` — **WebRTC data channels**, browser-to-browser. Encrypted.
- `sync-server.js` — optional **Cloudflare Worker relay** (WebSocket + HTTP
  fallback). Untrusted: carries sealed traffic and signaling only.

**Protocol messages:** `hello{vv}`, `vv{vv}`, `ops{ops}`, `roster{peers}`,
`signal{data}`, `ping`, `bye`, `revoked{shareId}`, `ptt{...}` (walkie audio).

**Full mesh:** on securing a peer, exchange rosters; each device dials every
other device. **Transitive relay:** ops received from a peer are re-sent to
*other* peers (excluding the source), so a node reaches the whole network
through a chain when it can't connect to the origin directly.

**Persistent sessions:** a keepalive ping every 25s keeps NAT bindings and the
relay socket warm; reconnect on `online`/`visibilitychange`.

**Ingest is the security choke point** (`store.ingest`): every op is verified
against the key directory before folding — forgery dropped, unknown author
quarantined until its self-signed `id.announce` arrives, genesis refused.

---

## 7. Encryption (`crypto.js`, `chacha.js`) — see docs/CC-SEAL.md

- **Handshake:** signed hello exchange → ECDH‑P384 → transcript‑bound
  HKDF‑SHA‑384 over `Z ‖ PSK` → directional keys → HMAC key confirmation →
  four-emoji safety word. Suite `CC-P384-AES256GCM-XCHACHA20-HKDFSHA384-v2`.
- **PSK** = 256-bit secret carried only in pairing codes (never on the wire) →
  post-quantum confidentiality of recorded traffic (RFC 8784 style).
- **Seal:** AES‑256‑GCM inside XChaCha20‑Poly1305 (cascade, different cipher
  families), header bound as AAD on both layers, replay window.
- **Per-op signatures:** ECDSA‑P384‑SHA384 over a canonical serialisation, so
  gossiped ops stay authenticated through relays and other peers.
- `chacha.js` implements ChaCha20-Poly1305 / XChaCha20 from RFC 8439 (WebCrypto
  has no ChaCha), verified against the spec's test vectors.

---

## 8. Pairing (`sync-peers.js`, `qr.js`, `qr-decode.js`, `sealcard.js`, `icons.js`)

Pairing carries the room secret out-of-band, four ways, all serverless:
- **Emoji picture code** — a 256-emoji-per-byte encoding of the WebRTC
  handshake + PSK, with a 4-icon match badge both sides compare.
- **QR code** — `qr.js` is a from-scratch ISO/IEC 18004 encoder (all 40
  versions, RS error correction); `qr-decode.js` a full decoder (finder
  location, perspective sampling, RS correction) for scanning or uploading a
  photo. Neither depends on `BarcodeDetector` (absent on Linux/iOS).
- **Seal Card** — the QR restyled as a playful "profile invite" picture in
  primary shapes/colours, keeping luminance contrast so it still scans.
- **Brokered** — with a relay, peers auto-pair (relay sees only the handshake).

---

## 9. The feature catalogue (every screen)

- **Home** (`index.html`): short. Peer-count banner, connect-first gating
  (primary CTA is "Connect" until a peer joins, then Vote/Draft appear),
  "on the floor now" (roster + current vote centered), 8 feature cards.
- **The Floor** (`floor.html`): seating chart (CSS trig arc), presence board,
  check-in, status composer, quorum meter, live docket.
- **Voting** (`voting.html`): tabbed **Open votes** + **Results**. Big
  shape-morphing ballots (cursor becomes green circle / red diamond / yellow
  triangle per choice), live tally with majority line, countdowns, whip board,
  Chair's desk (call a vote), proxy delegation (Rule 9).
- **Bills** (`bills.html`) + **Drafting studio** (`draft.html`): pipeline
  tracker, cosponsors, amendments, public comment, live engrossed-parchment
  preview, autosave. No bill-number field (clerk assigns), no min-lengths.
- **Docket** (`docket.html`): month calendar, filterable schedule, Chair's desk.
- **Newsroom** (`news.html`): official dispatches (Chair) + **member notes**
  (any seat), bulletin signup.
- **Members** (`members.html`): directory with emoji badges + scorecards,
  password seat claiming, **Chair's Office** (enroll with creation-time
  permission toggles + remembered defaults, reset/retire, announcements, clear
  demo), committees, leadership, and the **unified Chair dashboard**.
- **Connect** (`connect.html`): scan/show pairing, peer list with safety words,
  **walkie-talkie** (push-to-talk to all peers, Chair-gated per member),
  **chat** (Chair-enabled per member, off by default), **notifications**, and a
  tech drawer (event log, wire-format viewer, export/import/erase).
- **read.html**: standalone decryptor for share links (memory-only, one item).
- **About** (`about.html`), **404** (`404.html`).

### Moderation & safety (Chair)
- **Freeze/isolate/disconnect** any peer; frozen members get a lock-screen
  overlay ("contact the Chair") and can author nothing.
- **Live connections** view distinguishing members vs guests, with IP + bytes.
- **Connection history log** (who authenticated, when, IP) to spot intruders.
- **IP moderation** (`netrules.js`): allow/block addresses or CIDR ranges,
  optionally per member.
- **Login anomaly classifier** (`watchdog.js`): a tiny local logistic-
  regression model scoring each login (unknown fingerprint, new network,
  member-IP-change, off-hours, rapid reconnect, burst); flags the odd ones to
  the Chair; learns from the Chair's verdicts.
- **Security alerts**: a detected forged/tampered op warns the local user
  ("contact your Chair") and logs to the Chair's security dashboard.
- **Traffic-flow / location map** (`netmap.js`, `geoip.js`): a local network
  graph (nodes=devices, edges=live channels, weight=bytes) plus a world map
  pinning devices by coarse offline IP geolocation (Chair-side only; devices
  never geolocate themselves; STUN Chair-toggleable).
- **Data explorer**: what's stored per table (live vs tombstones), prune/clear.

### Sharing (`share.js`, live shares via `sync.js`)
- **Static capsule**: one item (bill/news/docket) sealed under a fresh
  AES‑256‑GCM key placed in the URL **fragment** (never sent to a server).
  Opens read-only in `read.html`, unlocking only that item.
- **Live scoped guest**: a revocable pairing that connects the guest to the
  mesh but serves them **only** the one item (server-side delta filter);
  Chair or sharer can revoke, which wipes the guest's screen and drops them.

### Notifications (`notify.js`)
Per-device unread list derived from the op stream (vote opened/closed, bill
introduced, announcement, note, member joined, cosponsor, docket, chat, "you
were frozen"), a bell with count, optional Web Notifications.

---

## 10. Presentation / CSS

CSS-first: JavaScript is data plumbing only.
- **Design tokens** (`tokens.css`): primary blue/crimson/brass palette via
  `light-dark()`; night mode is just pinning `color-scheme`.
- **Scroll-driven animations** (`motion.css`): native `animation-timeline`
  with IntersectionObserver fallback; full `prefers-reduced-motion` support.
- **Custom cursor** (`cursor.css`, `cursor.js`): JS publishes two coordinates;
  every morph (circle→square on buttons, tilted square on cards, triangle on
  ballots, per-choice colours, I-bar on text) is a CSS `:has()` rule. Touch
  and keyboard keep native behaviour.
- **CSS-only interaction**: nav, tabs (radio), disclosures, dialogs (`:target`
  + native `<dialog>`), counters (`@property`), meters, pipelines, filtering.
- Stylesheets by role: tokens → base → layout → components → features → pages →
  connect → logo → emoji → moderation → motion → cursor.

---

## 11. Optional server (`worker/`)

A Cloudflare Worker. Purely optional; adds always-on relay + durable op log
(Durable Object per room) + WebRTC signaling + two private flows (constituent
mail, bulletin — stored in D1/KV, never replicated). It validates shape/size,
never content, and is treated as fully untrusted.

---

## 12. Schema versioning & runtime migration (`schema.js`, `migrate.js`)

Ops carry a schema version. An op from a *newer* build is never dropped — it's
quarantined out of the fold and replicated onward, then folded once a converter
arrives. Converters are **declarative JSON manifests** (rename/default/map/… a
fixed vocabulary), fetched from configurable endpoints, applied by a local
interpreter with **no eval / no dynamic import**, optional hash-pinning, and
prototype-pollution guards. This is how future formats (incl. "mix ML-KEM into
the KDF") reach fielded devices without running remote code near the keys.

---

## 13. File map

```
*.html                     12 pages + read.html
css/                       tokens, base, layout, components, features, pages,
                           connect, logo, emoji, moderation, motion, cursor
js/
  config.js                deployment config (apiBase, room, roomSecret, ICE, endpoints)
  crdt.js                  HLC, version vectors, reducers, Log, selectors
  schema.js                op envelope validation, limits, versioning
  migrate.js               declarative runtime converters
  store.js                 IndexedDB persistence, identity, ingest (verify), quarantine
  crypto.js                identity, handshake, seal/open, signOp/verifyOp, KeyDirectory
  chacha.js                ChaCha20/XChaCha20-Poly1305 (RFC 8439)
  sync.js                  coordinator: protocol, mesh, relay, shares, walkie, migrations
  sync-tabs/-server/-peers.js   the three transports
  walkie.js                push-to-talk over the encrypted mesh
  qr.js / qr-decode.js     QR encoder / decoder (dependency-free)
  sealcard.js              themed scannable invite picture
  icons.js / emoji.js      emoji pairing alphabet / 721-emoji picker catalogue
  share.js                 static capability links (fragment key)
  netrules.js              IP/CIDR matching + allow/block policy
  watchdog.js              login anomaly classifier (logistic regression)
  geoip.js / netmap.js     offline IP→place table / traffic + world map
  notify.js                per-device notifications
  views.js                 state → markup renderers for [data-render] regions
  actions.js               delegated [data-action] handlers (all writes)
  chair.js                 unified Chair dashboard + chat controllers
  connect.js               pairing UI, scanner, walkie UI, event log, link banner
  ui.js                    escaping, formatting, toasts, dialog, reveal
  cursor.js                pointer coordinates (morphs are CSS)
  logo.js                  primary-shape logo mark + favicon
  app.js                   boot order + subsystem wiring
data/seed.json             genesis snapshot (flagged demo:true, Chair can clear)
worker/                    optional Cloudflare Worker (DO + D1/KV)
tests/                     *.test.mjs (node) + attacks/ (adversarial)
docs/CC-SEAL.md            the security protocol spec
docs/ARCHITECTURE.md       this file
```

---

## 14. Rebuild checklist

1. CRDT core (`crdt.js`) + tests — get convergence right first.
2. Persistence (`store.js`) + genesis seeding.
3. Crypto (`chacha.js` against RFC vectors, then `crypto.js`) + tests.
4. Ingest verification (the security choke point) + `tests/ingest-auth`.
5. Transports + coordinator; prove two-tab then two-browser sync.
6. Views + actions + pages (static-first, enhance with JS).
7. Pairing (QR/emoji/sealcard) + the mesh.
8. Features: voting, bills, docket, news, members, floor.
9. Chair layer: auth, moderation, dashboard, watchdog, netmap.
10. Shares, walkie, chat, notifications.
11. Polish: logo, cursor, motion, kid-friendly copy.
12. Adversarially pentest; fix; document (CC-SEAL).
```
