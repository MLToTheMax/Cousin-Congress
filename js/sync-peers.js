/**
 * sync-peers.js — browser-to-browser replication over WebRTC.
 *
 * Two ways to pair:
 *
 *   Brokered — when a relay is configured, offers and answers ride the
 *   existing WebSocket and pairing is automatic. The relay never sees chamber
 *   state, only the handshake.
 *
 *   Direct — with no server at all, one member generates an invite code and
 *   another pastes it back. This is the path that makes a purely static
 *   GitHub Pages deployment a genuinely multi-user application.
 *
 * Once a data channel is open the two replicas exchange version vectors and
 * backfill each other. Because ops gossip onward through every open channel,
 * a client that pairs with a single peer still converges on the state of the
 * whole mesh — one online cousin is enough to rebuild everything.
 */

import CONFIG from "./config.js";
import { emojiDecode, emojiEncode, looksLikeIconCode } from "./icons.js";

const CHANNEL = "cc-ops";
const ICE_TIMEOUT_MS = 3500;

/* --------------------------------------------------------------------------
   Invite codes — written in the emoji alphabet from icons.js.

   Wire format is one version byte (1 = gzipped JSON, 2 = plain JSON) followed
   by the payload, the whole thing emoji-encoded. Older base64 codes ("z." /
   "p." prefixes) still decode, so a cousin on the previous build can pair
   with one on this build.
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

async function encodePayload(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === "undefined") return emojiEncode(concatBytes(2, raw));
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  return emojiEncode(concatBytes(1, packed));
}

async function decodePayload(code) {
  const text = String(code).trim();

  if (looksLikeIconCode(text)) {
    const bytes = emojiDecode(text);
    if (bytes.length < 2) throw new Error("That code is too short — copy the whole picture string.");
    const body = bytes.slice(1);
    const json = bytes[0] === 1 ? await gunzip(body) : new TextDecoder().decode(body);
    return JSON.parse(json);
  }

  // Legacy base64 codes from the previous build.
  const compact = text.replace(/\s+/g, "");
  const [tag, body] = compact.startsWith("z.") || compact.startsWith("p.")
    ? [compact.slice(0, 1), compact.slice(2)]
    : ["p", compact];
  const bytes = base64ToBytes(body);
  if (tag === "p") return JSON.parse(new TextDecoder().decode(bytes));
  return JSON.parse(await gunzip(bytes));
}

/* ========================================================================== */

export class PeerTransport extends EventTarget {
  /**
   * @param {string} actor  this replica's stable id
   * @param {(to: string, data: object) => void} signal  brokered signaling sink
   */
  constructor(actor, signal) {
    super();
    this.name = "peers";
    this.actor = actor;
    this.signal = signal;
    this.supported = typeof RTCPeerConnection !== "undefined";
    /** actorId -> { pc, channel, state } */
    this.peers = new Map();
    /** Manual invites awaiting an answer, keyed by invite id. */
    this.pending = new Map();
    this.stopped = true;
  }

  get status() {
    const open = [...this.peers.values()].filter((p) => p.state === "open").length;
    return {
      name: this.name,
      state: !this.supported ? "unsupported" : open ? "connected" : "idle",
      peers: open,
      connecting: this.peers.size - open,
      label: open ? `${open} peer${open === 1 ? "" : "s"}` : "no peers",
    };
  }

  get peerList() {
    return [...this.peers.entries()].map(([id, p]) => ({
      id,
      state: p.state,
      direction: p.direction,
      since: p.since,
    }));
  }

  start() {
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    for (const [, peer] of this.peers) peer.pc.close();
    this.peers.clear();
    this.#status();
  }

