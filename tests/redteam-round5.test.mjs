/**
 * redteam-round5.test.mjs — the broad-pass findings, closed.
 *
 * Covers the unit-testable fixes from the fifth red-team round:
 *   A. Compaction refold no longer double-applies the log over the snapshot,
 *      so an op unauthorised at its real position stays unauthorised and
 *      replicas converge (crdt.js).
 *   B. Id-collision overwrites: a create/post op that reuses an existing record's
 *      id is scoped to the EXISTING owner, so it cannot clobber another member's
 *      status/note/grant — and cannot resurrect a revoked share (authz.js).
 *   C. verifyIdentityOp returns null (not throws) on a malformed signature, so a
 *      crafted id.announce cannot DoS the ingest loop (crypto.js).
 *   D. A network id.announce during the provisioning window is quarantined, not
 *      folded (store.js).
 *
 * (The pairing-invite and guest-handshake fixes need WebRTC and are covered by
 *  code review; the key-learn-after-confirmation change is exercised indirectly
 *  by the existing handshake attack suite.)
 */

import { Log, fold } from "../js/crdt.js";
import { verifyIdentityOp, Identity, KeyDirectory, signOp, b64 } from "../js/crypto.js";
import { Store } from "../js/store.js";
import { SCHEMA_VERSION } from "../js/schema.js";

