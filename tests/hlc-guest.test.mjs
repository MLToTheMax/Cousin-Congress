/**
 * hlc-guest.test.mjs — two red-team breaks from the re-attack pass, closed.
 *
 * A. HLC clock-poison. One in-room op carrying a near-maximum `ms` used to drag
 *    a victim's clock into the far future, so the victim's OWN next stamp
 *    overflowed the wire format and was dropped by every peer — a silent,
 *    persistent, chamber-wide write-partition. Fixed by clamping Clock.observe
 *    to a bounded skew and rejecting out-of-range HLCs at the envelope.
 *
 * B. Guest relay. A scoped guest is room-MAC-exempt (it holds no room secret).
 *    A relay could send an `id.announce` carrying an extra `payload.id` equal to
 *    the guest's scope to slip past the scope filter, get its throwaway key
 *    learned, then fold forged content over the shared item. Fixed by refusing
 *    id.announce entirely in guest mode (the sharer's key is pinned at handshake).
 */

import { Clock } from "../js/crdt.js";
import { validateEnvelope } from "../js/schema.js";
import { Store } from "../js/store.js";
import { Identity, KeyDirectory, signOp, b64 } from "../js/crypto.js";
import { SCHEMA_VERSION } from "../js/schema.js";

let failures = 0;
const ok = (n) => console.log(`ok  ${n}`);
const bad = (n, e = "") => { failures++; console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`); };
const assert = (n, c, e) => (c ? ok(n) : bad(n, e));

/* ======================================================================= */
/* A. HLC clock-poison                                                     */
/* ======================================================================= */
{
  const POISON = "99999999999999999999:00000:evil.actor"; // 20-digit ms
  const poisonOp = { actor: "evil.actor", seq: 0, hlc: POISON, type: "comment.post", payload: { id: "c1" }, v: SCHEMA_VERSION };
  assert("poison op is rejected by validateEnvelope (out of range)", validateEnvelope(poisonOp) === "hlc out of range");

  const clock = new Clock("me.actor");
  clock.observe(POISON); // even if an old peer folds & gossips it, our clock must survive
  const stamp = clock.tick();
  const [ms, count] = stamp.split(":");
  assert("clock ms stays within the wire width after observing poison", ms.length <= 15, `ms=${ms}`);
  assert("clock count stays within its field width", count.length <= 5, `count=${count}`);
  const myNextOp = { actor: "me.actor", seq: 1, hlc: stamp, type: "ballot.cast", payload: { voteId: "v", memberId: "m" }, v: SCHEMA_VERSION };
  assert("our own next op still passes validateEnvelope (not write-partitioned)", validateEnvelope(myNextOp) === null, validateEnvelope(myNextOp));

  // A legitimately skewed clock (a few minutes ahead) is still accepted.
  const soon = new Clock("x");
  soon.observe(`${String(Date.now() + 60_000).padStart(15, "0")}:00000:x`);
  assert("a mildly-ahead peer clock is still adopted", soon.tick().split(":")[0].length <= 15);
}

/* ======================================================================= */
/* B. Guest relay                                                          */
/* ======================================================================= */
{
  function guestStore() {
    const s = new Store();
    s.storage = { async putOps() {}, async allOps() { return []; }, async getMeta() {}, async setMeta() {}, async clearOps() {} };
    s.verifier = new KeyDirectory();
    s.guestMode = true;
    s.guestScopeId = "item1";
    s.roomKey = null; // guests are room-MAC-exempt
    return s;
  }
  const wire = (o) => JSON.parse(JSON.stringify(o));
  const mk = (actor, seq, type, payload) => ({ actor, seq, hlc: `${String(Date.now()).padStart(15, "0")}:${String(seq).padStart(5, "0")}:${actor}`, type, payload, v: SCHEMA_VERSION });

  const store = guestStore();
  const relay = await Identity.generate("relay.evil");

  // Relay tries to teach the guest its key with an id.announce that carries the
  // scope id to slip past the filter.
  const evilAnnounce = wire(await signOp(relay, mk("relay.evil", 0, "id.announce", { spki: b64(relay.spki), id: "item1" })));
  await store.ingest([evilAnnounce], "server");
  assert("guest refuses the relay's id.announce (key NOT learned)", !store.verifier.get("relay.evil"));

  // Relay's forged content for the shared item is not folded (author unknown).
  const forged = wire(await signOp(relay, mk("relay.evil", 1, "bill.upsert", { id: "item1", title: "RELAY FORGERY" })));
  await store.ingest([forged], "server");
  assert("relay cannot fold forged content into the guest", store.state.bills.item1 === undefined);

  // The genuine sharer (key pinned at handshake) is served normally.
  const sharer = await Identity.generate("sharer.real");
  await store.verifier.learn("sharer.real", sharer.spki, { pinned: true });
  const real = wire(await signOp(sharer, mk("sharer.real", 0, "bill.upsert", { id: "item1", title: "The real bill" })));
  await store.ingest([real], "peers");
  assert("the pinned sharer's item still folds for the guest", store.state.bills.item1?.title === "The real bill");

  // And an out-of-scope op from the sharer is still filtered out.
  const other = wire(await signOp(sharer, mk("sharer.real", 1, "bill.upsert", { id: "item2", title: "not shared" })));
  await store.ingest([other], "peers");
  assert("out-of-scope items are never folded for a guest", store.state.bills.item2 === undefined);
}

console.log(failures ? `\n${failures} FAILURES` : "\nhlc-guest: clock-poison neutralised, guest relay-injection closed");
process.exit(failures ? 1 : 0);
