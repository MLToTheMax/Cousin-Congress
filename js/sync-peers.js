/**
 * sync-peers.js — browser-to-browser replication over an encrypted WebRTC mesh.
 *
 * Every data channel is upgraded to an end-to-end session from crypto.js before
 * a single operation is allowed across it. WebRTC already gives us DTLS on the
 * wire, but DTLS trusts whoever the (untrusted) relay introduced us to; the
 * application handshake re-establishes trust from the pairing code instead, and
 * its keys survive being relayed onward — so an op that gossips A→B→C stays
 * authenticated the whole way rather than only for the hop it was sent on.
 *
 * Two ways to pair:
 *   Brokered — with a relay configured, offers/answers ride the WebSocket and
 *   pairing is automatic. The relay sees the handshake but never a key: the
 *   pre-shared room secret it is missing is exactly what the session needs.
 *   Direct — with no server at all, an invite code carries everything out of
 *   band. This is what makes a static GitHub Pages deployment genuinely
 *   multi-user, and it is the only channel the room secret ever travels on.
 *
 * Full mesh: once secured, peers trade their roster of known members, so every
 * device dials every other device. A vote cast on one phone reaches all of them
 * directly and at once, with no peer acting as a relay-of-record for the rest.
 */

import CONFIG from "./config.js";
import { emojiDecode, emojiEncode, looksLikeIconCode } from "./icons.js";
import { Session, b64, unb64, fingerprint } from "./crypto.js";

const CHANNEL = "cc-ops";
const ICE_TIMEOUT_MS = 3500;
// How long to keep gathering once we already have a usable candidate set. A
// pairing code should appear near-instantly: host candidates are ready in
// milliseconds (enough for same-network pairing), and if the STUN servers are
// slow or blocked we must NOT make the human stare at a spinner for the full
// ICE_TIMEOUT_MS waiting for gathering to formally "complete".
const ICE_GRACE_MS = 1200;
// v2 tickets carry a whole SDP; v3 carries only the parts a data-channel SDP
// cannot derive and rebuilds the rest from a template. Both are still decoded,
// because a Seal Card printed last month is still a valid invitation.
const PAIRING_VERSION = 3;
const LEGACY_PAIRING_VERSION = 2;

/** Never hold more live links than this. A family mesh is a dozen devices at
 *  most, so a larger number means something is dialling us in a loop — and an
 *  unbounded peer map is an unbounded pile of RTCPeerConnections. */
const MAX_LINKS = 24;

/* Reconnection. Actor ids of peers we have completed a handshake with, so a
   reload or a fresh tab can re-dial them instead of waiting for a human to
   pair again. Deliberately NOT secret: an actor id is a random device id plus
   a tab suffix, useless without the room secret (which is not stored here and
   never travels over any of these paths). */
const KNOWN_PEERS_KEY = "cc.peers";
const KNOWN_PEERS_MAX = 24;
const KNOWN_PEERS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* Attempt schedule. Capped rather than infinite: a tab that closed for good
   leaves an actor id behind, and dialling a ghost forever would burn battery
   and keep the banner lying about being mid-reconnect. An explicit wake —
   coming back online, the tab becoming visible, the relay reconnecting —
   resets the counters, which is the only thing that should. */
const REDIAL_BACKOFF_MS = [800, 2500, 7000, 18000, 45000];
// Long enough for a handshake that has to cross STUN and a slow network, short
// enough that a dead actor is given up on inside a minute.
const REDIAL_TIMEOUT_MS = 12000;

/* --------------------------------------------------------------------------
   Invite codes
   -------------------------------------------------------------------------- */

const base64ToBytes = (text) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};

const concatBytes = (head, body) => {
  const out = new Uint8Array(1 + body.length);
  out[0] = head;
  out.set(body, 1);
  return out;
};

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Encode a pairing ticket two ways from the SAME compressed bytes:
 *   - `code`    the emoji "picture code", for humans to copy/paste or photograph;
 *   - `compact` a short base64 string, for the QR and Seal Card.
 *
 * The QR must use `compact`, NOT `code`: each byte of the picture code is a
 * multi-byte emoji, so QR-encoding the emoji string inflates the payload ~4x and
 * blows past the QR capacity (a ~780-byte ticket becomes ~3100 bytes). Both
 * forms round-trip through decodePayload — emoji via its icon branch, `compact`
 * via its `z.`/`p.` branch.
 */
async function encodePayload(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === "undefined") {
    return { code: emojiEncode(concatBytes(2, raw)), compact: `p.${b64(raw)}` };
  }
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  return { code: emojiEncode(concatBytes(1, packed)), compact: `z.${b64(packed)}` };
}

async function decodePayload(code) {
  const text = String(code).trim();
  if (looksLikeIconCode(text)) {
    const bytes = emojiDecode(text);
    if (bytes.length < 2) throw new Error("That code is too short — copy the whole picture.");
    const body = bytes.slice(1);
    const json = bytes[0] === 1 ? await gunzip(body) : new TextDecoder().decode(body);
    return JSON.parse(json);
  }
  const compact = text.replace(/\s+/g, "");
  const [tag, body] = compact.startsWith("z.") || compact.startsWith("p.")
    ? [compact.slice(0, 1), compact.slice(2)]
    : ["p", compact];
  const bytes = base64ToBytes(body);
  if (tag === "p") return JSON.parse(new TextDecoder().decode(bytes));
  return JSON.parse(await gunzip(bytes));
}

/**
 * Shrink an SDP before it goes in a pairing code.
 *
 * ICE candidates dominate the payload: a laptop advertises host candidates for
 * every interface plus TCP variants, and each line is ~100 characters. None of
 * that survives usefully in a QR — a denser code is a code a phone camera has to
 * work harder to read, and past a point cannot read at all.
 *
 * So we keep only what actually establishes a connection: UDP host candidates
 * (same-network pairing, the common case) and server-reflexive ones (different
 * networks), capped, with TCP and duplicate-priority lines dropped. Everything
 * removed is an ALTERNATIVE route, never a required field — the ufrag, pwd,
 * fingerprint, setup and sctp lines are untouched — so a slimmed offer still
 * connects wherever the full one would, it just carries fewer spare paths.
 */
