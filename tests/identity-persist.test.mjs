/**
 * identity-persist.test.mjs — a replica's signing key must be STABLE.
 *
 * Tabs share one IndexedDB. If the long-term key were stored under a single
 * fixed slot, each tab would overwrite the others', and a tab that reloaded or
 * navigated would load a stranger's record, regenerate, and churn its own key —
 * silently breaking every binding tied to it (a claimed seat, the gavel), which
 * is exactly what broke cross-tab voting once authorisation went in.
 *
 * This pins the fix: the same replica id always loads the same key, and two
 * replicas sharing a db never clobber each other.
 */

import { Identity } from "../js/crypto.js";

let failures = 0;
const assert = (n, c) => (c ? console.log(`ok  ${n}`) : (failures++, console.error(`FAIL ${n}`)));

/** One in-memory meta store, shared by "tabs", like a single IndexedDB. */
function sharedDb() {
  const m = new Map();
  return { async getMeta(k) { return m.get(k); }, async setMeta(k, v) { m.set(k, v); } };
}

const db = sharedDb();

// Replica A loads twice (a reload / navigation): same key both times.
const a1 = await Identity.load("dev.aaaa.tab1", db);
const a2 = await Identity.load("dev.aaaa.tab1", db);
assert("same replica id loads a stable fingerprint across reloads", a1.fingerprint === a2.fingerprint);

// Replica B (another tab) loads from the SAME db — a different, independent key.
const b1 = await Identity.load("dev.aaaa.tab2", db);
assert("a second replica gets its own key", b1.fingerprint !== a1.fingerprint);

// ...and loading B must NOT have clobbered A: A still loads its original key.
const a3 = await Identity.load("dev.aaaa.tab1", db);
assert("a second tab does not clobber the first tab's identity", a3.fingerprint === a1.fingerprint);

// B is also stable on its own reload.
const b2 = await Identity.load("dev.aaaa.tab2", db);
assert("the second replica is stable too", b2.fingerprint === b1.fingerprint);

console.log(failures ? `\n${failures} FAILURES` : "\nidentity-persist: per-replica keys are stable and non-clobbering");
process.exit(failures ? 1 : 0);
