/**
 * migrate.js — converting operations between schema versions.
 *
 * The chamber's record outlives any particular build of this app, so clients
 * must be able to learn how to read formats that did not exist when they were
 * written. They do that by fetching converters at runtime.
 *
 * The critical design decision: **a converter is data, not code.**
 *
 * The obvious implementation — fetch a JS module and import() it — would let
 * whoever controls (or spoofs) a converter endpoint run arbitrary script in a
 * page that holds the chamber's encryption keys, the member's seat password
 * entry, and their microphone. That is a catastrophic trade for a convenience.
 *
 * So a converter is a JSON manifest of declarative steps from a fixed, closed
 * vocabulary, applied by the interpreter below. There is no eval, no Function
 * constructor, no dynamic import, and no step that can reach outside the op
 * payload it is handed. The worst a malicious manifest can do is garble ops it
 * is applied to — which is why manifests are also pinned by hash when the
 * deployment cares, and why the original op is always kept alongside.
 */

import CONFIG from "./config.js";
import { LIMITS, SCHEMA_VERSION, versionOf } from "./schema.js";

/* --------------------------------------------------------------------------
   The step vocabulary
   -------------------------------------------------------------------------- */

const MAX_STEPS = 200;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_HOPS = 25;

/** A step's `type` may be "*" to apply to every op type. */
const matchesType = (step, op) => step.type === undefined || step.type === "*" || step.type === op.type;

/** Resolve a dotted path within a payload without ever crossing a prototype. */
function getPath(object, path) {
  let node = object;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let node = object;
  for (const key of keys) {
    if (!Object.hasOwn(node, key) || node[key] === null || typeof node[key] !== "object") {
      node[key] = {};
    }
    node = node[key];
  }
  node[last] = value;
}

function deletePath(object, path) {
  const keys = path.split(".");
  const last = keys.pop();
  let node = object;
  for (const key of keys) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return;
    node = node[key];
  }
  if (node && typeof node === "object") delete node[last];
}

/**
 * Every operator is a pure (op, step) -> void over a already-cloned op.
 * Adding one here is the only way to extend what a converter can do, which is
 * exactly the property that makes remote manifests safe to accept.
 */
const OPERATORS = {
  /** Rename an op type wholesale: {from, to} */
  renameType(op, step) {
    if (op.type === step.from) op.type = step.to;
  },

  /** Move a payload field: {type?, from, to} */
  renameField(op, step) {
    if (!matchesType(step, op)) return;
    const value = getPath(op.payload, step.from);
    if (value === undefined) return;
    deletePath(op.payload, step.from);
    setPath(op.payload, step.to, value);
  },

  /** Fill in a field that older writers never set: {type?, field, value} */
  defaultField(op, step) {
    if (!matchesType(step, op)) return;
    if (getPath(op.payload, step.field) === undefined) {
      setPath(op.payload, step.field, structuredClone(step.value));
    }
  },

  /** Force a field's value: {type?, field, value} */
  setField(op, step) {
    if (!matchesType(step, op)) return;
    setPath(op.payload, step.field, structuredClone(step.value));
  },

  /** Remove a field that no longer means anything: {type?, field} */
  dropField(op, step) {
    if (!matchesType(step, op)) return;
    deletePath(op.payload, step.field);
  },

  /** Remap enumerated values: {type?, field, map: {old: new}} */
  mapValue(op, step) {
    if (!matchesType(step, op)) return;
    const current = getPath(op.payload, step.field);
    if (typeof current !== "string" && typeof current !== "number") return;
    const replacement = step.map[String(current)];
    if (replacement !== undefined) setPath(op.payload, step.field, replacement);
  },

  /** Change a field's primitive type: {type?, field, to: "string"|"number"|"boolean"} */
  coerce(op, step) {
    if (!matchesType(step, op)) return;
    const current = getPath(op.payload, step.field);
    if (current === undefined || current === null) return;
    if (step.to === "string") setPath(op.payload, step.field, String(current));
    else if (step.to === "number") {
      const n = Number(current);
      if (Number.isFinite(n)) setPath(op.payload, step.field, n);
    } else if (step.to === "boolean") setPath(op.payload, step.field, Boolean(current));
  },

  /**
   * Mark an op as no longer meaningful: {type?}. The op stays in the log — it
   * is history — but stops contributing to state.
   */
  retire(op, step) {
    if (!matchesType(step, op)) return;
    op.type = "schema.retired";
    op.payload = { retiredType: step.type ?? "*", original: op.payload };
  },
};