  #status() {
    this.dispatchEvent(new CustomEvent("status"));
  }

  #newConnection(remoteActor, direction) {
    const pc = new RTCPeerConnection({ iceServers: CONFIG.sync.iceServers });
    const entry = { pc, channel: null, state: "connecting", direction, since: Date.now() };

    pc.oniceconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.iceConnectionState)) {
        this.#drop(remoteActor, pc.iceConnectionState);
      }
    };

    if (remoteActor) this.peers.set(remoteActor, entry);
    this.#status();
    return entry;
  }

  #attach(remoteActor, entry, channel) {
    entry.channel = channel;
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      entry.state = "open";
      this.#status();
      this.dispatchEvent(new CustomEvent("peeropen", { detail: { peer: remoteActor } }));
    };

    channel.onclose = () => this.#drop(remoteActor, "channel closed");

    channel.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      this.dispatchEvent(
        new CustomEvent("message", { detail: { msg, peer: remoteActor || msg.actor } })
      );
    };
  }

  #drop(remoteActor, reason) {
    const entry = this.peers.get(remoteActor);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {
      /* already gone */
    }
    this.peers.delete(remoteActor);
    this.#status();
    this.dispatchEvent(new CustomEvent("peerclose", { detail: { peer: remoteActor, reason } }));
  }

  /* --- brokered pairing --------------------------------------------------- */

  /** Initiate a connection to a peer discovered through the relay. */
  async connectTo(remoteActor) {
    if (!this.supported || this.stopped) return;
    if (this.peers.has(remoteActor)) return;
    // Deterministic tiebreak: only the lexicographically smaller actor dials,
    // so two clients discovering each other never collide on glare.
    if (this.actor >= remoteActor) return;

    const entry = this.#newConnection(remoteActor, "out");
    const channel = entry.pc.createDataChannel(CHANNEL, { ordered: true });
    this.#attach(remoteActor, entry, channel);

    entry.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signal?.(remoteActor, { kind: "ice", candidate: event.candidate.toJSON() });
      }
    };

    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    this.signal?.(remoteActor, { kind: "offer", sdp: entry.pc.localDescription });
  }

  /** Handle a signaling message relayed from `from`. */
  async onSignal(from, data) {
    if (!this.supported || this.stopped || !data) return;

    if (data.kind === "offer") {
      let entry = this.peers.get(from);
      if (!entry) {
        entry = this.#newConnection(from, "in");
        entry.pc.ondatachannel = (event) => this.#attach(from, entry, event.channel);
        entry.pc.onicecandidate = (event) => {
          if (event.candidate) {
            this.signal?.(from, { kind: "ice", candidate: event.candidate.toJSON() });
          }
        };
      }
      await entry.pc.setRemoteDescription(data.sdp);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      this.signal?.(from, { kind: "answer", sdp: entry.pc.localDescription });
      return;
    }

    const entry = this.peers.get(from);
    if (!entry) return;

    if (data.kind === "answer") {
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription(data.sdp);
      }
      return;
    }

    if (data.kind === "ice" && data.candidate) {
      try {
        await entry.pc.addIceCandidate(data.candidate);
      } catch {
        // Candidates that arrive before the remote description are safe to
        // drop; ICE retries with the ones that follow.
      }
    }
  }

  /* --- direct pairing (no server) ----------------------------------------- */

  /**
   * Produce an invite code. ICE candidates are gathered up front and folded
   * into the SDP so the code is complete and self-contained — there is no
   * second channel to trickle over.
   */
  async createInvite() {
    if (!this.supported) throw new Error("This browser has no WebRTC support.");

    const inviteId = Math.random().toString(36).slice(2, 8);
    const entry = this.#newConnection(null, "out");
    const channel = entry.pc.createDataChannel(CHANNEL, { ordered: true });

    this.pending.set(inviteId, { entry, channel });

    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    await this.#gatherIce(entry.pc);

    return {
      id: inviteId,
      code: await encodePayload({
        v: 1,
        role: "offer",
        room: CONFIG.room,
        actor: this.actor,
        id: inviteId,
        sdp: entry.pc.localDescription,
      }),
    };
  }

  /** Consume an invite code and return the answer code to send back. */
  async acceptInvite(code) {
    if (!this.supported) throw new Error("This browser has no WebRTC support.");

    const payload = await decodePayload(code);
    if (payload.role !== "offer") throw new Error("That looks like an answer, not an invite.");
    if (payload.room !== CONFIG.room) throw new Error(`That invite is for room "${payload.room}".`);
    if (payload.actor === this.actor) throw new Error("That invite came from this device.");

    const remoteActor = payload.actor;
    const entry = this.#newConnection(remoteActor, "in");
    entry.pc.ondatachannel = (event) => this.#attach(remoteActor, entry, event.channel);

    await entry.pc.setRemoteDescription(payload.sdp);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    await this.#gatherIce(entry.pc);

    return encodePayload({
      v: 1,
      role: "answer",
      room: CONFIG.room,
      actor: this.actor,
      id: payload.id,
      sdp: entry.pc.localDescription,
    });
  }

  /** Close the loop on the inviting side. */
  async completeInvite(answerCode) {
    const payload = await decodePayload(answerCode);
    if (payload.role !== "answer") throw new Error("That is an invite code, not an answer code.");

    const pendingKey = this.pending.has(payload.id) ? payload.id : [...this.pending.keys()].at(-1);
    const pending = this.pending.get(pendingKey);
    if (!pending) throw new Error("No invite is waiting for an answer on this device.");

    const remoteActor = payload.actor;
    this.pending.delete(pendingKey);
    this.peers.set(remoteActor, pending.entry);
    this.#attach(remoteActor, pending.entry, pending.channel);
    await pending.entry.pc.setRemoteDescription(payload.sdp);
    this.#status();
    return remoteActor;
  }

  /** Wait for a complete candidate set, but never hang on a stalled gather. */
  #gatherIce(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, ICE_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  /* --- send ---------------------------------------------------------------- */

  send(msg, to) {
    const body = JSON.stringify(msg);
    let delivered = 0;
    for (const [id, peer] of this.peers) {
      if (to && id !== to) continue;
      if (peer.state !== "open" || peer.channel?.readyState !== "open") continue;
      try {
        peer.channel.send(body);
        delivered += 1;
      } catch {
        this.#drop(id, "send failed");
      }
    }
    return delivered > 0;
  }
}

export default PeerTransport;