const MAX_CANDIDATES = 6;
function slimSdp(sdp) {
  if (typeof sdp !== "string" || !sdp) return sdp;
  const kept = [];
  const out = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (!line) continue;
    if (!line.startsWith("a=candidate:")) {
      out.push(line);
      continue;
    }
    // "a=candidate:foundation component transport priority ip port typ TYPE ..."
    const parts = line.split(" ");
    const transport = (parts[2] || "").toLowerCase();
    const typ = parts[parts.indexOf("typ") + 1];
    if (transport !== "udp") continue;                 // TCP candidates: rarely used, always verbose
    if (typ !== "host" && typ !== "srflx") continue;   // prflx/relay are discovered live
    if (kept.length >= MAX_CANDIDATES) continue;
    kept.push(line);
    out.push(line);
  }
  return out.join("\r\n") + "\r\n";
}

/**
 * A session description as plain data.
 *
 * RTCSessionDescription is a host object: JSON.stringify knows how to flatten it
 * (which is why the WebSocket relay never minded), but structuredClone does NOT
 * — and a BroadcastChannel uses structuredClone. Sending the live object made
 * every offer routed between tabs vanish into a caught exception.
 */
const plainSdp = (desc) => (desc ? { type: desc.type, sdp: desc.sdp } : null);

/** Pull the DTLS fingerprint out of an SDP so the app handshake can bind to it. */
function dtlsFingerprint(sdp) {
  const match = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(sdp || "");
  return match ? match[1].toUpperCase() : null;
}

/* --------------------------------------------------------------------------
   SDP templating

   Slimming the candidate list was only half the payload. What is left of a
   data-channel-only SDP is almost entirely boilerplate — the version line, the
   origin line, the BUNDLE group, the m= and c= lines, the msid semantic — none
   of which varies between two browsers negotiating the same thing. Only a
   handful of fields actually differ: the ICE ufrag and password, the DTLS
   fingerprint, the setup role, the mid, the SCTP port, and the candidates.

   So a v3 ticket sends those fields and rebuilds the rest from a template on
   the far side. That is the difference between a QR a phone reads instantly and
   one it has to be nursed into focus.

   The risk of templating is silently dropping something that mattered, so the
   parser is a strict allowlist: any line it does not model makes it give up and
   the ticket falls back to carrying the whole SDP. Better a bigger code than a
   pairing that fails for reasons nobody can see.
   -------------------------------------------------------------------------- */

const SETUP_ROLES = ["actpass", "active", "passive", "holdconn"];

/**
 * "a=candidate:<foundation> <component> udp <priority> <ip> <port> typ <type>
 *  [raddr <ip> rport <port>] [extras…]" reduced to its connective tissue.
 *
 * The extras Chrome appends — generation, network-id, network-cost, ufrag — are
 * either local scheduling hints or ICE-restart bookkeeping. None of them changes
 * which address gets tried or whether the check succeeds, and `priority` (which
 * we do keep) already carries the ordering.
 */
function parseCandidate(line) {
  const p = line.slice("a=candidate:".length).split(" ");
  if (p.length < 8 || p[6] !== "typ") return null;
  if (p[2].toLowerCase() !== "udp") return null;
  let raddr = null;
  let rport = null;
  for (let i = 8; i + 1 < p.length; i += 2) {
    if (p[i] === "raddr") raddr = p[i + 1];
    else if (p[i] === "rport") rport = Number(p[i + 1]);
  }
  return [p[0], Number(p[1]), Number(p[3]), p[4], Number(p[5]), p[7], raddr, rport];
}

function buildCandidate([foundation, component, priority, ip, port, type, raddr, rport]) {
  const base = `a=candidate:${foundation} ${component} udp ${priority} ${ip} ${port} typ ${type}`;
  return raddr == null ? base : `${base} raddr ${raddr} rport ${rport ?? 0}`;
}

/**
 * Reduce a data-channel SDP to the fields a template cannot infer, or return
 * null if this SDP is not one we can faithfully rebuild.
 */
function templateSdp(sdp) {
  if (typeof sdp !== "string" || !sdp) return null;
  const t = { cands: [] };
  let sections = 0;

  for (const line of sdp.split(/\r?\n/)) {
    if (!line) continue;

    // Fixed boilerplate: identical in every offer and answer, so it is dropped
    // here and re-emitted verbatim by rebuildSdp.
    if (line === "v=0" || line === "s=-" || line === "t=0 0") continue;
    // The origin line names the SESSION, not the connection. Nothing in an
    // offer/answer exchange compares it across peers, so it is regenerated —
    // but only when it is the stock browser form, in case some future UA puts
    // something meaningful there.
    if (line.startsWith("o=")) {
      if (!/^o=- \d+ \d+ IN IP4 127\.0\.0\.1$/.test(line)) return null;
      continue;
    }

    if (line.startsWith("m=")) {
      sections += 1;
      const m = /^m=application (\d+) UDP\/DTLS\/SCTP webrtc-datachannel$/.exec(line);
      if (!m) return null; // audio/video or a legacy sctpmap m-line: not our shape
      t.port = Number(m[1]);
      continue;
    }
    if (line.startsWith("c=")) {
      t.conn = line.slice(2);
      continue;
    }
    if (line.startsWith("a=group:BUNDLE ")) {
      t.bundle = line.slice("a=group:BUNDLE ".length);
      continue;
    }
    if (line === "a=extmap-allow-mixed") {
      t.mixed = 1;
      continue;
    }
    if (line.startsWith("a=msid-semantic:")) {
      t.msid = line.slice("a=msid-semantic:".length);
      continue;
    }
    if (line.startsWith("a=ice-ufrag:")) {
      t.u = line.slice("a=ice-ufrag:".length);
      continue;
    }
    if (line.startsWith("a=ice-pwd:")) {
      t.p = line.slice("a=ice-pwd:".length);
      continue;
    }
    if (line.startsWith("a=ice-options:")) {
      t.opts = line.slice("a=ice-options:".length);
      continue;
    }
    if (line.startsWith("a=fingerprint:")) {
      // Only sha-256 is templated, because the ticket already carries exactly
      // that digest as a top-level field and lends it back at rebuild time.
      if (!/^a=fingerprint:sha-256 [0-9A-Fa-f:]+$/.test(line)) return null;
      t.fp = line.slice("a=fingerprint:sha-256 ".length);
      continue;
    }
    if (line.startsWith("a=setup:")) {
      t.s = SETUP_ROLES.indexOf(line.slice("a=setup:".length));
      if (t.s < 0) return null;
      continue;
    }
    if (line.startsWith("a=mid:")) {
      t.mid = line.slice("a=mid:".length);
      continue;
    }
    if (line.startsWith("a=sctp-port:")) {
      t.sctp = Number(line.slice("a=sctp-port:".length));
      continue;
    }
    if (line.startsWith("a=max-message-size:")) {
      t.mms = Number(line.slice("a=max-message-size:".length));
      continue;
    }
    if (line.startsWith("a=candidate:")) {
      const c = parseCandidate(line);
      if (!c) return null;
      t.cands.push(c);
      continue;
    }
    if (line === "a=end-of-candidates") continue;

    return null; // an attribute we do not model — carry the SDP whole instead
  }

  if (sections !== 1 || !t.u || !t.p || !t.fp || t.mid == null || t.s == null || !t.sctp) return null;
  return t;
}

