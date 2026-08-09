/**
 * transport-authz.test.mjs — the red team's follow-up finding, closed.
 *
 * The forgery fix made ingest verify per-op signatures. A second red-team pass
 * showed that was necessary but not sufficient: the relay carries `{t:"ops"}`
 * frames in the clear, so a hostile relay could mint a throwaway identity
 * (self-signed `id.announce`, which needs no prior trust), then author fully
 * SIGNED ops with it — flipping votes and seizing the gavel — because signing
 * authenticates the *author* while the CRDT authorised by *payload*.
 *
 * This suite drives the REAL store.ingest and proves the transport-layer close:
 *
 *   1. The room MAC (rmac) round-trips and rejects tampering / wrong keys.
 *   2. A relay with no room secret cannot get ANY op folded — including the
 *      identity announcement it needs to bootstrap — so PoC 1 (flip a vote) and
 *      PoC 2 (seize the gavel) are dead on arrival.
 *   3. A genuine member (holds the room secret) is unaffected: its rmac'd ops
 *      fold as before.
 *   4. Unpinned key rebind is refused (PoC 3): first-seen wins; a pairing pin
 *      can still correct a network-learned key.
 *   5. The provisioning window folds no network op (quarantine, not accept).
 *   6. Envelope limits are enforced on the fold path (HLC-actor spoof, size).
 */

import { Store } from "../js/store.js";
import {
  Identity,
  KeyDirectory,
  signOp,
  deriveRoomKey,
  macOp,
  verifyOpMac,
  newPairingSecret,
  b64,
} from "../js/crypto.js";
import { SCHEMA_VERSION } from "../js/schema.js";

