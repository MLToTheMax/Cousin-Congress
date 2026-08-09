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
const PAIRING_VERSION = 2;

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

/** Pull the DTLS fingerprint out of an SDP so the app handshake can bind to it. */
function dtlsFingerprint(sdp) {
  const match = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(sdp || "");
  return match ? match[1].toUpperCase() : null;
}

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
    return {
      name: this.name,
      state: !this.supported ? "unsupported" : open ? "connected" : "idle",
      peers: open,
      connecting: links.length - open,
      label: open ? `${open} peer${open === 1 ? "" : "s"}` : "no peers",
    };
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
  }

  stop() {
    this.stopped = true;
    for (const [, link] of this.peers) this.#close(link);
    this.peers.clear();
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
    this.#log("connected", remoteActor, {
      guest: Boolean(link.guestScope),
      safety: link.safety,
      fingerprint: link.session?.peerFingerprint || null,
    });
    this.#captureAddress(remoteActor, link);
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

    const link = this.#newConnection(remoteActor, "out");
    const channel = link.pc.createDataChannel(CHANNEL, { ordered: true });

    link.pc.onicecandidate = (event) => {
      if (event.candidate) this.signal?.(remoteActor, { kind: "ice", candidate: event.candidate.toJSON() });
    };

    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    link.pendingLocalSdp = link.pc.localDescription.sdp;
    this.signal?.(remoteActor, { kind: "offer", sdp: link.pc.localDescription });
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
      this.signal?.(from, { kind: "answer", sdp: link.pc.localDescription });
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
    return {
      v: PAIRING_VERSION,
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
      dtls: dtlsFingerprint(sdp),
      sdp,
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

    // Adopt the room secret and pin the inviter's identity from the code.
    await this.#absorbTicket(t);

    const link = this.#newConnection(t.actor, "in");
    link.pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = "arraybuffer";
      channel.onopen = () => {
        link.state = "open";
        link.localFp = dtlsFingerprint(link.pc.localDescription?.sdp);
        link.remoteFp = t.dtls;
        this.#status();
        if (this.actor < t.actor) this.#beginHandshake(t.actor, link);
      };
      link.channel = channel;
      channel.onclose = () => this.#drop(t.actor, "channel closed");
      channel.onmessage = (e) => this.#onFrame(t.actor, link, e.data);
    };

    await link.pc.setRemoteDescription({ type: "offer", sdp: t.sdp });
    const answer = await link.pc.createAnswer();
    await link.pc.setLocalDescription(answer);
    await this.#gatherIce(link.pc);

    return encodePayload(await this.#ticket("answer", t.id, link.pc.localDescription.sdp));
  }

  async completeInvite(answerCode) {
    const t = await decodePayload(answerCode);
    if (t.role !== "answer") throw new Error("That is an invite code, not a reply code.");
    if (t.room !== CONFIG.room) throw new Error(`That reply is for a different room ("${t.room}").`);

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
    link.remoteFp = t.dtls;
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

    await link.pc.setRemoteDescription({ type: "answer", sdp: t.sdp });
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
