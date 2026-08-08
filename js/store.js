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
    this.seq += 1;
    const op = {
      actor: this.replicaId,
      seq: this.seq,
      hlc: this.clock.tick(),
      type,
      payload,
    };

    const accepted = this.log.insert([op]);
    if (!accepted.length) return null;

    this.#emit("change", { reason: "local", ops: accepted });
    this.#persist(accepted);
    this.onOutbound?.(accepted);
    this.#maybeCompact();
    return op;
  }

  /**
   * Accept ops from a transport. Returns the ops that were new here, which is
   * exactly the set worth gossiping onward — a peer mesh with cycles relies on
   * this to terminate.
   */
  ingest(ops, source = "remote") {
    const incoming = Array.isArray(ops) ? ops.filter(isValidOp) : [];
    if (!incoming.length) return [];

    for (const op of incoming) this.clock.observe(op.hlc);

    const accepted = this.log.insert(incoming);
    if (!accepted.length) return [];

    this.#emit("change", { reason: "remote", source, ops: accepted });
    this.#persist(accepted);
    this.#maybeCompact();
    return accepted;
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
    const accepted = this.ingest(ops, "import");
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
