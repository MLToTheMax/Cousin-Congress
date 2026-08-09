/**
 * Convergence properties of the op log, tested on synthetic ops so the suite
 * is independent of whatever demo data the shipped seed happens to carry.
 */

import { Clock, Log, VV, compareOps, fold, select } from "../js/crdt.js";

let failures = 0;
const ok = (n) => console.log(`ok  ${n}`);
const bad = (n, e = "") => {
  failures += 1;
  console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`);
};
const assert = (n, c, e) => (c ? ok(n) : bad(n, e));

const clocks = {};
const stamp = (actor) => (clocks[actor] ||= new Clock(actor)).tick();
const op = (actor, seq, type, payload) => ({ actor, seq, hlc: stamp(actor), type, payload, v: 2 });

/* --- a small chamber built from ops --------------------------------------- */

const base = [
  op("a", 0, "member.upsert", { id: "m1", name: "Ada", role: "Speaker", presence: "present" }),
  op("a", 1, "member.upsert", { id: "m2", name: "Bo", role: "Rep", presence: "present" }),
  op("a", 2, "member.upsert", { id: "m3", name: "Cy", role: "Rep", presence: "remote" }),
  op("a", 3, "vote.open", { id: "v1", title: "Pizza?", threshold: "majority" }),
];

const ballotsA = [
  op("a", 4, "ballot.cast", { voteId: "v1", memberId: "m1", choice: "yea" }),
  op("a", 5, "ballot.cast", { voteId: "v1", memberId: "m2", choice: "yea" }),
];
const ballotsB = [op("b", 0, "ballot.cast", { voteId: "v1", memberId: "m3", choice: "nay" })];

// A conflicting ballot for m1 from device b, later in causal time.
clocks.b.observe(ballotsA[0].hlc);
const conflict = op("b", 1, "ballot.cast", { voteId: "v1", memberId: "m1", choice: "present" });

const build = (batches) => {
  const log = new Log();
  for (const batch of batches) log.insert(batch);
  return log;
};

const s = (log) => JSON.stringify(log.state);

/* --- convergence regardless of order -------------------------------------- */

const r1 = build([base, ballotsA, ballotsB, [conflict]]);
const r2 = build([[conflict], ballotsB, base, ballotsA]);
const r3 = build([ballotsB, base, [conflict], ballotsA]);
assert("three replicas converge regardless of arrival order", s(r1) === s(r2) && s(r2) === s(r3));
assert("conflicting ballot resolves to the causally-later cast", r1.state.ballots["v1::m1"].choice === "present");

/* --- idempotence ---------------------------------------------------------- */

const before = r1.size;
const acc = r1.insert([...base, ...ballotsA, conflict]);
assert("replayed ops are all rejected as duplicates", acc.length === 0 && r1.size === before);

/* --- delta / anti-entropy ------------------------------------------------- */

const empty = new Log();
const delta = r1.delta(empty.vv);
empty.insert(delta);
assert("one delta rebuilds identical state", s(empty) === s(r1));
assert("version vectors match after exchange", VV.equal(empty.vv, r1.vv));

/* --- tally + proxy -------------------------------------------------------- */

const t = select.tally(r1.state, "v1");
assert("tally counts present/yea/nay", t.present === 1 && t.yea === 1 && t.nay === 1, JSON.stringify(t));

// Add a proxy: m3 delegates to m2 (who voted yea). m3 already voted nay itself,
// so its own ballot must still win over the proxy.
const withProxy = build([base, ballotsA, ballotsB, [conflict], [op("a", 6, "proxy.delegate", { memberId: "m3", to: "m2" })]]);
const tp = select.tally(withProxy.state, "v1");
assert("a member's own ballot outranks their proxy", tp.byMember.m3.choice === "nay");

// A member who has NOT voted picks up their proxy's choice.
const m4 = build([
  base,
  [op("a", 7, "member.upsert", { id: "m4", name: "Di", role: "Rep", presence: "away" })],
  [op("a", 8, "proxy.delegate", { memberId: "m4", to: "m1" })],
  ballotsA,
]);
const t4 = select.tally(m4.state, "v1");
assert("an absent member votes via proxy", t4.byMember.m4?.viaProxy === "m1" && t4.byMember.m4?.choice === "yea");

/* --- ordering + compaction ------------------------------------------------ */

const sorted = [...r1.ordered].sort(compareOps);
assert("log is in canonical HLC order", JSON.stringify(sorted.map((o) => o.hlc)) === JSON.stringify(r1.ordered.map((o) => o.hlc)));

r1.compact();
const post = new Log();
post.insert(r1.delta(post.vv));
assert("post-compaction replica still serves full history", s(post) === s(r1));

/* --- tombstones ----------------------------------------------------------- */

const withDelete = build([base, [op("a", 9, "member.retract", { id: "m2" })]]);
assert("retracted member drops out of selectors", !select.members(withDelete.state).some((m) => m.id === "m2"));
assert("but the tombstone is retained in state", withDelete.state.members.m2?._deleted === true);

console.log(failures ? `\n${failures} FAILURES` : "\ncrdt: convergence, idempotence, delta, proxy tally, tombstones all hold");
process.exit(failures ? 1 : 0);
