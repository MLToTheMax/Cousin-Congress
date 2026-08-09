/**
 * authz-coverage.test.mjs — authorize() must handle every reducer, fail-closed.
 *
 * The red team's structural point: a reducer that mutates state but has no
 * matching case in authorize() would silently inherit the permissive default.
 * authorize() now denies by default, and this test pins the other half — that
 * every op type WITH a reducer is actually reachable when legitimately
 * authorised, so the fail-closed default never accidentally bricks a real op.
 *
 * Strategy: build a state where a chair key exists and a seat is owned by a
 * known key, then for every KNOWN_OP_TYPES assert that SOME legitimate signer
 * (the chair, or the seat owner) is permitted. If a new reducer is added without
 * an authz case, its default-deny makes this fail — which is the alarm we want.
 */

import { KNOWN_OP_TYPES, fold } from "../js/crdt.js";
import { authorize } from "../js/authz.js";

let failures = 0;
const assert = (n, c) => (c ? console.log(`ok  ${n}`) : (failures++, console.error(`FAIL ${n}`)));

const CHAIR = "chairKID";
const OWNER = "ownerKID";

// A minimal folded state: chair founded, member m-al owned by OWNER.
const base = fold([
  { actor: "genesis", seq: 0, hlc: "000000000000000:00000:genesis", type: "member.upsert", payload: { id: "m-al", name: "Al" }, v: 2 },
  { actor: CHAIR, seq: 0, hlc: "000000000000001:00000:CHAIR", type: "chair.claim", payload: { kid: CHAIR }, v: 2, kid: CHAIR },
  { actor: OWNER, seq: 0, hlc: "000000000000002:00000:OWNER", type: "member.claimKey", payload: { memberId: "m-al", kid: OWNER }, v: 2, kid: OWNER },
  // a couple of records so the record-scoped ops have something to target
  { actor: OWNER, seq: 1, hlc: "000000000000003:00000:OWNER", type: "bill.upsert", payload: { id: "b1", sponsor: "m-al" }, v: 2, kid: OWNER },
  { actor: OWNER, seq: 2, hlc: "000000000000004:00000:OWNER", type: "status.post", payload: { id: "s1", memberId: "m-al" }, v: 2, kid: OWNER },
  { actor: OWNER, seq: 3, hlc: "000000000000005:00000:OWNER", type: "share.grant", payload: { id: "sh1", by: "m-al" }, v: 2, kid: OWNER },
  { actor: OWNER, seq: 4, hlc: "000000000000006:00000:OWNER", type: "chat.post", payload: { id: "c1", memberId: "m-al" }, v: 2, kid: OWNER },
  { actor: OWNER, seq: 5, hlc: "000000000000007:00000:OWNER", type: "amendment.file", payload: { id: "a1", author: "m-al" }, v: 2, kid: OWNER },
]);

// A representative legitimate payload per op type (chair or owner may do it).
const payloadFor = (t) => {
  const P = {
    "ballot.cast": { voteId: "v1", memberId: "m-al" },
    "member.presence": { memberId: "m-al" },
    "member.auth": { memberId: "m-al", auth: null },
    "member.retract": { id: "m-al" },
    "member.claimKey": { memberId: "m-al", kid: OWNER },
    "member.enrollKey": { memberId: "m-al", kid: "x" },
    "member.resetKeys": { memberId: "m-al" },
    "chair.claim": { kid: CHAIR },
    "chair.enroll": { kid: "x" },
    "chair.request": { kid: "x" },
    "status.post": { id: "s2", memberId: "m-al" },
    "status.retract": { id: "s1" },
    "cosponsor.add": { billId: "b1", memberId: "m-al" },
    "cosponsor.remove": { billId: "b1", memberId: "m-al" },
    "proxy.delegate": { memberId: "m-al", to: "m-bo" },
    "proxy.revoke": { memberId: "m-al" },
    "chat.post": { id: "c2", memberId: "m-al" },
    "chat.retract": { id: "c1" },
    "amendment.file": { id: "a2", author: "m-al" },
    "amendment.withdraw": { id: "a1" },
    "share.grant": { id: "sh2", by: "m-al" },
    "share.revoke": { id: "sh1" },
    "bill.upsert": { id: "b2", sponsor: "m-al" },
    "bill.retract": { id: "b1" },
    "news.post": { id: "n1", memberNote: true, authorId: "m-al" },
  };
  return P[t] || { id: "x", memberId: "m-al" };
};

// Try both legitimate signers; at least one must be permitted for every type.
for (const t of KNOWN_OP_TYPES) {
  const p = payloadFor(t);
  const okChair = authorize(base, { type: t, payload: p, kid: CHAIR, actor: CHAIR });
  const okOwner = authorize(base, { type: t, payload: p, kid: OWNER, actor: OWNER });
  assert(`authorize handles "${t}" (a legitimate signer is permitted)`, okChair || okOwner);
}

// And the default really is deny: a privileged-looking unknown type is refused.
assert("an unhandled reducer-shaped type is denied by default", authorize(base, { type: "evil.seize", payload: {}, kid: "zzz", actor: "zzz" }) === false);

console.log(failures ? `\n${failures} FAILURES` : `\nauthz-coverage: all ${KNOWN_OP_TYPES.length} op types handled, default is deny`);
process.exit(failures ? 1 : 0);
