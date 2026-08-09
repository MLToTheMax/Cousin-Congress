/**
 * store.js — the local-first store.
 *
 * Every action in the building goes through `dispatch`: the op is stamped,
 * folded into memory, painted, written to IndexedDB, and only then handed to
 * whatever transports happen to be connected. Nothing in the UI ever awaits
 * the network, and nothing is lost if no network exists — a client that has
 * never once reached a server still holds the complete, replayable history of
 * everything it did.
 */

import CONFIG from "./config.js";
import { Clock, Log, VV, isValidOp, select } from "./crdt.js";
import { SCHEMA_VERSION, versionOf } from "./schema.js";
import { migrations } from "./migrate.js";
import { verifyOp, verifyIdentityOp } from "./crypto.js";

const DB_NAME = "cousin-congress";
const DB_VERSION = 1;
const OPS_STORE = "ops";
const META_STORE = "meta";

/* ==========================================================================
   Persistence — IndexedDB, with a localStorage shim for private windows
   ========================================================================== */

class IdbAdapter {
  constructor(db) {
    this.db = db;
  }

  static async open() {
    if (typeof indexedDB === "undefined") return null;
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const database = req.result;
          if (!database.objectStoreNames.contains(OPS_STORE)) {
            database.createObjectStore(OPS_STORE, { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains(META_STORE)) {
            database.createObjectStore(META_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("indexeddb blocked"));
      });
      return new IdbAdapter(db);
    } catch {
      return null;
    }
  }

  #tx(store, mode) {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async putOps(ops) {
    if (!ops.length) return;
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(OPS_STORE, "readwrite");
      const store = tx.objectStore(OPS_STORE);
      for (const op of ops) store.put({ id: `${op.actor}:${op.seq}`, op });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async allOps() {
    return new Promise((resolve, reject) => {
      const req = this.#tx(OPS_STORE, "readonly").getAll();
      req.onsuccess = () => resolve(req.result.map((row) => row.op).filter(Boolean));
      req.onerror = () => reject(req.error);
    });
  }

