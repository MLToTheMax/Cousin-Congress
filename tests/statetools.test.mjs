/**
 * statetools.test.mjs — the caretaker tools must never rewrite the record.
 *
 * Pruning exists because the log is append-only and a busy chamber gets heavy.
 * The one absolute rule is that it may shrink STORAGE but must never change the
 * folded record — a caretaker tool that quietly loses data is worse than no tool
 * at all.
 *
 * Two real bugs are pinned here, both caught by making prune verify itself:
 *   - dropping a post whose record was later tombstoned lost the fields the
 *     tombstone had merged over (a tombstone is a shallow merge, not a delete);
 *   - "a newer presence op exists" is NOT enough to call an older one dead,
 *     because presence is also a shallow merge — the older op may be the only
 *     source of a field the newer one never set. The rule is a key SUPERSET.
 */

import { Store } from "../js/store.js";
import { measure, findPrunable, prune, editRecord, fmtBytes } from "../js/statetools.js";

let failures = 0;
const assert = (n, c, e) => (c ? console.log(`ok  ${n}`) : (failures++, console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`)));

const freshStore = () => {
  const s = new Store();
  s.storage = { async putOps() {}, async allOps() { return []; }, async getMeta() {}, async setMeta() {}, async clearOps() {} };
  return s;
};

let n = 0;
const mk = (type, payload) => ({
  actor: "a1", seq: n,
  hlc: `${String(1000 + n++).padStart(15, "0")}:00000:a1`,
  type, payload, v: 2,
});

/* --- a chamber with heavy presence churn, moderation, chat and a tombstone -- */
const store = freshStore();
n = 0;
const ops = [mk("member.upsert", { id: "m1", name: "Al" })];
for (let i = 0; i < 40; i++) ops.push(mk("member.presence", { memberId: "m1", presence: "present", checkedInAt: String(i) }));
ops.push(mk("member.presence", { memberId: "m1", frozen: true }));      // different keys — must survive
for (let i = 0; i < 8; i++) ops.push(mk("chat.post", { id: `c${i}`, memberId: "m1", text: "hi" }));
ops.push(mk("news.post", { id: "n1", title: "Keep my title" }));
ops.push(mk("news.retract", { id: "n1" }));
await store.ingest(ops, "import");

const before = measure(store);
const snapshot = JSON.stringify(store.state);

assert("measure counts every op", before.ops === ops.length, `${before.ops} vs ${ops.length}`);
assert("measure reports bytes", before.bytes > 0);
assert("measure breaks down by table, heaviest first", before.byTable[0].bytes >= before.byTable.at(-1).bytes);
assert("measure sees the tombstone", before.records.news.deleted === 1 && before.records.news.live === 0);
assert("measure counts live chat", before.records.chat.live === 8);

/* --- prunable is the superseded presence churn, and nothing else ----------- */
const prunable = findPrunable(store);
assert("superseded presence ops are prunable", prunable.length === 39, `got ${prunable.length}`);
assert("every prunable op is a presence op", prunable.every((op) => op.type === "member.presence"));
assert("the moderation presence op is NOT prunable", !prunable.some((op) => "frozen" in op.payload));
assert("chat is never offered for pruning", !prunable.some((op) => op.type === "chat.post"));
assert("the tombstoned post is NOT prunable", !prunable.some((op) => op.type === "news.post"));

/* --- pruning shrinks storage and leaves the record identical -------------- */
const result = await prune(store);
assert("prune removed the superseded ops", result.removed === 39, `removed ${result.removed}`);
assert("prune freed bytes", result.bytesFreed > 0);
assert("the folded record is byte-for-byte identical", JSON.stringify(store.state) === snapshot);
assert("a field only the older op set survives", store.state.members.m1.checkedInAt === "39");
assert("moderation state survives", store.state.members.m1.frozen === true);
assert("a tombstoned record keeps its merged fields", store.state.news.n1.title === "Keep my title");
assert("the log really is smaller", measure(store).ops === before.ops - 39);

/* --- the version vector still says what we have SEEN ---------------------- */
assert("pruning does not rewind the version vector", store.vv.a1 === ops.length - 1,
  `vv=${store.vv.a1} expected ${ops.length - 1}`);

/* --- pruning twice is a no-op --------------------------------------------- */
const again = await prune(store);
assert("a second prune finds nothing left to do", again.removed === 0);

/* --- editing goes through a normal op ------------------------------------- */
editRecord(store, "members", "m1", { name: "Alice" });
assert("editRecord updates the record", store.state.members.m1.name === "Alice");
assert("editRecord preserves other fields", store.state.members.m1.frozen === true);
let threw = false;
try { editRecord(store, "ballots", "x", {}); } catch { threw = true; }
assert("editRecord refuses a table with no safe edit op", threw);

assert("fmtBytes is human", fmtBytes(1500) === "2 KB" || fmtBytes(1500) === "1 KB");

console.log(failures ? `\n${failures} FAILURES` : "\nstatetools: measurement is honest, pruning is provably state-preserving");
process.exit(failures ? 1 : 0);
