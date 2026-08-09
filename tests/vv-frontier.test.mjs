/**
 * vv-frontier.test.mjs — anti-entropy must heal a mid-sequence gap.
 *
 * `Log.vv` tracks the MAX seq seen, which is right for dedup but wrong to
 * advertise: if a replica received seqs 0,1,5 for an actor (2–4 dropped or
 * reordered away by a lossy/hostile transport), a max-based advertisement reads
 * 5, so a peer computing the delta assumes 2–4 are already held and never
 * resends them — a permanent gap that later anti-entropy cannot close.
 *
 * `Log.advertisedVv()` advertises the gap-free frontier instead, so the peer
 * resends from the gap; already-held ops dedupe on arrival. This test proves the
 * gap heals with the frontier and would NOT heal with the raw max, and that a
 * gapless log advertises exactly its max (no behaviour change in the common case).
 */

import { Log, VV } from "../js/crdt.js";

let failures = 0;
const assert = (n, c, e) => (c ? console.log(`ok  ${n}`) : (failures++, console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`)));

const A = "alice.aaaa";
const mk = (seq) => ({
  actor: A, seq,
  hlc: `${String(1000 + seq).padStart(15, "0")}:00000:${A}`,
  type: "news.post", payload: { id: `n${seq}` }, v: 2,
});

// Full source replica: has 0..5 contiguously.
const source = new Log();
source.insert([0, 1, 2, 3, 4, 5].map(mk));

// Victim replica: received 0,1,5 — a gap at 2,3,4 (transport reordered/dropped).
const victim = new Log();
victim.insert([mk(0), mk(1), mk(5)]);

assert("victim's raw vv over-reports (max seq = 5)", victim.vv[A] === 5);
assert("victim's advertised frontier stops at the gap (1)", victim.advertisedVv()[A] === 1);

// What the source would send under each advertisement:
const underMax = VV.missing(source.ordered, victim.vv).map((o) => o.seq).sort((a, b) => a - b);
const underFrontier = VV.missing(source.ordered, victim.advertisedVv()).map((o) => o.seq).sort((a, b) => a - b);
assert("raw-max advertisement heals NOTHING (the bug)", underMax.length === 0, `got ${JSON.stringify(underMax)}`);
assert("frontier advertisement resends the gap (2,3,4,5)", JSON.stringify(underFrontier) === "[2,3,4,5]", JSON.stringify(underFrontier));

// Apply the delta and confirm the victim is now whole and converged with source.
victim.insert(VV.missing(source.ordered, victim.advertisedVv()));
assert("victim now holds the full sequence 0..5", [0, 1, 2, 3, 4, 5].every((s) => victim.has(mk(s))));
assert("victim's frontier now equals the source (fully converged)", victim.advertisedVv()[A] === 5);
assert("victim state matches source state after healing", JSON.stringify(victim.state) === JSON.stringify(source.state));

// Common case: a gapless log advertises exactly its max (no extra resends).
assert("a gapless log advertises its max unchanged", source.advertisedVv()[A] === source.vv[A]);

console.log(failures ? `\n${failures} FAILURES` : "\nvv-frontier: mid-sequence gaps heal; gapless logs advertise unchanged");
process.exit(failures ? 1 : 0);