  async getMeta(key) {
    return new Promise((resolve) => {
      const req = this.#tx(META_STORE, "readonly").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
  }

  async setMeta(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(META_STORE, "readwrite");
      tx.objectStore(META_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearOps() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(OPS_STORE, "readwrite");
      tx.objectStore(OPS_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}

/** Last resort: a single localStorage blob. Bounded, but never silently lossy —
 *  it reports failure so the UI can tell the member to export their log. */
class LocalAdapter {
  constructor() {
    this.key = "cc.oplog";
    this.metaKey = "cc.meta";
  }

  async putOps(ops) {
    const all = await this.allOps();
    const byId = new Map(all.map((op) => [`${op.actor}:${op.seq}`, op]));
    for (const op of ops) byId.set(`${op.actor}:${op.seq}`, op);
    localStorage.setItem(this.key, JSON.stringify([...byId.values()]));
  }

  async allOps() {
    try {
      return JSON.parse(localStorage.getItem(this.key) || "[]");
    } catch {
      return [];
    }
  }

  async getMeta(key) {
    try {
      return JSON.parse(localStorage.getItem(this.metaKey) || "{}")[key];
    } catch {
      return undefined;
    }
  }

  async setMeta(key, value) {
    let meta = {};
    try {
      meta = JSON.parse(localStorage.getItem(this.metaKey) || "{}");
    } catch {
      /* start fresh */
    }
    meta[key] = value;
    localStorage.setItem(this.metaKey, JSON.stringify(meta));
  }

  async clearOps() {
    localStorage.removeItem(this.key);
  }
}

/* ==========================================================================
   Identity
   ========================================================================== */

const randomId = (bytes = 8) => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
};

function loadIdentity() {
  const key = CONFIG.identity.storageKey;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved?.actorId) return saved;
  } catch {
    /* fall through and mint a new one */
  }
  const identity = { actorId: randomId(6), memberId: null, displayName: "", key: "" };
  try {
    localStorage.setItem(key, JSON.stringify(identity));
  } catch {
    /* ephemeral session — actorId lives only in memory */
  }
  return identity;
}

/**
 * Replica id = device id + per-tab suffix.
 *
 * The device id (localStorage) carries the human things — the claimed seat,
 * the display name. But localStorage is shared between tabs, and an op log
 * actor must never be shared between two writers that can dispatch
 * concurrently: they would allocate colliding sequence numbers and treat each
 * other's messages as echoes of their own. The suffix lives in sessionStorage,
 * which is per-tab and survives reloads, so every open tab is its own honest
 * replica while still acting as the same member.
 */
function replicaSuffix() {
  try {
    let tab = sessionStorage.getItem("cc.tab");
    if (!tab) {
      tab = randomId(3);
      sessionStorage.setItem("cc.tab", tab);
    }
    return tab;
  } catch {
    return randomId(3);
  }
}

function saveIdentity(identity) {
  try {
    localStorage.setItem(CONFIG.identity.storageKey, JSON.stringify(identity));
  } catch {
    /* non-fatal */
  }
}

/* ==========================================================================
   Genesis
   ========================================================================== */

const GENESIS_ACTOR = "genesis";

/**
 * Turn the shipped snapshot into ops with fixed ids and fixed timestamps.
 * Because the derivation is deterministic, two clients that have never met
 * still produce byte-identical genesis ops, so the seed dedupes on contact
 * instead of doubling up.
 */
export function toGenesisOps(seed) {
  const ops = [];
  const emit = (type, payload) => {
    const seq = ops.length;
    ops.push({
      actor: GENESIS_ACTOR,
      seq,
      hlc: `${"0".repeat(15)}:${String(seq).padStart(5, "0")}:${GENESIS_ACTOR}`,
      type,
      payload,
    });
  };

  if (seed.session) emit("session.set", seed.session);
  for (const m of seed.members || []) emit("member.upsert", m);
  for (const c of seed.committees || []) emit("committee.upsert", c);
  for (const b of seed.bills || []) emit("bill.upsert", b);
  for (const c of seed.cosponsors || []) emit("cosponsor.add", c);
  for (const a of seed.amendments || []) emit("amendment.file", a);
  for (const v of seed.votes || []) {
    emit(v.state === "closed" ? "vote.close" : "vote.open", v);
  }
  for (const b of seed.ballots || []) emit("ballot.cast", b);
  for (const n of seed.news || []) emit("news.post", n);
  for (const d of seed.docket || []) emit("docket.add", d);
  for (const s of seed.statuses || []) emit("status.post", s);
  for (const c of seed.comments || []) emit("comment.post", c);
  for (const p of seed.proxies || []) emit("proxy.delegate", p);

  return ops;
}

/* ==========================================================================
   Store
   ========================================================================== */

export class Store extends EventTarget {
  constructor() {
    super();
    this.identity = loadIdentity();
    this.replicaId = `${this.identity.actorId}.${replicaSuffix()}`;
    this.log = new Log();
    this.clock = new Clock(this.replicaId);
    this.seq = -1;
    this.storage = null;
    this.storageHealthy = true;
    this.ready = false;
    /** Set by the sync coordinator; receives locally originated ops. */
    this.onOutbound = null;
    /** Set by the coordinator once crypto is up. Signs outbound, verifies inbound. */
    this.identitySigner = null;
    this.verifier = null;
    this.quarantine = null;
  }

  get state() {
    return this.log.state;
  }

  get vv() {
    return this.log.vv;
  }

  get actorId() {
    return this.replicaId;
  }

  /* --- lifecycle -------------------------------------------------------- */

  async init() {
    this.storage = (await IdbAdapter.open()) || new LocalAdapter();

    // Clock and sequence meta are keyed by replica id — tabs share the
    // database but must never share a writer's counters.
    const [saved, clockState, seq] = await Promise.all([
      this.storage.allOps(),
      this.storage.getMeta(`clock:${this.replicaId}`),
      this.storage.getMeta(`seq:${this.replicaId}`),
    ]);

    if (clockState) this.clock = new Clock(this.replicaId, clockState);
    this.seq = Number.isInteger(seq) ? seq : -1;

    if (saved.length) this.log.insert(saved);

    // Seed only when this replica has never seen the genesis actor. A client
    // that already synced with a peer inherits genesis through the log.
    if (!(GENESIS_ACTOR in this.log.vv)) {
      const seedOps = await this.#loadSeed();
      if (seedOps.length) {
        const accepted = this.log.insert(seedOps);
        await this.#persist(accepted);
      }
    }

    // Keep our sequence ahead of anything already attributed to us, so a
    // restored backup can never collide with fresh local writes.
    const mine = this.log.vv[this.replicaId];
    if (Number.isInteger(mine) && mine > this.seq) this.seq = mine;

    this.ready = true;
    this.#emit("ready");
    this.#emit("change", { reason: "init" });
    return this;
  }

  async #loadSeed() {
    try {
      const res = await fetch(`${CONFIG.dataBase}/seed.json`, { cache: "no-cache" });
      if (!res.ok) return [];
      return toGenesisOps(await res.json());
    } catch {
      // Offline on a cold start with no cache: the page still runs on its
      // static markup, and the seed lands on the next successful load.
      return [];
    }
  }

  /* --- writes ------------------------------------------------------------ */

  /**
   * Append a locally originated op. Synchronous as far as the caller is
   * concerned: state and UI are updated before this returns, and durability
   * plus replication happen behind it.
   */
  dispatch(type, payload = {}) {
    // A frozen member is isolated: the connection stays up so the Chair can
    // still reach them, but this device authors nothing. The exception is the
    // acts of stepping down, so a frozen cousin is never trapped in their seat.
    const me = this.me;
    if (me?.frozen && !type.startsWith("member.presence") && type !== "member.auth") {
      this.#emit("frozen", { by: me.frozenBy || "the Chair" });
      return null;
    }

    this.seq += 1;
    const op = {
      actor: this.replicaId,
      seq: this.seq,
      hlc: this.clock.tick(),
      type,
      payload,
      v: SCHEMA_VERSION,
    };

    const accepted = this.log.insert([op]);
    if (!accepted.length) return null;

    // Paint and persist immediately; the signature is attached behind the UI
    // so a device with no signing key yet (identity still provisioning) never
    // blocks a vote. The op is only released to the network once signed.
    this.#emit("change", { reason: "local", ops: accepted });

    if (this.identitySigner) {
      this.#signAndRelease(op);
    } else {
      this.#persist(accepted);
      this.onOutbound?.(accepted);
    }
    this.#maybeCompact();
    return op;
  }

  async #signAndRelease(op) {
    try {
      const signed = await this.identitySigner.signOp(op);
      op.sig = signed.sig;
      op.kid = signed.kid;
    } catch {
      // Signing failed (no WebCrypto?) — the op still replicates unsigned and
      // is marked as such by verifiers rather than being lost.
    }
    this.#persist([op]);
    this.onOutbound?.([op]);
  }