let failures = 0;
const ok = (n) => console.log(`ok  ${n}`);
const bad = (n, e = "") => {
  failures += 1;
  console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`);
};
const assert = (n, c, e) => (c ? ok(n) : bad(n, e));

const mkOp = (actor, seq, type, payload, hlc) => ({
  actor,
  seq,
  hlc: hlc || `${String(Date.now()).padStart(15, "0")}:${String(seq).padStart(5, "0")}:${actor}`,
  type,
  payload,
  v: SCHEMA_VERSION,
});
const maxHlc = (actor) => `999999999999999:99999:${actor}`;
const wire = (o) => JSON.parse(JSON.stringify(o));

/** A member's device: signs AND room-MACs its ops (it holds the room secret). */
async function memberOp(identity, roomKey, op) {
  const signed = await signOp(identity, op);
  signed.rmac = await macOp(roomKey, signed);
  return wire(signed);
}

/** A store wired the way provision() wires it, for a given room secret. */
async function freshStore(roomKey) {
  const store = new Store();
  store.storage = {
    async putOps() {}, async allOps() { return []; },
    async getMeta() {}, async setMeta() {}, async clearOps() {},
  };
  store.verifier = new KeyDirectory();
  store.roomKey = roomKey || null;
  return store;
}

/* ========================================================================= */
/* 1. Room MAC round-trip                                                    */
/* ========================================================================= */
{
  const secret = newPairingSecret();
  const roomKey = await deriveRoomKey(secret);
  const otherKey = await deriveRoomKey(newPairingSecret());
  const id = await Identity.generate("m.aaaa");
  const op = await signOp(id, mkOp("m.aaaa", 0, "status.post", { id: "s1", memberId: "m.aaaa", text: "hi" }));
  op.rmac = await macOp(roomKey, op);

  assert("valid room MAC verifies", await verifyOpMac(roomKey, op));
  assert("room MAC fails under a different room key", !(await verifyOpMac(otherKey, op)));
  const tampered = { ...op, payload: { ...op.payload, text: "tampered" } };
  assert("room MAC fails when the payload is changed", !(await verifyOpMac(roomKey, tampered)));
  const noMac = { ...op }; delete noMac.rmac;
  assert("missing room MAC fails", !(await verifyOpMac(roomKey, noMac)));
}

/* ========================================================================= */
/* 2 + 3. The relay PoC, and a genuine member unaffected                     */
/* ========================================================================= */
{
  const roomSecret = newPairingSecret();
  const roomKey = await deriveRoomKey(roomSecret);
  const store = await freshStore(roomKey);

  // Honest chair, a real member: knows the room secret, so it MACs its ops, and
  // founds the chair + claims its seat so its own ops are authorised.
  const chair = await Identity.generate("chair.honest");
  await store.verifier.learn("chair.honest", chair.spki);
  const chairKid = chair.fingerprint;

  await store.ingest([await memberOp(chair, roomKey, mkOp("chair.honest", 0, "chair.claim", { kid: chairKid }))], "server");
  await store.ingest([await memberOp(chair, roomKey, mkOp("chair.honest", 1, "member.upsert", { id: "m-chair", name: "Chair" }))], "server");
  await store.ingest([await memberOp(chair, roomKey, mkOp("chair.honest", 2, "member.claimKey", { memberId: "m-chair", kid: chairKid }))], "server");
  await store.ingest([await memberOp(chair, roomKey, mkOp("chair.honest", 3, "vote.open", { id: "v1", title: "Pool?", threshold: "majority" }))], "server");
  await store.ingest([await memberOp(chair, roomKey, mkOp("chair.honest", 4, "ballot.cast", { voteId: "v1", memberId: "m-chair", choice: "yea" }))], "server");
  assert("genuine member's rmac'd + authorised ops fold", store.state.ballots["v1::m-chair"]?.choice === "yea");

  // ---- HOSTILE RELAY (no room secret) ----
  // Step A: mint a throwaway identity and self-announce it — but the relay
  // cannot produce a room MAC, so the announcement is dropped and the key is
  // NEVER learned.
  const mallory = await Identity.generate("mallory.relay");
  const announceNoMac = wire(await signOp(mallory, mkOp("mallory.relay", 0, "id.announce", { spki: b64(mallory.spki) })));
  await store.ingest([announceNoMac], "server");
  assert("relay's un-MAC'd id.announce is dropped (author not learned)", !store.verifier.get("mallory.relay"));

  // Step B: even if it authors a validly-signed ballot for the chair's member,
  // with a maximal HLC, the missing room MAC means it never reaches the fold.
  const forgedBallot = wire(await signOp(mallory, mkOp("mallory.relay", 1, "ballot.cast", { voteId: "v1", memberId: "m-chair", choice: "nay" }, maxHlc("mallory.relay"))));
  const acc1 = await store.ingest([forgedBallot], "server");
  const after = store.select.tally("v1");
  assert("PoC 1 closed: relay cannot flip the vote", after.yea === 1 && after.nay === 0 && acc1.length === 0, `yea=${after.yea} nay=${after.nay}`);

  // Step C: seize-the-gavel op, un-MAC'd, also dropped.
  const seize = wire(await signOp(mallory, mkOp("mallory.relay", 2, "session.set", { chairAuth: { salt: "evil", hash: "s:ATTACKER" }, locked: true }, maxHlc("mallory.relay"))));
  await store.ingest([seize], "server");
  assert("PoC 2 closed: relay cannot seize the gavel", store.state.session.chairAuth === undefined && !store.state.session.locked);

  // Step D: a relay that GUESSES/tampers a MAC (wrong key) is likewise refused.
  const wrongKey = await deriveRoomKey(newPairingSecret());
  const wrongMac = wire({ ...(await signOp(mallory, mkOp("mallory.relay", 3, "id.announce", { spki: b64(mallory.spki) }))), rmac: await macOp(wrongKey, mkOp("mallory.relay", 3, "id.announce", { spki: b64(mallory.spki) })) });
  await store.ingest([wrongMac], "server");
  assert("relay with a wrong-key MAC is still refused", !store.verifier.get("mallory.relay"));
}

/* ========================================================================= */
/* 4. Unpinned key rebind is refused (PoC 3); pinning can still correct       */
/* ========================================================================= */
{
  const dir = new KeyDirectory();
  const jo = await Identity.generate("cousin-jo");
  const evil = await Identity.generate("cousin-jo"); // same actor string, attacker key
  await dir.learn("cousin-jo", jo.spki); // learned over the network (unpinned)
  assert("first-seen key is learned", dir.get("cousin-jo").fingerprint === jo.fingerprint);

  await dir.learn("cousin-jo", evil.spki); // relay tries to rebind, unpinned
  assert("unpinned rebind is refused (first-seen kept)", dir.get("cousin-jo").fingerprint === jo.fingerprint);
  assert("the rebind is surfaced as a conflict", dir.conflicts.length === 1);

  // A pinned key came from a pairing code (strong OOB) — it may correct a
  // weak network-learned entry, but not another pinned one.
  const dir2 = new KeyDirectory();
  await dir2.learn("cousin-al", jo.spki); // unpinned network entry
  await dir2.learn("cousin-al", evil.spki, { pinned: true }); // pairing correction
  assert("a pairing pin corrects an unpinned network key", dir2.get("cousin-al").fingerprint === evil.fingerprint);
  await dir2.learn("cousin-al", jo.spki, { pinned: true }); // cannot re-pin to a different key
  assert("a pinned key cannot be overridden", dir2.get("cousin-al").fingerprint === evil.fingerprint);
}

/* ========================================================================= */
/* 5. Provisioning window folds no network op                                */
/* ========================================================================= */
{
  const store = await freshStore(null);
  store.verifier = null; // crypto not up yet
  const some = await Identity.generate("x.aaaa");
  const op = wire(await signOp(some, mkOp("x.aaaa", 0, "session.set", { locked: true })));
  const acc = await store.ingest([op], "server"); // genuine network source
  assert("no network op folds during the provisioning window", acc.length === 0 && !store.state.session.locked);
  assert("it is held (quarantined), not lost", store.quarantinedOps().length === 1);

  // A trusted import in the same no-verifier state still folds (user's own log).
  const acc2 = await store.ingest([wire(await signOp(some, mkOp("x.aaaa", 1, "news.post", { id: "n1", title: "mine" })))], "import");
  assert("a trusted import still folds with no verifier", acc2.length === 1 && store.state.news.n1?.title === "mine");
}

/* ========================================================================= */
/* 6. Envelope limits are enforced on the fold path                          */
/* ========================================================================= */
{
  const roomSecret = newPairingSecret();
  const roomKey = await deriveRoomKey(roomSecret);
  const store = await freshStore(roomKey);
  const id = await Identity.generate("m.envelope");
  await store.verifier.learn("m.envelope", id.spki);

  // HLC actor component that does not match op.actor — a tie-break identity
  // borrow. validateEnvelope must drop it before any fold.
  const spoof = await memberOp(id, roomKey, mkOp("m.envelope", 0, "news.post", { id: "n-spoof", title: "x" }, "999999999999999:00000:someone-else"));
  await store.ingest([spoof], "server");
  assert("HLC-actor mismatch is dropped by envelope validation", store.state.news["n-spoof"] === undefined);

  // Oversized payload (> opBytes) is dropped.
  const big = await memberOp(id, roomKey, mkOp("m.envelope", 1, "news.post", { id: "n-big", title: "x".repeat(70 * 1024) }));
  await store.ingest([big], "server");
  assert("oversized op is dropped by envelope validation", store.state.news["n-big"] === undefined);
}

console.log(
  failures
    ? `\n${failures} FAILURES`
    : "\ntransport-authz: relay injection closed (rmac), rebind refused, provisioning window sealed, envelope enforced"
);
process.exit(failures ? 1 : 0);
