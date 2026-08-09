/**
 * schema.js — the shape of an operation, and how versions of that shape relate.
 *
 * The record is append-only and permanent, which means a device running last
 * year's build will one day receive an op written by next year's. The rule
 * that keeps that survivable: **an op is never discarded for being from the
 * future.** Ops we cannot interpret are kept verbatim in the log, quarantined
 * out of the fold, and replayed the moment a converter for them arrives.
 *
 * That is the opposite of the usual instinct (validate, reject, move on), and
 * it is deliberate. A rejected op is data destroyed on behalf of a peer who
 * had every right to write it.
 */

/** Bumped whenever the envelope or an op payload changes incompatibly. */
export const SCHEMA_VERSION = 2;

/**
 * The oldest version this build can fold directly, without a converter.
 * Anything older goes through the migration chain first.
 */
export const MIN_NATIVE_VERSION = 2;

/* --------------------------------------------------------------------------
   Limits
   --------------------------------------------------------------------------
   Every one of these is a defence against a hostile peer rather than a
   guess at what an honest one needs. They are generous for real use and
   bounded enough that a flood cannot exhaust memory or storage.            */

export const LIMITS = {
  actorLength: 80,
  typeLength: 64,
  hlcLength: 128,
  opBytes: 64 * 1024,
  payloadKeys: 64,
  stringField: 16 * 1024,
  nesting: 6,
  opsPerMessage: 256,
  signatureBytes: 200,
};

/* --------------------------------------------------------------------------
   Envelope validation
   -------------------------------------------------------------------------- */

const HLC_RE = /^\d{1,20}:\d{1,10}:[A-Za-z0-9._-]{1,80}$/;
const ACTOR_RE = /^[A-Za-z0-9._-]{1,80}$/;
const TYPE_RE = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/**
 * Structural check only. This deliberately says nothing about whether the op
 * is *authorised* — that is signature verification's job, in crypto.js — and
 * nothing about whether we understand its version.
 */
export function validateEnvelope(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) return "not an object";

  if (typeof op.actor !== "string" || !ACTOR_RE.test(op.actor)) return "bad actor";
  if (!Number.isInteger(op.seq) || op.seq < 0 || op.seq > Number.MAX_SAFE_INTEGER) return "bad seq";
  if (typeof op.hlc !== "string" || !HLC_RE.test(op.hlc)) return "bad hlc";
  if (typeof op.type !== "string" || !TYPE_RE.test(op.type)) return "bad type";
  if (op.payload === null || typeof op.payload !== "object" || Array.isArray(op.payload)) {
    return "bad payload";
  }

  // The version field is optional so that a v1 op (which had none) still
  // validates structurally and can be routed into the converter.
  if (op.v !== undefined && (!Number.isInteger(op.v) || op.v < 1 || op.v > 1000)) {
    return "bad version";
  }

  // The clock's actor component must match the op's actor, or a peer could
  // borrow someone else's identity for tie-breaking while signing as itself.
  if (op.hlc.split(":")[2] !== op.actor) return "hlc actor mismatch";

  const depth = payloadDepth(op.payload);
  if (depth > LIMITS.nesting) return "payload too deeply nested";
  if (Object.keys(op.payload).length > LIMITS.payloadKeys) return "too many payload keys";

  const oversized = findOversizedString(op.payload);
  if (oversized) return `field too large: ${oversized}`;

  let encoded;
  try {
    encoded = JSON.stringify(op);
  } catch {
    return "payload not serialisable";
  }
  if (encoded.length > LIMITS.opBytes) return "op too large";

  return null;
}

export const isValidEnvelope = (op) => validateEnvelope(op) === null;

function payloadDepth(value, depth = 1) {
  if (value === null || typeof value !== "object") return depth;
  if (depth > LIMITS.nesting) return depth;
  let max = depth;
  for (const child of Object.values(value)) {
    max = Math.max(max, payloadDepth(child, depth + 1));
  }
  return max;
}

function findOversizedString(value, path = "") {
  if (typeof value === "string") {
    return value.length > LIMITS.stringField ? path || "(root)" : null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const found = findOversizedString(child, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

/** Version an op claims. Ops written before versioning are treated as v1. */
export const versionOf = (op) => (Number.isInteger(op?.v) ? op.v : 1);

/** True when this build can fold the op without help. */
export const isNative = (op) => versionOf(op) === SCHEMA_VERSION;

/**
 * An op from the future. We keep it, we replicate it onward so other peers
 * still get it, and we ask for a converter — but we do not fold it, because
 * guessing at a payload shape we have never seen is how records get corrupted.
 */
export const isFromFuture = (op) => versionOf(op) > SCHEMA_VERSION;