  /**
   * Accept ops from a transport. Returns the ops that were new here, which is
   * exactly the set worth gossiping onward — a peer mesh with cycles relies on
   * this to terminate.
   */
  /**
   * Accept ops from a transport — the security choke point.
   *
   * Every op is authenticated before it is folded into state. This is the fix
   * for the whole point of signing ops: without verification here, a hostile
   * relay (which carries ops in the clear) could forge or rewrite anything —
   * flip a vote, seize the gavel, impersonate a cousin. So:
   *
   *   - `id.announce` ops are self-authenticating (signed by the key they
   *     carry) and teach the directory who an actor is.
   *   - Genesis ops are NEVER accepted from the network; the shipped seed is
   *     trusted only because we derived it locally. A network "genesis" op is
   *     an impersonation of the seed and is dropped.
   *   - Every other op is verified against the directory. A forgery (bad
   *     signature, wrong key) is dropped loudly. An op from an author we do
   *     not yet have a key for is QUARANTINED — kept and replicated so it is
   *     never lost, but not folded into state until its identity arrives.
   *
   * Verification is skipped only when no verifier is wired (unit tests, and the
   * brief window before the identity provisions), never for network input once
   * security is up.
   */
  async ingest(ops, source = "remote") {
    const raw = Array.isArray(ops) ? ops.filter(isValidOp) : [];
    if (!raw.length) return [];

    // Convert anything not in our schema version (older upgraded, future kept).
    const incoming = raw.map((op) => {
      if (versionOf(op) === SCHEMA_VERSION) return op;
      const result = migrations.convert(op, SCHEMA_VERSION);
      return result.ok ? { ...result.op, sig: op.sig, kid: op.kid } : op;
    });

    const toFold = [];
    for (const op of incoming) {
      if (op.actor === "genesis") continue; // never trust a networked seed

      if (op.type === "id.announce") {
        const ident = await verifyIdentityOp(op);
        if (ident && ident.fingerprint === op.kid) {
          await this.verifier?.learn(op.actor, ident.spki);
          toFold.push(op); // harmless to fold; keeps it replicating
        }
        continue;
      }

      if (!this.verifier) {
        toFold.push(op); // no crypto context (tests) — accept structurally
        continue;
      }

      const verdict = await verifyOp(op, this.verifier);
      if (verdict.ok) toFold.push(op);
      else if (verdict.reason === "unknown-author") this.#quarantine(op);
      else this.#emit("forgery", { op: { actor: op.actor, type: op.type }, reason: verdict.reason, source });
    }

    if (!toFold.length) return [];
    for (const op of toFold) this.clock.observe(op.hlc);

    const accepted = this.log.insert(toFold);
    if (!accepted.length) return [];

    this.#emit("change", { reason: "remote", source, ops: accepted });
    this.#persist(accepted);
    this.#maybeCompact();

    // A freshly learned identity may release ops that were waiting on it.
    // Awaited so callers see a settled state before they read it.
    if (accepted.some((op) => op.type === "id.announce")) await this.#drainQuarantine();

    return accepted;
  }