let failures = 0;
const ok = (n) => console.log(`ok  ${n}`);
const bad = (n, e = "") => { failures++; console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`); };
const assert = (n, c, e) => (c ? ok(n) : bad(n, e));

let seq = {};
const op = (kid, type, payload, t) => {
  const actor = kid;
  const s = (seq[actor] = (seq[actor] ?? -1) + 1);
  return { actor, seq: s, hlc: `${String(t ?? 1).padStart(15, "0")}:00000:${actor}`, type, payload, v: 2, kid, sig: "x" };
};
const reset = () => (seq = {});
const play = (ops) => { const l = new Log(); l.insert(ops); return l; };

/* ========================================================================= */
/* A. Compaction refold does not resurrect an unauthorised op                */
/* ========================================================================= */
{
  reset();
  // Al casts a ballot BEFORE claiming the seat (t=4), then claims it (t=5).
  const ops = [
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    op("chairK", "vote.open", { id: "v1", threshold: "majority" }, 3),
    op("alK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "yea" }, 4), // pre-claim
    op("alK", "member.claimKey", { memberId: "m-al", kid: "alK" }, 5),
  ];
  const log = play(ops);
  assert("a ballot cast before the seat is claimed does not count", log.state.ballots["v1::m-al"] === undefined);

  // Compact (snapshot now holds Al's binding), then force a refold with a
  // late-arriving low-HLC op. The pre-claim ballot must STILL not count.
  log.compact();
  log.insert([op("chairK", "news.post", { id: "n0" }, 0)]); // t=0 sorts first -> refold
  assert("after compaction + refold the pre-claim ballot still does not count", log.state.ballots["v1::m-al"] === undefined);

  // A ballot cast AFTER claiming does count, and survives compaction.
  reset();
  const ok2 = play([
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    op("alK", "member.claimKey", { memberId: "m-al", kid: "alK" }, 3),
    op("chairK", "vote.open", { id: "v1", threshold: "majority" }, 4),
    op("alK", "ballot.cast", { voteId: "v1", memberId: "m-al", choice: "yea" }, 5),
  ]);
  const before = JSON.stringify(ok2.state.ballots);
  ok2.compact();
  ok2.insert([op("chairK", "news.post", { id: "n0" }, 0)]);
  assert("a properly-claimed ballot counts and is unchanged by compaction", ok2.state.ballots["v1::m-al"]?.choice === "yea");
  assert("compaction does not change the ballots table", JSON.stringify(ok2.state.ballots) === before);
}

/* ========================================================================= */
/* B. Id-collision overwrites are refused                                    */
/* ========================================================================= */
{
  reset();
  const base = [
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    op("chairK", "member.upsert", { id: "m-bo", name: "Bo" }, 3),
    op("alK", "member.claimKey", { memberId: "m-al", kid: "alK" }, 4),
    op("boK", "member.claimKey", { memberId: "m-bo", kid: "boK" }, 5),
    op("alK", "status.post", { id: "s1", memberId: "m-al", text: "Al's status" }, 6),
  ];
  // Bo tries to overwrite Al's status s1 by reusing its id.
  const s = play([...base, op("boK", "status.post", { id: "s1", memberId: "m-bo", text: "HIJACKED" }, 7)]).state;
  assert("a member cannot overwrite another member's status by id-collision", s.statuses.s1.text === "Al's status", s.statuses.s1.text);

  // Share revocation cannot be undone by a stranger re-granting the same id.
  reset();
  const shareOps = [
    op("chairK", "chair.claim", { kid: "chairK" }, 1),
    op("chairK", "member.upsert", { id: "m-al", name: "Al" }, 2),
    op("alK", "member.claimKey", { memberId: "m-al", kid: "alK" }, 3),
    op("alK", "share.grant", { id: "sh1", by: "m-al", itemType: "news", itemId: "n1" }, 4),
    op("chairK", "share.revoke", { id: "sh1", by: "chair" }, 5),
    op("evilK", "share.grant", { id: "sh1", by: "m-evil" }, 6), // stranger re-grants
  ];
  const sh = play(shareOps).state;
  assert("a stranger cannot resurrect a revoked share by re-granting its id", sh.shares.sh1.revoked === true);
  // The original granter (or chair) still can re-grant.
  const sh2 = play([...shareOps.slice(0, 5), op("chairK", "share.grant", { id: "sh1", by: "chair" }, 6)]).state;
  assert("the chair can re-grant a revoked share", sh2.shares.sh1.revoked === false);
}

/* ========================================================================= */
/* C. verifyIdentityOp survives a malformed signature                        */
/* ========================================================================= */
{
  const id = await Identity.generate("m.aaaa");
  const good = { type: "id.announce", payload: { spki: b64(id.spki) }, kid: id.fingerprint, sig: "!!!not base64!!!" };
  let threw = false, result;
  try { result = await verifyIdentityOp(good); } catch { threw = true; }
  assert("verifyIdentityOp does not throw on a malformed signature", !threw);
  assert("verifyIdentityOp returns null on a malformed signature", result === null);
  // A malformed spki is likewise handled.
  const badSpki = { type: "id.announce", payload: { spki: "@@@" }, kid: "x", sig: "y" };
  let threw2 = false;
  try { await verifyIdentityOp(badSpki); } catch { threw2 = true; }
  assert("verifyIdentityOp does not throw on a malformed spki", !threw2);
}

/* ========================================================================= */
/* D. A network id.announce in the provisioning window is quarantined        */
/* ========================================================================= */
{
  const store = new Store();
  store.storage = { async putOps() {}, async allOps() { return []; }, async getMeta() {}, async setMeta() {}, async clearOps() {} };
  store.verifier = null; // provisioning window — crypto not wired yet
  const id = await Identity.generate("newbie.bbbb");
  const announce = JSON.parse(JSON.stringify(await signOp(id, { actor: "newbie.bbbb", seq: 0, hlc: `${String(Date.now()).padStart(15, "0")}:00000:newbie.bbbb`, type: "id.announce", payload: { spki: b64(id.spki) }, v: SCHEMA_VERSION })));
  const acc = await store.ingest([announce], "relay");
  assert("a network id.announce is not folded during the provisioning window", acc.length === 0);
  assert("it is held in quarantine instead", store.quarantinedOps().length === 1);

  // Once a verifier is wired, an announcement is processed normally.
  store.verifier = new KeyDirectory();
  await store.ingest([announce], "relay");
  assert("with a verifier wired, the announcement is learned", Boolean(store.verifier.get("newbie.bbbb")));
}

console.log(failures ? `\n${failures} FAILURES` : "\nredteam-round5: compaction converges, id-collisions refused, id.announce DoS-safe and window-gated");
process.exit(failures ? 1 : 0);