export const STEP_KINDS = Object.freeze(Object.keys(OPERATORS));

/* --------------------------------------------------------------------------
   Manifest validation
   -------------------------------------------------------------------------- */

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,5}$/;
const TYPE_RE = /^(\*|[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*)$/;

/**
 * Reject anything that is not exactly a well-formed manifest. This runs on
 * bytes that may have come from a third-party endpoint, so it is strict on
 * purpose and refuses rather than repairs.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return "not an object";
  if (!Number.isInteger(manifest.from) || manifest.from < 1) return "bad `from`";
  if (!Number.isInteger(manifest.to) || manifest.to < 1) return "bad `to`";
  if (manifest.to <= manifest.from) return "converters must move forward";
  if (typeof manifest.id !== "string" || manifest.id.length > 120) return "bad id";
  if (!Array.isArray(manifest.steps)) return "steps must be an array";
  if (manifest.steps.length > MAX_STEPS) return "too many steps";

  for (const [i, step] of manifest.steps.entries()) {
    if (!step || typeof step !== "object") return `step ${i}: not an object`;
    if (!Object.hasOwn(OPERATORS, step.op)) return `step ${i}: unknown operator "${step.op}"`;
    if (step.type !== undefined && (typeof step.type !== "string" || !TYPE_RE.test(step.type))) {
      return `step ${i}: bad type filter`;
    }
    for (const key of ["field", "from", "to"]) {
      const value = step[key];
      if (value === undefined) continue;
      // `from`/`to` on renameType are op types, not payload paths.
      const isTypeName = step.op === "renameType";
      const pattern = isTypeName ? TYPE_RE : PATH_RE;
      if (typeof value !== "string" || !pattern.test(value)) return `step ${i}: bad ${key}`;
    }
    if (step.op === "mapValue") {
      if (!step.map || typeof step.map !== "object" || Array.isArray(step.map)) {
        return `step ${i}: mapValue needs a map`;
      }
      if (Object.keys(step.map).length > 200) return `step ${i}: map too large`;
    }
    if (step.op === "coerce" && !["string", "number", "boolean"].includes(step.to)) {
      return `step ${i}: coerce needs a primitive target`;
    }
    // Guard against prototype pollution through a crafted path.
    for (const value of [step.field, step.from, step.to]) {
      if (typeof value !== "string") continue;
      if (/(^|\.)(__proto__|constructor|prototype)(\.|$)/.test(value)) {
        return `step ${i}: forbidden path segment`;
      }
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
   Registry
   -------------------------------------------------------------------------- */

const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class MigrationRegistry extends EventTarget {
  constructor() {
    super();
    /** `${from}->${to}` -> manifest */
    this.converters = new Map();
    this.fetched = new Set();
    this.failures = [];
  }

  get size() {
    return this.converters.size;
  }

  /** Every hop we know about, for the technical panel. */
  list() {
    return [...this.converters.values()].map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      steps: m.steps.length,
      title: m.title || "",
      source: m.__source || "built-in",
    }));
  }

  register(manifest, source = "built-in") {
    const problem = validateManifest(manifest);
    if (problem) {
      this.failures.push({ source, problem });
      return false;
    }
    const key = `${manifest.from}->${manifest.to}`;
    if (this.converters.has(key)) return false;
    this.converters.set(key, { ...manifest, __source: source });
    this.dispatchEvent(new CustomEvent("registered", { detail: { key, source } }));
    return true;
  }

  /**
   * Fetch converters from the configured endpoints. Endpoints are advisory:
   * failure is normal (offline, no endpoint deployed) and never fatal.
   * When `integrity` pins are configured, a manifest whose hash does not match
   * is refused outright rather than merely warned about.
   */
  async load(targetVersion = SCHEMA_VERSION) {
    const endpoints = Array.isArray(CONFIG.migrationEndpoints) ? CONFIG.migrationEndpoints : [];
    if (!endpoints.length) return this.size;

    await Promise.all(
      endpoints.map(async (endpoint) => {
        const url = typeof endpoint === "string" ? endpoint : endpoint.url;
        if (!url || this.fetched.has(url)) return;
        this.fetched.add(url);

        try {
          const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}to=${targetVersion}`, {
            cache: "no-cache",
            redirect: "error",
            credentials: "omit",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("manifest too large");

          const pin = typeof endpoint === "object" ? endpoint.sha256 : null;
          if (pin) {
            const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
            if (digest !== pin.toLowerCase()) {
              throw new Error(`integrity mismatch (got ${digest.slice(0, 16)}…)`);
            }
          }

          const body = JSON.parse(new TextDecoder().decode(bytes));
          const manifests = Array.isArray(body) ? body : body.converters || [body];
          for (const manifest of manifests.slice(0, 50)) this.register(manifest, url);
        } catch (error) {
          this.failures.push({ source: url, problem: String(error.message || error) });
        }
      })
    );

    this.dispatchEvent(new CustomEvent("loaded", { detail: { size: this.size } }));
    return this.size;
  }

  /** Shortest chain of hops from `from` to `to`, or null if we cannot get there. */
  path(from, to) {
    if (from === to) return [];
    const queue = [[from, []]];
    const seen = new Set([from]);
    while (queue.length) {
      const [at, chain] = queue.shift();
      if (chain.length >= MAX_HOPS) continue;
      for (const manifest of this.converters.values()) {
        if (manifest.from !== at || seen.has(manifest.to)) continue;
        const next = [...chain, manifest];
        if (manifest.to === to) return next;
        seen.add(manifest.to);
        queue.push([manifest.to, next]);
      }
    }
    return null;
  }

  /**
   * Convert an op to the target version.
   * @returns {{ok: true, op: object, hops: string[]}|{ok: false, reason: string}}
   */
  convert(op, to = SCHEMA_VERSION) {
    const from = versionOf(op);
    if (from === to) return { ok: true, op, hops: [] };

    const chain = this.path(from, to);
    if (!chain) return { ok: false, reason: `no converter from v${from} to v${to}` };

    // Clone once; every operator mutates this copy, never the stored original.
    let working;
    try {
      working = structuredClone(op);
    } catch {
      return { ok: false, reason: "op not cloneable" };
    }

    for (const manifest of chain) {
      for (const step of manifest.steps) {
        try {
          OPERATORS[step.op](working, step);
        } catch (error) {
          return { ok: false, reason: `${manifest.id}/${step.op}: ${error.message}` };
        }
      }
      working.v = manifest.to;
    }

    // A converter that produced something oversized is a broken converter.
    try {
      if (JSON.stringify(working).length > LIMITS.opBytes) {
        return { ok: false, reason: "converted op exceeds size limit" };
      }
    } catch {
      return { ok: false, reason: "converted op not serialisable" };
    }

    return { ok: true, op: working, hops: chain.map((m) => m.id) };
  }
}

/* --------------------------------------------------------------------------
   Built-in converters
   -------------------------------------------------------------------------- */

/**
 * v1 -> v2: the release that added signed operations and emoji badges.
 * v1 ops are unsigned, so they stay unsigned — they are grandfathered rather
 * than forged a signature for, and the UI marks them as legacy.
 */
export const BUILTIN_CONVERTERS = [
  {
    id: "cc.v1-to-v2",
    from: 1,
    to: 2,
    title: "Adds member badges and moves seat passwords onto the versioned envelope",
    steps: [
      { op: "defaultField", type: "member.upsert", field: "icon", value: "🪑" },
      { op: "renameField", type: "member.upsert", from: "avatar", to: "icon" },
      { op: "mapValue", type: "ballot.cast", field: "choice", map: { yes: "yea", no: "nay", abstain: "present" } },
    ],
  },
];

export const migrations = new MigrationRegistry();
for (const manifest of BUILTIN_CONVERTERS) migrations.register(manifest);

export default migrations;
