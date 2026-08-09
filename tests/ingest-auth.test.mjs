/**
 * Regression test for the critical finding the red team confirmed: forged ops
 * must be rejected on the fold path, not merely on the wire.
 *
 * This drives the REAL store.ingest — the exact function the sync coordinator
 * calls for relay-delivered ops — with a KeyDirectory wired in, and proves the
 * three outcomes: authentic ops fold, forgeries are dropped, and ops from an
 * as-yet-unknown author are quarantined (kept, not folded) until an identity
 * announcement releases them.
 */

import { Store } from "../js/store.js";
import { Identity, KeyDirectory, signOp } from "../js/crypto.js";
import { SCHEMA_VERSION } from "../js/schema.js";

let failures = 0;
const ok = (n) => console.log(`ok  ${n}`);
const bad = (n, e = "") => {
  failures += 1;
  console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`);
};
const assert = (n, c, e) => (c ? ok(n) : bad(n, e));

// A store with an in-memory adapter and a wired verifier, like the real app.
async function freshStore() {
  const store = new Store();
  store.storage = {
    async putOps() {},
    async allOps() {
      return [];
    },
    async getMeta() {},
    async setMeta() {},
    async clearOps() {},
  };
  store.verifier = new KeyDirectory();
  return store;
}

const chair = await Identity.generate("chair.aaaa");
const attacker = await Identity.generate("attacker.zzzz");

const store = await freshStore();
// The chamber knows the chair's key (as if from a prior identity announcement).
await store.verifier.learn("chair.aaaa", chair.spki);

const mkOp = (actor, seq, type, payload) => ({
  actor,
  seq,
  hlc: `${String(Date.now()).padStart(15, "0")}:${String(seq).padStart(5, "0")}:${actor}`,
  type,
  payload,
  v: SCHEMA_VERSION,
});

/* --- 1. an authentic, signed op from a known author folds ----------------- */

const good = await signOp(chair, mkOp("chair.aaaa", 0, "bill.upsert", { id: "b1", title: "Real Bill", stage: "introduced" }));
await store.ingest([good], "relay");
assert("authentic signed op is folded", store.state.bills.b1?.title === "Real Bill");

/* --- 2. the exact red-team attack: an unsigned forgery is rejected --------- */

const forgery = mkOp("totally-not-the-chair", 0, "bill.stage", { billId: "b1", stage: "LAW", stageNote: "rammed through by the relay" });
await store.ingest([forgery], "relay");
assert("unsigned forged op is NOT folded", store.state.bills.b1?.stage === "introduced", `stage is ${store.state.bills.b1?.stage}`);

/* --- 3. a forgery that impersonates a KNOWN author is rejected ------------- */

// Attacker re-signs an op claiming to be the chair — but signs with its own key.
const impersonation = await signOp(attacker, mkOp("chair.aaaa", 1, "vote.close", { id: "v1", result: "failed" }));
await store.ingest([impersonation], "relay");
assert("op claiming a known author but signed by another key is rejected", store.state.votes.v1 === undefined);

/* --- 4. transplanted signature is rejected -------------------------------- */

const transplant = { ...mkOp("chair.aaaa", 2, "bill.stage", { billId: "b1", stage: "LAW" }), sig: good.sig, kid: good.kid };
await store.ingest([transplant], "relay");
assert("transplanted signature is rejected", store.state.bills.b1?.stage === "introduced");

/* --- 5. unknown author is quarantined, then released by id.announce -------- */

const newbie = await Identity.generate("newbie.bbbb");
const newbieOp = await signOp(newbie, mkOp("newbie.bbbb", 1, "status.post", { id: "s1", memberId: "newbie.bbbb", text: "hello" }));
// Send the op BEFORE the chamber knows this author's key.
await store.ingest([newbieOp], "relay");
assert("op from unknown author is NOT folded yet", store.state.statuses.s1 === undefined);
assert("but it is quarantined (kept, not lost)", store.quarantinedOps().length === 1);

// Now the newbie's self-signed identity announcement arrives.
const announce = await signOp(newbie, mkOp("newbie.bbbb", 0, "id.announce", { spki: bufToB64(newbie.spki) }));
await store.ingest([announce], "relay");
assert("identity announcement releases the quarantined op", store.state.statuses.s1?.text === "hello");
assert("quarantine is drained", store.quarantinedOps().length === 0);

/* --- 6. networked genesis ops are refused --------------------------------- */

const fakeGenesis = { actor: "genesis", seq: 99, hlc: "000000000000000:00099:genesis", type: "member.upsert", payload: { id: "m-evil", name: "Sneaky", role: "Speaker" }, v: SCHEMA_VERSION };
await store.ingest([fakeGenesis], "relay");
assert("a networked genesis op is refused", store.state.members["m-evil"] === undefined);

function bufToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

console.log(failures ? `\n${failures} FAILURES` : "\ningest-auth: forged ops are rejected, unknown authors quarantined, genesis anchored");
process.exit(failures ? 1 : 0);