/** Rebuild a full SDP from a template. `lentFingerprint` is the ticket's own
 *  `dtls` field, which lets the template omit its (identical) copy. */
function rebuildSdp(t, lentFingerprint = null) {
  if (!t || typeof t !== "object") return null;
  const fp = t.fp || lentFingerprint;
  if (!fp || !t.u || !t.p || t.mid == null) return null;

  const lines = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0"];
  if (t.bundle != null) lines.push(`a=group:BUNDLE ${t.bundle}`);
  if (t.mixed) lines.push("a=extmap-allow-mixed");
  if (t.msid != null) lines.push(`a=msid-semantic:${t.msid}`);
  lines.push(`m=application ${t.port ?? 9} UDP/DTLS/SCTP webrtc-datachannel`);
  lines.push(`c=${t.conn || "IN IP4 0.0.0.0"}`);
  for (const c of t.cands || []) lines.push(buildCandidate(c));
  lines.push(`a=ice-ufrag:${t.u}`, `a=ice-pwd:${t.p}`);
  if (t.opts != null) lines.push(`a=ice-options:${t.opts}`);
  lines.push(`a=fingerprint:sha-256 ${fp}`);
  lines.push(`a=setup:${SETUP_ROLES[t.s] ?? "actpass"}`, `a=mid:${t.mid}`);
  lines.push(`a=sctp-port:${t.sctp ?? 5000}`);
  if (t.mms != null) lines.push(`a=max-message-size:${t.mms}`);
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Everything in an SDP that decides whether a connection happens, normalised
 * and sorted. Two SDPs with the same essence negotiate the same session, so
 * this is what the encoder compares a rebuild against before trusting it —
 * a template that would lose a candidate or mangle the ufrag is caught on the
 * sending device, where it can still fall back, rather than at the far end.
 */
function sdpEssence(sdp) {
  const keep = [];
  for (const line of String(sdp).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("m=") || line.startsWith("c=")) keep.push(line);
    else if (/^a=(ice-ufrag|ice-pwd|setup|mid|sctp-port|max-message-size):/.test(line)) keep.push(line);
    else if (line.startsWith("a=fingerprint:")) keep.push(line.toUpperCase());
    else if (line.startsWith("a=candidate:")) {
      const c = parseCandidate(line);
      keep.push(c ? `cand:${c.join(" ")}` : line);
    }
  }
  return keep.sort().join("\n");
}

/**
 * The DTLS fingerprint a ticket asserts, always as uppercase colon-hex — the
 * one form the session handshake compares against.
 *
 * v2 wrote it as colon-hex (`dtls`), which is a display format: 97 characters
 * to carry 32 bytes. v3 writes the bytes (`fp`), which is 43. Everything past
 * this function still sees colon-hex, so the binding check is untouched.
 */
function ticketFingerprint(t) {
  if (typeof t?.fp === "string" && t.fp) {
    try {
      const bytes = unb64(t.fp);
      if (bytes.length !== 32) return null;
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
    } catch {
      return null;
    }
  }
  return typeof t?.dtls === "string" && t.dtls ? t.dtls.toUpperCase() : null;
}

/**
 * The SDP a received ticket describes: v2 carries it whole, v3 rebuilds it.
 * A ticket with neither is from a build this one does not understand, and
 * saying so plainly beats a WebRTC error the user cannot act on.
 */
export function ticketSdp(t) {
  if (typeof t?.sdp === "string" && t.sdp) return t.sdp;
  const rebuilt = rebuildSdp(t?.sd, ticketFingerprint(t));
  if (!rebuilt) throw new Error("That code came from a newer version — update this device and try again.");
  return rebuilt;
}

/** Exported for tests: the round-trip that the encoder itself gates on. */
export const _sdpTemplating = { templateSdp, rebuildSdp, sdpEssence, slimSdp };

/* ========================================================================== */

export class PeerTransport extends EventTarget {
  /**
   * @param {string} actor
   * @param {(to: string, data: object) => void} signal  brokered signalling sink
   * @param {{identity, directory, roomSecret: Uint8Array}} security
   */
  constructor(actor, signal, security = {}) {
    super();
    this.name = "peers";
    this.actor = actor;
    this.signal = signal;
    this.security = security;
    this.supported = typeof RTCPeerConnection !== "undefined";
    /** actorId -> link */
    this.peers = new Map();
    this.pending = new Map();
    this.stopped = true;
    /** Fingerprints learned from a pairing code, trusted above anything a peer asserts. */
    this.pins = new Map();
    /** Set when THIS device joined as a scoped guest of one item. */
    this.#guestScope = null;
    /** An append-only audit trail of connection events, for the Chair to
     *  inspect — who authenticated, when, member or guest. Spotting an
     *  unfamiliar fingerprint here is how you notice an uninvited device. */
    this.connectionLog = [];
    /** actorId -> last handshake (ms). Durable, so a reload has somebody to call. */
    this.known = this.#loadKnown();
    /** actorId -> { tries, timer }. One entry per peer we are trying to reach;
     *  its presence is exactly what "reconnecting" means. */
    this.dials = new Map();
  }

  #guestScope;

