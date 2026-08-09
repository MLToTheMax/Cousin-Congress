/**
 * watchdog.js — a tiny on-device classifier that flags suspicious logins.
 *
 * This is a real, if small, machine-learning model: logistic regression over a
 * handful of hand-engineered connection features. It runs entirely locally —
 * no service, no upload, a few multiplications per login — and its whole job is
 * to turn "a device just authenticated" into "…and here is how unusual that
 * looks, and why", so the Chair sees a plain-language flag instead of a raw
 * connection log.
 *
 * The weights below are set from reasoning about the family threat model rather
 * than trained on a dataset we do not have, and the model keeps a short memory
 * of what "normal" looks like for this chamber (known fingerprints, usual
 * networks, usual hours) so its judgements adapt to how a particular family
 * actually uses it. The `update()` hook lets the Chair correct it — marking a
 * flag as fine nudges the threshold — which is the part that makes it learn.
 *
 * It is an assistant, not a gate. It never blocks anyone; it only raises a hand.
 */

const SIGMOID = (z) => 1 / (1 + Math.exp(-z));

/**
 * Feature weights. Positive pushes toward "suspicious". These are interpretable
 * on purpose: a reviewer can read off exactly why the model is worried.
 */
const WEIGHTS = {
  bias: -2.6,
  unknownFingerprint: 2.4, // a device key we have never seen
  newNetwork: 1.3, // an IP/subnet this chamber has not connected from before
  memberIpChange: 1.9, // a known member appearing from a brand-new network
  offHours: 0.8, // connecting in the small hours
  rapidReconnect: 1.5, // many connect/disconnect cycles in a short window
  guest: -0.4, // guests are expected and scoped, slightly reassuring
  burstOfNewDevices: 1.7, // several never-seen devices in quick succession
};

const THRESHOLD_DEFAULT = 0.6;

export class Watchdog extends EventTarget {
  constructor() {
    super();
    this.knownFingerprints = new Set();
    this.knownSubnets = new Set();
    this.memberNetworks = new Map(); // memberId -> Set(subnet)
    this.recent = []; // recent connection timestamps, for burst detection
    this.reconnects = new Map(); // actor -> [timestamps]
    this.threshold = THRESHOLD_DEFAULT;
    this.flags = [];
  }

  /** Coarse subnet key: /24 for IPv4, /48 for IPv6. Enough to say "same place". */
  static subnet(ip) {
    if (!ip) return null;
    if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":");
    return ip.split(".").slice(0, 3).join(".");
  }

  /** Teach the model what is already normal (call for every prior connection). */
  seed({ fingerprints = [], subnets = [] } = {}) {
    for (const fp of fingerprints) this.knownFingerprints.add(fp);
    for (const sn of subnets) this.knownSubnets.add(sn);
  }

  #features(event, now) {
    const subnet = Watchdog.subnet(event.ip);
    const hour = new Date(now).getHours();

    const reconnects = this.reconnects.get(event.actor) || [];
    const recentReconnects = reconnects.filter((t) => now - t < 60_000).length;
    const recentNew = this.recent.filter((r) => now - r.at < 120_000 && r.novel).length;

    const memberNets = event.memberId ? this.memberNetworks.get(event.memberId) : null;

    return {
      unknownFingerprint: event.fingerprint && !this.knownFingerprints.has(event.fingerprint) ? 1 : 0,
      newNetwork: subnet && !this.knownSubnets.has(subnet) ? 1 : 0,
      memberIpChange: event.memberId && memberNets && subnet && memberNets.size > 0 && !memberNets.has(subnet) ? 1 : 0,
      offHours: hour >= 1 && hour <= 5 ? 1 : 0,
      rapidReconnect: recentReconnects >= 3 ? 1 : 0,
      guest: event.guest ? 1 : 0,
      burstOfNewDevices: recentNew >= 2 ? 1 : 0,
    };
  }

  /**
   * Classify one connection. Returns {score, suspicious, reasons, features}.
   * `at` is passed in (never read from the clock) so the same input always
   * yields the same output — important for testing.
   */
  classify(event, at) {
    const now = at ?? event.at ?? 0;
    const features = this.#features(event, now);

    let z = WEIGHTS.bias;
    const reasons = [];
    for (const [key, value] of Object.entries(features)) {
      if (!value) continue;
      z += WEIGHTS[key];
      if (WEIGHTS[key] > 0) reasons.push(REASON_TEXT[key]);
    }

    const score = SIGMOID(z);
    return { score, suspicious: score >= this.threshold, reasons, features };
  }

  /** Observe a connection: classify it, remember it as now-normal, and flag it
   *  if it looks off. Returns the classification. */
  observe(event, at) {
    const now = at ?? event.at ?? 0;
    const result = this.classify(event, now);

    // Record for burst/reconnect detection before learning it as normal.
    const novel = result.features.unknownFingerprint === 1;
    this.recent.push({ at: now, novel });
    if (this.recent.length > 200) this.recent.shift();
    const rc = this.reconnects.get(event.actor) || [];
    rc.push(now);
    this.reconnects.set(event.actor, rc.slice(-10));

    if (result.suspicious) {
      const flag = { ...event, ...result, flaggedAt: now };
      this.flags.unshift(flag);
      this.flags = this.flags.slice(0, 100);
      this.dispatchEvent(new CustomEvent("flag", { detail: flag }));
    }

    // Fold this connection into "normal" so a genuinely repeated device stops
    // being flagged, but only if it was not itself flagged as suspicious.
    if (!result.suspicious) {
      if (event.fingerprint) this.knownFingerprints.add(event.fingerprint);
      const subnet = Watchdog.subnet(event.ip);
      if (subnet) {
        this.knownSubnets.add(subnet);
        if (event.memberId) {
          const set = this.memberNetworks.get(event.memberId) || new Set();
          set.add(subnet);
          this.memberNetworks.set(event.memberId, set);
        }
      }
    }
    return result;
  }

  /**
   * The learning hook: the Chair tells the model a flag was fine (or genuinely
   * bad). "Fine" gently raises the bar and accepts the device as normal; "bad"
   * lowers the bar so the next borderline case is caught.
   */
  update(flag, verdict) {
    if (verdict === "fine") {
      this.threshold = Math.min(0.9, this.threshold + 0.02);
      if (flag.fingerprint) this.knownFingerprints.add(flag.fingerprint);
      const subnet = Watchdog.subnet(flag.ip);
      if (subnet) this.knownSubnets.add(subnet);
    } else if (verdict === "bad") {
      this.threshold = Math.max(0.3, this.threshold - 0.05);
    }
  }
}

const REASON_TEXT = {
  unknownFingerprint: "a device we've never seen before",
  newNetwork: "a network the chamber hasn't used before",
  memberIpChange: "a known member connecting from a new network",
  offHours: "connecting in the middle of the night",
  rapidReconnect: "connecting and dropping over and over",
  burstOfNewDevices: "several new devices at once",
};

export default Watchdog;
