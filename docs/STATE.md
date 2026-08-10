# The Shared Record — replicated state reference

There is exactly **one** logical store in Cousin Congress, and every device holds
a complete copy of it. This document is the reference for what is in it: every
table, what writes it, who is allowed to write it, and — the part that matters
for a record that is never deleted — **how each one grows**.

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit,
[CC-SEAL.md](./CC-SEAL.md) for the cryptography, [THREAT-MODEL.md](./THREAT-MODEL.md)
for who can attack it.

---

## 1. Two things, not one

It is easy to conflate them, and almost every question about "the state" is
really a question about which of these you mean:

| | **The log** | **The projection** |
|---|---|---|
| What | An append-only list of signed operations | The materialised `state` object |
| Lives in | IndexedDB (`ops` store), one row per op | Memory, rebuilt by folding the log |
| Truth | **This is the truth.** | Derived; can always be thrown away and recomputed |
| Grows | Forever, by design | Bounded by how many *things* exist |
| Shrinks | Only by compaction/pruning (§5) | When records are tombstoned |

`state = fold(log)`. Nothing writes to `state` directly — a device appends an
op, folds it, and paints. That is what lets two devices that have never met
converge: they exchange ops, sort them by hybrid logical clock, and fold.

**The consequence that surprises people:** deleting something does not make the
record smaller. A delete is a *tombstone* — an op that marks a record deleted —
so a delete makes the log **bigger**. That is not sloppiness; a removal cannot
be replicated to a peer that has not yet seen the thing being removed. §5 covers
what you can actually do about size.

---

## 2. The op envelope

Every entry in the log has this shape:

```js
{
  actor:  "3f9c2a1b8e4d.a71c",  // replica id: device id + per-tab suffix
  seq:    42,                    // per-actor counter, gapless
  hlc:    "001754782301234:00007:3f9c2a1b8e4d.a71c",  // ms:counter:actor
  type:   "ballot.cast",         // which reducer runs
  payload: { ... },              // the data
  v:      2,                     // schema version (schema.js)
  sig:    "…",                   // ECDSA-P384 over the canonical bytes
  kid:    "…",                   // signer's key fingerprint — the authority
  rmac:   "…"                    // HMAC proving the op came from inside the room
}
```

`kid` is the important one for authorisation: **authority is bound to the
signing key, never to what the payload claims.** See §4.

---

## 3. The tables

17 tables. Every record carries `id`, `_hlc` (when it was last written) and
usually `_actor` (which replica wrote it). `_deleted: true` is a tombstone.

### `session` — the chamber itself
One object, not a table. Merged field-by-field by `session.set`.

| Field | Meaning |
|---|---|
| `locked` | No new devices may join |
| `stun` | `false` = local network only, no outside servers |
| `chatPolicy` / `talkiePolicy` | `"all"` or `"chair-picks"` |
| `chairAuth` | `{salt, hash}` — the gavel password |
| `chairSeat` | The member the gavel belongs to (signing in as them *is* being Chair) |
| `chairKeys` | `{kid → {actor, at}}` — enrolled Chair **devices** |
| `chairRequests` | Devices asking to be enrolled |
| `memberDefaults` | Toggles applied to the next new member |
| `sitting`, `demo`, `founded`, `geoRules` | Housekeeping |

`chairKeys` and `chairRequests` are deliberately **not** writable by
`session.set` — only by their own binding ops, so a wholesale merge cannot
smuggle in a Chair key.

### `members` — the cousins
Keyed by `memberId`. The richest record in the system.

| Field | Written by | Notes |
|---|---|---|
| `name`, `icon`, `district`, `seniority` | `member.upsert` | `icon` is an emoji; `avatar` may hold a decorated spec |
| `presence`, `location`, `dnd`, `checkedInAt` | `member.presence` | Changes constantly — see growth |
| `role`, `frozen`, `frozenBy`, `canTalk`, `canChat` | chair only | Moderation fields |
| `auth` | `member.auth` | `{salt, hash}` — the seat password |
| `keys` | `member.claimKey` / `enrollKey` | `{kid → …}` — **devices allowed to act as this member** |
| `pendingKeys` | `member.requestKey` | Devices awaiting Chair approval |

### The legislative tables