  #log(event, actor, extra = {}) {
    this.connectionLog.push({ event, actor, at: Date.now(), ...extra });
    if (this.connectionLog.length > 500) this.connectionLog.shift();
    this.dispatchEvent(new CustomEvent("log", { detail: { event, actor } }));
  }

  /** Drop a peer connection immediately. */
  disconnectPeer(actor) {
    this.#log("kicked", actor);
    this.#drop(actor, "disconnected by chair");
  }

  /** Isolate/release a live connection: it stays open, but no app data flows
   *  while isolated. Returns the new isolation state. */
  togglePeerIsolation(actor) {
    const link = this.peers.get(actor);
    if (!link) return false;
    link.isolated = !link.isolated;
    this.#log(link.isolated ? "isolated" : "released", actor);
    this.#status();
    return link.isolated;
  }

  get status() {
    const links = [...this.peers.values()];
    const open = links.filter((p) => p.secured).length;
    const redialing = this.dials.size;
    return {
      name: this.name,
      // "reconnecting" is a third state on purpose: a device that has peers to
      // call and is calling them is not in the same position as one that has
      // never paired, and the banner must not describe them the same way.
      state: !this.supported ? "unsupported" : open ? "connected" : redialing ? "reconnecting" : "idle",
      peers: open,
      connecting: links.length - open,
      reconnecting: redialing,
      known: this.known.size,
      label: open
        ? `${open} peer${open === 1 ? "" : "s"}`
        : redialing
          ? "reconnecting…"
          : "no peers",
    };
  }

  /** True while at least one known peer is still being re-dialled. */
  get reconnecting() {
    return this.dials.size > 0;
  }

  /** Peers we have completed a handshake with before, newest first. */
  get knownPeers() {
    return [...this.known.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  /**
   * Can we hand a message straight to this actor right now? Used by the
   * coordinator to route a signalling frame the last hop.
   *
   * SECURED, not merely present: connectTo registers its link in the peer map
   * before it has an offer to send, so a "do we know them?" test would route
   * that offer down the very channel it is trying to open — where it waits in
   * an outbox forever and the dial silently never completes.
   */
  hasPeer(actor) {
    return Boolean(this.peers.get(actor)?.secured);
  }

  get peerList() {
    return [...this.peers.entries()].map(([id, p]) => ({
      id,
      state: p.secured ? "secure" : p.state,
      direction: p.direction,
      since: p.since,
      safety: p.safety || null,
      fingerprint: p.session?.peerFingerprint || null,
    }));
  }

  start() {
    this.stopped = false;
    // A reload tore down every data channel but changed nothing else: we still
    // hold the room secret, the peers still hold theirs, and their actor ids
    // are on disk. So the live channel is ours to rebuild, without asking
    // anyone to pair again.
    this.redial({ reset: true });
  }

  stop() {
    this.stopped = true;
    for (const dial of this.dials.values()) clearTimeout(dial.timer);
    this.dials.clear();
    for (const [, link] of this.peers) this.#close(link);
    this.peers.clear();
    this.#status();
  }

  /* --- the known-peer roster ---------------------------------------------- */

  #loadKnown() {
    try {
      const saved = JSON.parse(localStorage.getItem(KNOWN_PEERS_KEY) || "null");
      if (!saved || saved.room !== CONFIG.room) return new Map();
      const cutoff = Date.now() - KNOWN_PEERS_TTL_MS;
      return new Map(
        Object.entries(saved.peers || {}).filter(
          ([id, at]) => typeof at === "number" && at > cutoff && id !== this.actor
        )
      );
    } catch {
      // No storage, or somebody hand-edited it. An empty roster costs a pairing,
      // not correctness.
      return new Map();
    }
  }

  #saveKnown() {
    try {
      const trimmed = [...this.known].sort((a, b) => b[1] - a[1]).slice(0, KNOWN_PEERS_MAX);
      this.known = new Map(trimmed);
      localStorage.setItem(
        KNOWN_PEERS_KEY,
        JSON.stringify({ room: CONFIG.room, peers: Object.fromEntries(trimmed) })
      );
    } catch {
      /* private window: the roster lives for this session only */
    }
  }

  /**
   * Record a peer we have actually completed a room-authenticated handshake
   * with. Only those: an actor id gossiped by somebody else is a rumour, and a
   * roster of rumours is a roster this device would dial forever.
   */
  #remember(actor) {
    if (!actor || actor === this.actor) return;
    // A scoped guest is a stranger passing through one room; it must not build
    // up — or persist — a picture of the chamber's devices.
    if (this.#guestScope) return;
    // Skip our own other tabs. A replica id is "<device>.<tab>", so they share
    // our prefix — and they are already reachable over BroadcastChannel. Storing
    // them would let a browser that has opened thirty tabs this month evict the
    // actual cousins from a roster kept deliberately small.
    if (actor.split(".")[0] === this.actor.split(".")[0]) return;
    this.known.set(actor, Date.now());
    this.#saveKnown();
  }

  /* --- reconnection ------------------------------------------------------- */

  /**
   * Call every known peer we are not already connected to.
   *
   * Reaching ONE of them is enough: the roster gossip in #secure() hands us
   * everybody else, so the mesh reassembles itself from a single answered call.
   * That is why this can afford to be gentle — staggered, backed off, capped,
   * and deduped per peer — rather than hammering the whole roster at once. A
   * device with six tabs open must not become six simultaneous dialers.
   *
   * @param {{reset?: boolean}} opts  reset the attempt counters, for a genuine
   *   wake (back online, tab visible, relay reconnected) rather than a tick.
   */
  redial({ reset = false } = {}) {
    if (this.stopped || !this.supported) return 0;
    // A scoped guest belongs to one sharer for the life of one link. Re-dialling
    // the chamber's devices is not its business.
    if (this.#guestScope) return 0;
    if (reset) {
      for (const dial of this.dials.values()) dial.tries = 0;
      // A wake means everything we merely THOUGHT we had is suspect. Clear out
      // our own dials that never completed: a half-open link left in the peer
      // map would otherwise look like a connection in progress forever and quietly
      // block this peer from ever being called again.
      for (const [actor, link] of [...this.peers]) {
        if (link.autoDial && !link.secured && Date.now() - link.since > REDIAL_TIMEOUT_MS) {
          this.#drop(actor, "stale dial");
        }
      }
    }

    let started = 0;
    for (const actor of this.known.keys()) {
      if (this.peers.has(actor)) continue; // already linked, or already trying
      const dial = this.dials.get(actor) || { tries: 0, timer: null };
      if (dial.timer) continue; // in flight — one call per peer, never a stampede
      if (dial.tries >= REDIAL_BACKOFF_MS.length) continue; // given up until a wake
      this.dials.set(actor, dial);
      // Jitter: cousins reload after the same nudge ("try it again now"), and a
      // synchronised roster-wide dial is exactly the stampede backoff exists to
      // prevent.
      const wait = REDIAL_BACKOFF_MS[dial.tries] * (0.75 + Math.random() * 0.5);
      dial.timer = setTimeout(() => this.#attemptDial(actor), wait);
      started += 1;
    }
    if (started) this.#status();
    return started;
  }

  async #attemptDial(actor) {
    const dial = this.dials.get(actor);
    if (!dial) return;
    dial.timer = null;
    dial.tries += 1;
    if (this.stopped || this.#guestScope) return this.#endDial(actor);

    const existing = this.peers.get(actor);
    if (existing) {
      // Someone got through, or a human is mid-pairing on this very link: either
      // way it is not ours to retry. Only our own timed-out attempt is cleared.
      if (existing.secured || !existing.autoDial) return this.#endDial(actor);
      this.#drop(actor, "redial timed out");
    }

    if (this.actor < actor) {
      // We sort first, so we place the call — the same deterministic-dialer rule
      // the brokered path uses, so two devices coming back at the same moment
      // never both send an offer and glare.
      await this.connectTo(actor).catch(() => {});
    } else {
      // We sort second and may not offer, so we ask to be rung back. The nudge
      // grants nothing: whatever link it produces still has to prove the room
      // secret before a single op crosses it.
      this.signal?.(actor, { kind: "dial" });
    }

    // Nothing reports a call that nobody answered, so the only evidence is
    // silence — wait, then try again until the cap.
    if (dial.tries >= REDIAL_BACKOFF_MS.length) return this.#endDial(actor);
    dial.timer = setTimeout(() => this.#attemptDial(actor), REDIAL_TIMEOUT_MS);
    this.#status();
    return undefined;
  }

  #endDial(actor) {
    const dial = this.dials.get(actor);
    if (!dial) return;
    clearTimeout(dial.timer);
    this.dials.delete(actor);
    this.#status();
  }

  #status() {
    this.dispatchEvent(new CustomEvent("status"));
  }

  #close(link) {
    try {
      link.pc.close();
    } catch {
      /* already closed */
    }
  }

  /* --- connection lifecycle ---------------------------------------------- */

  #newConnection(remoteActor, direction) {
    // ICE servers come from the (Chair-controlled) provider when present, so
    // STUN can be switched off for a strict local-only, no-outside-contact mode.
    const iceServers = this.security.iceServers?.() ?? CONFIG.sync.iceServers;
    const pc = new RTCPeerConnection({ iceServers });
    const link = {
      pc,
      channel: null,
      state: "connecting",
      direction,
      since: Date.now(),
      session: null,
      secured: false,
      outbox: [], // app messages waiting for the session to come up
      safety: null,
    };

    pc.oniceconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.iceConnectionState)) {
        this.#drop(remoteActor, pc.iceConnectionState);
      }
    };

    if (remoteActor) this.peers.set(remoteActor, link);
    this.#status();
    return link;
  }

  #attach(remoteActor, link, channel, localSdp, remoteSdp) {
    link.channel = channel;
    link.localFp = dtlsFingerprint(localSdp);
    link.remoteFp = dtlsFingerprint(remoteSdp);
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      link.state = "open";
      this.#status();
      // Only the lexicographically smaller actor opens the handshake, so the
      // two sides never both send a first hello and collide.
      if (this.actor < remoteActor) this.#beginHandshake(remoteActor, link);
    };
    channel.onclose = () => this.#drop(remoteActor, "channel closed");
    channel.onmessage = (event) => this.#onFrame(remoteActor, link, event.data);
  }

  #drop(remoteActor, reason) {
    const link = this.peers.get(remoteActor);
    if (!link) return;
    this.#close(link);
    this.peers.delete(remoteActor);
    this.#status();
    this.dispatchEvent(new CustomEvent("peerclose", { detail: { peer: remoteActor, reason } }));
  }

  /* --- the encrypted session handshake ----------------------------------- */

  async #beginHandshake(remoteActor, link) {
    if (!this.security.identity || !this.security.roomSecret) {
      // No crypto configured (should not happen in the shipped app) — refuse
      // to fall back to plaintext rather than quietly downgrade.
      this.#drop(remoteActor, "no security context");
      return;
    }
    link.session = new Session(this.security.identity, remoteActor, this.security.roomSecret, {
      pinnedFingerprint: this.pins.get(remoteActor) || null,
      dtlsFingerprint: link.remoteFp,
    });
    const hello = await link.session.createHello();
    this.#raw(link, { hs: "hello", hello });
  }

  async #onFrame(remoteActor, link, data) {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;

    // Handshake frames travel in the clear (they carry no secret); everything
    // else must arrive sealed once the session is up.
    if (frame.hs) return this.#onHandshake(remoteActor, link, frame);

    if (link.isolated) return; // Chair has frozen data flow on this link
    if (!link.secured || !link.session) return; // drop app traffic before the session
    link.bytesIn = (link.bytesIn || 0) + (typeof data === "string" ? data.length : 0);
    const message = await link.session.open(frame);
    if (!message) return; // failed auth — silently dropped
    this.dispatchEvent(new CustomEvent("message", { detail: { msg: message, peer: remoteActor } }));
  }

  async #onHandshake(remoteActor, link, frame) {
    try {
      if (frame.hs === "hello") {
        if (!link.session) {
          // The responder builds its session lazily on first hello.
          link.session = new Session(this.security.identity, remoteActor, this.security.roomSecret, {
            pinnedFingerprint: this.pins.get(remoteActor) || null,
            dtlsFingerprint: link.remoteFp,
          });
          const ownHello = await link.session.createHello();
          this.#raw(link, { hs: "hello", hello: ownHello });
        }
        await link.session.acceptHello(frame.hello);
        // NB: we do NOT learn the peer's key here. acceptHello succeeds before
        // the PSK is proven (the PSK only gates key confirmation), so learning
        // now would let a peer that never held the room secret — a relay — teach
        // us a throwaway key. The durable directory entry is written in #secure()
        // instead, once checkConfirmation has proven room membership.
        this.#raw(link, { hs: "confirm", mac: await link.session.confirmation() });
      } else if (frame.hs === "confirm") {
        const good = await link.session.checkConfirmation(frame.mac);
        if (!good) {
          this.#drop(remoteActor, "key confirmation failed");
          return;
        }
        await this.#secure(remoteActor, link);
      }
    } catch (error) {
      // A handshake that throws is an attack or a version mismatch; either way
      // the safe move is to tear the connection down, not to limp on.
      this.#drop(remoteActor, `handshake: ${error.message}`);
    }
  }

  async #secure(remoteActor, link) {
    if (link.secured) return;
    link.secured = true;
    // Now — and only now — the peer has proven the PSK, so it is safe to write
    // the durable directory entry the op-gossip path verifies against. Pinned if
    // the peer's key came from a pairing code (its fingerprint is in this.pins).
    if (link.session?.peerSpki) {
      this.security.directory?.learn(remoteActor, link.session.peerSpki, {
        pinned: this.pins.has(remoteActor),
      });
    }
    link.safety = await link.session.safetyWord(SAFETY_ALPHABET);

    // A device the Chair has barred never gets past the handshake, wherever it
    // reconnects from — the ban lives in the replicated record, not on one
    // device, so every peer enforces it.
    const barred = this.security.isDeviceRevoked?.(link.session.peerFingerprint);
    if (barred) {
      this.#log("refused", remoteActor, { fingerprint: link.session.peerFingerprint });
      this.#drop(remoteActor, "device revoked by the Chair");
      return;
    }

    // Tell the coordinator who just joined, so it can be written into the
    // chamber's device roster and the Chair can be notified.
    this.dispatchEvent(
      new CustomEvent("peersecured", {
        detail: {
          peer: remoteActor,
          fingerprint: link.session.peerFingerprint,
          address: link.address || null,
          safety: link.safety,
          label: link.label || "",
        },
      })
    );
    this.#log("connected", remoteActor, {
      guest: Boolean(link.guestScope),
      safety: link.safety,
      fingerprint: link.session?.peerFingerprint || null,
    });
    this.#captureAddress(remoteActor, link);
    // This peer has now proven the room secret, so it is worth calling back
    // after a reload — and whatever redial brought us here is finished.
    if (!link.guestScope) this.#remember(remoteActor);
    this.#endDial(remoteActor);
    this.#status();
    this.dispatchEvent(new CustomEvent("peeropen", { detail: { peer: remoteActor, safety: link.safety } }));

    // Flush anything queued while the session was coming up.
    const queued = link.outbox.splice(0);
    for (const msg of queued) this.#sealTo(link, msg);

    // Full mesh: tell this peer who else we know, and dial anyone new they know.
    this.#sealTo(link, { t: "roster", peers: [...this.peers.keys()].filter((a) => a !== remoteActor) });
  }

  #raw(link, frame) {
    try {
      if (link.channel?.readyState === "open") link.channel.send(JSON.stringify(frame));
    } catch {
      /* channel closing */
    }
  }

  async #sealTo(link, msg) {
    if (link.isolated) return false; // Chair has frozen data flow on this link
    if (!link.secured) {
      link.outbox.push(msg);
      return false;
    }
    try {
      const envelope = await link.session.seal(msg);
      if (link.channel?.readyState === "open") {
        const wire = JSON.stringify(envelope);
        link.channel.send(wire);
        link.bytesOut = (link.bytesOut || 0) + wire.length; // for the traffic map
        return true;
      }
    } catch {
      /* drop; a reconnect will re-sync */
    }
    return false;
  }

  /** Per-peer byte counters + geo, for the Chair's traffic-flow map. */
  get traffic() {
    return [...this.peers.entries()].map(([id, link]) => ({
      id,
      guest: Boolean(link.guestScope),
      ip: link.remoteIp || null,
      bytesIn: link.bytesIn || 0,
      bytesOut: link.bytesOut || 0,
      state: link.secured ? "secure" : link.state,
      isolated: Boolean(link.isolated),
    }));
  }

  /**
   * Cut a guest off. Sends a revocation notice over the still-open channel so
   * the guest's screen clears immediately, then tears the connection down.
   * Called by the sharer or, chamber-wide, by the Chair.
   */
  revokeGuest(shareId) {
    for (const [actor, link] of this.peers) {
      if (link.guestScope?.shareId !== shareId) continue;
      this.#sealTo(link, { t: "revoked", shareId });
      // Give the notice a beat to flush, then drop the link entirely.
      setTimeout(() => this.#drop(actor, "share revoked"), 250);
    }
  }

  /** Cut off whichever live link belongs to this device fingerprint. */
  dropByFingerprint(kid) {
    if (!kid) return false;
    for (const [actor, link] of this.peers) {
      if (link.session?.peerFingerprint === kid) {
        this.#drop(actor, "device revoked by the Chair");
        return true;
      }
    }
    return false;
  }

  /** Relay a message to every peer EXCEPT one — the heart of chain gossip. */
  relay(msg, exceptActor) {
    for (const [actor, link] of this.peers) {
      if (actor === exceptActor) continue;
      // Never relay full-chamber traffic to a scoped guest.
      if (link.guestScope) continue;
      this.#sealTo(link, msg);
    }
  }

  /**
   * Recover the peer's network address from the winning ICE candidate pair.
   * Host candidates are often mDNS-obfuscated (`.local`) for privacy, but a
   * server-reflexive candidate reveals the public IP — enough for the Chair to
   * spot an unfamiliar network and to apply address rules.
   */
  async #captureAddress(actor, link) {
    try {
      const stats = await link.pc.getStats();
      let pairId = null;
      let remoteId = null;
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && (r.selected || r.state === "succeeded" || r.nominated)) {
          pairId = r.id;
          remoteId = r.remoteCandidateId;
        }
      });
      if (remoteId) {
        const remote = stats.get?.(remoteId) || [...stats.values()].find((s) => s.id === remoteId);
        const ip = remote?.address || remote?.ip || null;
        if (ip) {
          link.remoteIp = ip;
          const entry = [...this.connectionLog].reverse().find((l) => l.actor === actor && l.event === "connected");
          if (entry) entry.ip = ip;
          this.dispatchEvent(new CustomEvent("address", { detail: { actor, ip } }));
          // Let the coordinator apply address rules; a blocked peer is dropped.
          if (this.security.onAddress && this.security.onAddress(actor, ip) === false) {
            this.#log("blocked-ip", actor, { ip });
            this.#drop(actor, "address blocked");
          }
        }
      }
    } catch {
      // getStats is browser-only and best-effort; absence just means no IP shown.
    }
  }

  /** Roster gossip: dial every member a peer knows that we do not. */
  handleRoster(peers) {
    if (!Array.isArray(peers)) return;
    for (const other of peers.slice(0, 64)) {
      if (typeof other === "string" && other !== this.actor && !this.peers.has(other)) {
        this.connectTo(other).catch(() => {});
      }
    }
  }

  /* --- brokered pairing --------------------------------------------------- */

  async connectTo(remoteActor) {
    if (!this.supported || this.stopped || this.peers.has(remoteActor)) return;
    if (this.actor >= remoteActor) return; // deterministic dialer
    if (this.peers.size >= MAX_LINKS) return; // see MAX_LINKS

    const link = this.#newConnection(remoteActor, "out");
    // Marks this link as OURS to abandon: the redial loop may tear down a dial
    // that never completed, but must never touch a link a human is mid-pairing.
    link.autoDial = true;
    const channel = link.pc.createDataChannel(CHANNEL, { ordered: true });

    link.pc.onicecandidate = (event) => {
      if (event.candidate) this.signal?.(remoteActor, { kind: "ice", candidate: event.candidate.toJSON() });
    };

    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    link.pendingLocalSdp = link.pc.localDescription.sdp;
    this.signal?.(remoteActor, { kind: "offer", sdp: plainSdp(link.pc.localDescription) });
    this.#attachWhenReady(remoteActor, link, channel);
  }

  #attachWhenReady(remoteActor, link, channel) {
    // The remote SDP lands via onSignal; wire the channel once we have both.
    link.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      link.state = "open";
      link.localFp = dtlsFingerprint(link.pc.localDescription?.sdp);
      link.remoteFp = dtlsFingerprint(link.pc.currentRemoteDescription?.sdp);
      this.#status();
      if (this.actor < remoteActor) this.#beginHandshake(remoteActor, link);
    };
    channel.onclose = () => this.#drop(remoteActor, "channel closed");
    channel.onmessage = (event) => this.#onFrame(remoteActor, link, event.data);
  }

  async onSignal(from, data) {
    if (!this.supported || this.stopped || !data) return;

    if (data.kind === "dial") {
      // A peer that sorts after us cannot place the call itself, so it asked to
      // be rung back. Honouring it is safe — the link still has to pass the room
      // handshake — and MAX_LINKS inside connectTo bounds what a flood of these
      // can cost us.
      this.connectTo(from).catch(() => {});
      return;
    }

    if (data.kind === "offer") {
      let link = this.peers.get(from);
      if (!link) {
        link = this.#newConnection(from, "in");
        link.pc.ondatachannel = (event) => {
          const channel = event.channel;
          channel.binaryType = "arraybuffer";
          channel.onopen = () => {
            link.state = "open";
            link.localFp = dtlsFingerprint(link.pc.localDescription?.sdp);
            link.remoteFp = dtlsFingerprint(link.pc.currentRemoteDescription?.sdp);
            this.#status();
            if (this.actor < from) this.#beginHandshake(from, link);
          };
          link.channel = channel;
          channel.onclose = () => this.#drop(from, "channel closed");
          channel.onmessage = (e) => this.#onFrame(from, link, e.data);
        };
        link.pc.onicecandidate = (event) => {
          if (event.candidate) this.signal?.(from, { kind: "ice", candidate: event.candidate.toJSON() });
        };
      }
      await link.pc.setRemoteDescription(data.sdp);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.signal?.(from, { kind: "answer", sdp: plainSdp(link.pc.localDescription) });
      return;
    }

    const link = this.peers.get(from);
    if (!link) return;

    if (data.kind === "answer") {
      if (link.pc.signalingState === "have-local-offer") await link.pc.setRemoteDescription(data.sdp);
      return;
    }
    if (data.kind === "ice" && data.candidate) {
      try {
        await link.pc.addIceCandidate(data.candidate);
      } catch {
        /* pre-description candidates are safe to drop */
      }
    }
  }

  /* --- direct pairing (no server) ----------------------------------------- */

  /** The out-of-band ticket. Carries the room secret, so it must only ever
   *  travel by QR / picture code — never over the relay. A `scope` marks a
   *  guest ticket: the holder may read exactly one item and nothing else. */
  async #ticket(role, id, sdp, scope = null) {
    const slim = slimSdp(sdp);
    const dtls = dtlsFingerprint(sdp);

    // Template the SDP, but only ship the template if rebuilding it here and
    // now yields the same connection. The check runs on the sending device
    // precisely because that is the last place a fallback is still possible.
    let sd = templateSdp(slim);
    if (sd && sdpEssence(rebuildSdp(sd)) !== sdpEssence(slim)) sd = null;
    // The fingerprint is already a top-level ticket field; sending it twice is a
    // hundred characters of QR for nothing. rebuildSdp lends it back on arrival.
    if (sd && dtls && sd.fp?.toUpperCase() === dtls) delete sd.fp;
    const packed = sd && dtls ? b64(Uint8Array.from(dtls.split(":"), (h) => parseInt(h, 16))) : null;

    return {
      v: sd ? PAIRING_VERSION : LEGACY_PAIRING_VERSION,
      role,
      room: CONFIG.room,
      actor: this.actor,
      id,
      idKey: this.security.identity ? b64(this.security.identity.spki) : null,
      // A guest ticket carries NO room secret: a scoped reader must not be
      // handed the key to the whole chamber. Its session uses a per-share
      // secret instead, so it literally cannot decrypt anything but its item.
      psk: scope ? b64(scope.secret) : this.security.roomSecret ? b64(this.security.roomSecret) : null,
      scope: scope ? { shareId: scope.shareId, type: scope.type, id: scope.id } : null,
      // Exactly one pair is present: `fp`+`sd` on a v3 ticket, `dtls`+`sdp` on
      // the v2 fallback. JSON.stringify drops the undefined ones for us, and
      // ticketFingerprint/ticketSdp read either form on the way back in.
      fp: packed || undefined,
      dtls: packed ? undefined : dtls,
      sd: sd || undefined,
      sdp: sd ? undefined : slim,
    };
  }

  async createInvite(scope = null) {
    if (!this.supported) throw new Error("This browser has no WebRTC support.");
    const inviteId = b64(crypto.getRandomValues(new Uint8Array(6)));
    const link = this.#newConnection(null, "out");
    // Serving a guest: this peer is restricted to the one item from the start.
    if (scope) link.guestScope = { shareId: scope.shareId, type: scope.type, id: scope.id };
    const channel = link.pc.createDataChannel(CHANNEL, { ordered: true });
    this.pending.set(inviteId, { link, channel, scope });

    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    await this.#gatherIce(link.pc);

    const enc = await encodePayload(await this.#ticket("offer", inviteId, link.pc.localDescription.sdp, scope));
    return { id: inviteId, code: enc.code, compact: enc.compact };
  }

  /** A guest invite: the recipient can read only the one shared item. The
   *  per-share secret keys their session, so the chamber's own record stays
   *  sealed to them even though they are a real peer on the mesh. */
  createGuestInvite(shareId, type, id, secret) {
    return this.createInvite({ shareId, type, id, secret });
  }

  /** The scope a given peer is restricted to, or null for a full member. */
  peerScope(actor) {
    return this.peers.get(actor)?.guestScope || null;
  }

  /** True when THIS device joined as a scoped guest rather than a full member. */
  get guestScope() {
    return this.#guestScope || null;
  }

  async acceptInvite(code) {
    if (!this.supported) throw new Error("This browser has no WebRTC support.");
    const t = await decodePayload(code);
    if (t.role !== "offer") throw new Error("That looks like a reply code, not an invite.");
    if (t.room !== CONFIG.room) throw new Error(`That invite is for a different room ("${t.room}").`);
    if (t.actor === this.actor) throw new Error("That invite came from this device.");
    // Resolve the SDP BEFORE absorbing anything: a ticket we cannot rebuild must
    // not have already talked this device into joining its room.
    const offerSdp = ticketSdp(t);

    // Adopt the room secret and pin the inviter's identity from the code.
    await this.#absorbTicket(t);

    const link = this.#newConnection(t.actor, "in");
    link.pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = "arraybuffer";
      channel.onopen = () => {
        link.state = "open";
        link.localFp = dtlsFingerprint(link.pc.localDescription?.sdp);
        link.remoteFp = ticketFingerprint(t);
        this.#status();
        if (this.actor < t.actor) this.#beginHandshake(t.actor, link);
      };
      link.channel = channel;
      channel.onclose = () => this.#drop(t.actor, "channel closed");
      channel.onmessage = (e) => this.#onFrame(t.actor, link, e.data);
    };

    await link.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await link.pc.createAnswer();
    await link.pc.setLocalDescription(answer);
    await this.#gatherIce(link.pc);

    return encodePayload(await this.#ticket("answer", t.id, link.pc.localDescription.sdp));
  }

  async completeInvite(answerCode) {
    const t = await decodePayload(answerCode);
    if (t.role !== "answer") throw new Error("That is an invite code, not a reply code.");
    if (t.room !== CONFIG.room) throw new Error(`That reply is for a different room ("${t.room}").`);
    // Same order as acceptInvite: fail on an unreadable ticket before the
    // pending invite is consumed, so a bad scan does not burn the code.
    const answerSdp = ticketSdp(t);

    const key = this.pending.has(t.id) ? t.id : [...this.pending.keys()].at(-1);
    const pending = this.pending.get(key);
    if (!pending) throw new Error("No invite is waiting for a reply on this device.");
    this.pending.delete(key);

    // ANSWER leg: we already hold the room secret, so never adopt one from a
    // reply (that would let a hostile answer hijack our room or demote us to a
    // guest). Only the peer's expected key is recorded, and it is durably
    // learned in #secure() after the PSK-confirmed handshake.
    await this.#absorbTicket(t, { adoptSecret: false });

    const { link, channel } = pending;
    // Every send path (#raw, #sealTo) writes to link.channel, so without this the
    // inviter could never send its hello/confirm and serverless QR / picture-code
    // pairing would open a data channel that then sat mute forever.
    link.channel = channel;
    link.remoteFp = ticketFingerprint(t);
    this.peers.set(t.actor, link);
    channel.onopen = () => {
      link.state = "open";
      link.localFp = dtlsFingerprint(link.pc.localDescription?.sdp);
      this.#status();
      if (this.actor < t.actor) this.#beginHandshake(t.actor, link);
    };
    channel.onclose = () => this.#drop(t.actor, "channel closed");
    channel.onmessage = (e) => this.#onFrame(t.actor, link, e.data);
    if (channel.readyState === "open") channel.onopen();

    await link.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this.#status();
    return t.actor;
  }

  /**
   * Absorb a pairing ticket: adopt the room/scope secret (OFFER leg only) and
   * record the peer's expected key fingerprint for the handshake.
   *
   * `adoptSecret` is false on the ANSWER leg: an answer travels from the joiner
   * back to the inviter, who already holds the room secret and must NEVER be
   * talked into replacing it — or into becoming a scoped guest — by anything a
   * reply ticket claims. That was a real defeat: a malicious answer could
   * overwrite the inviter's room secret and demote them to a guest.
   *
   * The identity key is only recorded as the handshake's EXPECTED pin here; the
   * durable directory entry is written later, in #secure(), and only once the
   * peer has proven the PSK. So a ticket can never durably teach us a key for an
   * actor that has not completed a confirmed, room-authenticated handshake.
   */
  async #absorbTicket(t, { adoptSecret = true } = {}) {
    if (adoptSecret && t.scope) {
      // A guest ticket: we are joining to read ONE item. We take the per-share
      // secret as our session key and mark ourselves scoped, so this device
      // never even asks for — let alone decrypts — the rest of the chamber.
      this.#guestScope = { shareId: t.scope.shareId, type: t.scope.type, id: t.scope.id };
      if (t.psk) {
        try {
          this.security.roomSecret = unb64(t.psk);
        } catch {
          /* handshake will fail closed */
        }
      }
      this.dispatchEvent(new CustomEvent("guest", { detail: this.#guestScope }));
    } else if (adoptSecret && t.psk && this.security.adoptRoomSecret) {
      try {
        this.security.adoptRoomSecret(unb64(t.psk));
      } catch {
        /* malformed secret — the handshake will simply fail closed */
      }
    }
    if (t.idKey) {
      try {
        const spki = unb64(t.idKey);
        this.pins.set(t.actor, await fingerprint(spki));
      } catch {
        /* ignore a malformed key; TOFU still applies */
      }
    }
  }

  #gatherIce(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        clearTimeout(grace);
        pc.removeEventListener("icegatheringstatechange", onState);
        pc.removeEventListener("icecandidate", onCand);
        resolve();
      };
      const onState = () => pc.iceGatheringState === "complete" && done();
      const onCand = (e) => {
        // A server-reflexive / relay candidate is the one that matters for
        // cross-network pairing; the moment it lands we have all we need, so
        // stop waiting for formal completion.
        const c = e.candidate?.candidate || "";
        if (!e.candidate || c.includes("srflx") || c.includes("relay")) done();
      };
      // Resolve after a short grace no matter what: by now host candidates are in
      // the local description, which is enough for same-network pairing. If STUN
      // answers within the grace, onCand resolves us even sooner.
      const grace = setTimeout(done, ICE_GRACE_MS);
      // Absolute safety net.
      const hard = setTimeout(done, ICE_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", onState);
      pc.addEventListener("icecandidate", onCand);
    });
  }

  /* --- send --------------------------------------------------------------- */

  /** Broadcast (or unicast, with `to`) a message, sealed per peer. */
  send(msg, to) {
    let delivered = 0;
    for (const [id, link] of this.peers) {
      if (to && id !== to) continue;
      // Roster gossip is consumed here rather than surfaced to the app layer.
      this.#sealTo(link, msg).then((ok) => ok && (delivered += 1));
      delivered += link.secured ? 1 : 0;
    }
    return delivered > 0;
  }
}

/** The safety-word alphabet: the same friendly emoji used for badges. */
const SAFETY_ALPHABET = [..."🦉🦊🐸🐼🦄🐙🦖🐝🌊🌱🍩🍕🎲🎨🚀🏆🐮🦁🐧🦋🌈⭐🍎🎈"];

export default PeerTransport;