  /** Hold an op we cannot yet authenticate. It still replicates (so it is not
   *  lost) but does not touch state until its author's key arrives. */
  #quarantine(op) {
    this.quarantine ||= new Map();
    this.quarantine.set(`${op.actor}:${op.seq}`, op);
    // Bound the buffer so a flood of unauthenticated ops cannot exhaust memory.
    if (this.quarantine.size > 5000) {
      const oldest = this.quarantine.keys().next().value;
      this.quarantine.delete(oldest);
    }
  }

  /** Ops the mesh should still receive even though we have not folded them. */
  quarantinedOps() {
    return this.quarantine ? [...this.quarantine.values()] : [];
  }

  async #drainQuarantine() {
    if (!this.quarantine?.size || !this.verifier) return;
    const released = [];
    for (const [key, op] of this.quarantine) {
      const verdict = await verifyOp(op, this.verifier);
      if (verdict.ok) {
        released.push(op);
        this.quarantine.delete(key);
      } else if (verdict.reason !== "unknown-author") {
        this.quarantine.delete(key); // it was a forgery all along
      }
    }
    if (released.length) {
      for (const op of released) this.clock.observe(op.hlc);
      const accepted = this.log.insert(released);
      if (accepted.length) {
        this.#emit("change", { reason: "remote", source: "quarantine", ops: accepted });
        this.#persist(accepted);
      }
    }
  }

  /** Ops a peer advertising `remote` has not seen. */
  delta(remote) {
    return this.log.delta(remote);
  }

  async #persist(ops) {
    if (!ops.length || !this.storage) return;
    try {
      await this.storage.putOps(ops);
      await this.storage.setMeta(`clock:${this.replicaId}`, this.clock.snapshot());
      await this.storage.setMeta(`seq:${this.replicaId}`, this.seq);
      if (!this.storageHealthy) {
        this.storageHealthy = true;
        this.#emit("storage", { healthy: true });
      }
    } catch (err) {
      this.storageHealthy = false;
      this.#emit("storage", { healthy: false, error: String(err) });
    }
  }

  #maybeCompact() {
    if (this.log.sinceSnapshot >= CONFIG.sync.compactAfter) {
      this.log.compact();
      this.storage?.setMeta("snapshotAt", Date.now());
    }
  }

  #emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /* --- identity ---------------------------------------------------------- */

  setIdentity(patch) {
    this.identity = { ...this.identity, ...patch };
    saveIdentity(this.identity);
    this.#emit("identity", this.identity);
    this.#emit("change", { reason: "identity" });
  }

  /** The member record this device is acting as, if a seat has been claimed. */
  get me() {
    return this.identity.memberId ? select.member(this.state, this.identity.memberId) : null;
  }

  /* --- portability ------------------------------------------------------- */

  /** Full log export — the cold-start recovery path when no peer is online. */
  exportLog() {
    return JSON.stringify(
      { ...this.log.export(), exportedAt: new Date().toISOString(), room: CONFIG.room },
      null,
      2
    );
  }

  async importLog(json) {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    const ops = Array.isArray(parsed) ? parsed : parsed.ops;
    if (!Array.isArray(ops)) throw new Error("No ops in file");
    const accepted = await this.ingest(ops, "import");
    return accepted.length;
  }

  /** Wipe this replica only. Peers and the server keep their copies. */
  async reset() {
    await this.storage?.clearOps();
    localStorage.removeItem(CONFIG.identity.storageKey);
    location.reload();
  }

  /* --- convenience ------------------------------------------------------- */

  get select() {
    return new Proxy(select, {
      get: (target, prop) => {
        const fn = target[prop];
        if (typeof fn !== "function") return fn;
        return (...args) => fn(this.state, ...args);
      },
    });
  }
}

export const store = new Store();
export { select, VV };
export default store;