| Table | Key | Written by | Notes |
|---|---|---|---|
| `votes` | voteId | `vote.open/close/retract` | `finalTally` frozen at close |
| `ballots` | `${voteId}::${memberId}` | `ballot.cast` | The key choice that makes tallies conflict-free — two devices voting for the same member converge instead of double-counting |
| `bills` | billId | `bill.upsert/stage/retract` | `text` can be long |
| `cosponsors` | `${billId}::${memberId}` | `cosponsor.add/remove` | Add-only with a `signed` flag |
| `amendments` | amendmentId | `amendment.file/withdraw` | |
| `committees` | committeeId | `committee.upsert` | |
| `docket` | eventId | `docket.add/remove` | |
| `proxies` | memberId | `proxy.delegate/revoke` | Resolved at tally time, so a late delegation still counts |

### The talk tables

| Table | Key | Written by | Growth |
|---|---|---|---|
| `statuses` | statusId | `status.post/retract` | **Unbounded** — an append-only feed |
| `news` | newsId | `news.post/retract` | Chair dispatches + member notes (`memberNote: true`) |
| `comments` | commentId | `comment.post/retract` | Pseudonymous; retraction is Chair-only moderation |
| `announcements` | annId | `announce.post/retract` | Shown to unseated devices too; `until` expires them from view (not from the log) |
| `chat` | msgId | `chat.post/retract` | **Unbounded, and the fastest-growing table** |

### The plumbing tables

| Table | Key | Written by | Notes |
|---|---|---|---|
| `shares` | shareId | `share.grant/revoke` | `byKid` records the granting **key**, so only that key or the Chair can re-grant/revoke |
| `devices` | kid | `device.seen/revoke` | Every device that has ever connected: `ip`, `firstSeen`, `lastSeen`, `revoked`. The Chair's roster |

---

## 4. Who may write what

Authorisation is evaluated **at fold time** (`authz.js`), as a pure function of
the state built so far — so every replica reaches the same verdict and nothing
diverges. An unauthorised op still lives in the log (auditable) but changes
nothing.

- **Chair only** — `session.set`, votes, `bill.stage`, docket, announcements,
  committees, `news.post` (official), `comment.retract`, `device.revoke`, and all
  key administration (`chair.enroll`, `member.enrollKey`, `member.resetKeys`).
- **The seat's own key, or the Chair** — `ballot.cast` (strictly), presence,
  `member.auth`, statuses, chat, amendments, cosponsors, proxies, member notes.
- **Owner-of-the-existing-record** — any create/post op that reuses an existing
  `id` is checked against the *existing* record's owner, so one member cannot
  clobber another's record by reusing its id.
- **Anyone in the room** — `id.announce`, `comment.post`, `device.seen`,
  and the request ops (which grant nothing on their own).

---

## 5. Size: what actually grows, and what to do

Everything below is what the Chair's **State tools** panel acts on.

**What grows fastest, in order:** `chat` → `statuses` → `members` (presence
churn: every check-in is another op) → `news`/`comments` → `devices` → `ballots`.

Three distinct operations, which are often confused:

1. **Compact** — fold the log into a snapshot checkpoint. Speeds up start-up.
   **Does not shrink the record**: the ops are deliberately retained, because a
   peer joining with an empty version vector still needs the full history.
2. **Prune** — actually drop ops from this replica's log. Only safe for ops that
   are *superseded*: presence updates older than the newest one for that member,
   tombstoned records nobody references, expired announcements. This shrinks
   storage but means this device can no longer serve that history to a peer that
   never saw it — a trade the Chair should make knowingly.
3. **Retract** — write a tombstone. Makes the log *bigger* but removes the record
   from every view, and replicates. This is the right tool for "get rid of it",
   not for "make it smaller".

---

## 6. Inspecting it yourself

```js
// In the browser console on any page:
CousinCongress.store.state            // the projection
CousinCongress.store.log.ordered      // every op, in fold order
CousinCongress.store.vv               // version vector: {actor → highest seq}
CousinCongress.store.advertisedVv     // the gap-free frontier we tell peers about
CousinCongress.store.quarantinedOps() // held, unauthenticated ops
CousinCongress.store.exportLog()      // the whole record as JSON — this file alone rebuilds the chamber
```

The Chair's **Data explorer** and **State tools** panels expose the same
information without a console, plus the size breakdown and the prune/edit
actions described above.
