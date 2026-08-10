/**
 * sync.js — the replication coordinator.
 *
 * One wire protocol, three interchangeable transports. Every transport is a
 * dumb pipe that carries these messages:
 *
 *   hello  { vv }   introduce ourselves and advertise what we hold
 *   vv     { vv }   a digest, sent on connect and on every anti-entropy sweep
 *   ops    { ops }  a delta, or a freshly authored op being gossiped
 *   signal { data } WebRTC handshake, relayed by the server — or, with no
 *                   server, carried the last hop by another tab or another peer
 *   peers  { list } roster of other replicas online, sent by the relay
 *
 * The exchange is deliberately tiny and terminating: a `hello` is answered
 * with a delta plus our own digest; a digest is answered with a delta and
 * nothing else. Two clients therefore converge in one and a half round trips
 * and then go quiet until something actually changes.
 */

import CONFIG from "./config.js";
import { VV } from "./crdt.js";
import TabTransport from "./sync-tabs.js";
import ServerTransport from "./sync-server.js";
import PeerTransport from "./sync-peers.js";
import { Identity, KeyDirectory, newPairingSecret, deriveRoomKey } from "./crypto.js";
import { unb64, b64 } from "./crypto.js";
import WalkieTalkie from "./walkie.js";
import { migrations } from "./migrate.js";

const ROOM_SECRET_KEY = "cc.roomsecret";
/** How far a signalling frame may travel through the mesh before it is dropped.
 *  Three hops covers "new tab → an already-connected tab → the peer" with room
 *  to spare, and bounds the gossip if a routing table ever goes stale. */
const SIGNAL_MAX_HOPS = 3;

export class SyncCoordinator extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.actor = store.actorId;
    this.transports = [];
    this.sweepTimer = null;
    this.keepaliveTimer = null;
    this.started = false;

    // The mesh's shared secret. Configured deployments can pin one; otherwise
    // a device mints its own and hands it to peers through pairing codes, so
    // whoever you pair with joins your room rather than a stranger's.
    this.roomSecret = this.#loadRoomSecret();
    this.directory = new KeyDirectory();
    this.identity = null; // set in start(), async

    this.tabs = CONFIG.sync.tabs ? new TabTransport() : null;
    this.server = CONFIG.sync.server ? new ServerTransport(this.actor) : null;
    this.peers = CONFIG.sync.peers
      ? new PeerTransport(this.actor, (to, data) => this.#relaySignal(to, data), {
          identity: null, // filled in start()
          directory: this.directory,
          roomSecret: this.roomSecret,
          adoptRoomSecret: (secret) => this.#adoptRoomSecret(secret),
          // ICE servers are Chair-controlled. On by default (so cousins on
          // different networks can find each other), but the Chair can switch
          // them off for a strict no-outside-servers mode, in which pairing
          // works only on the same local network.
          iceServers: () =>
            this.store.state.session?.stun === false ? [] : CONFIG.sync.iceServers,
          // Chair bans live in the replicated record, so every peer enforces
          // them, not just the device the Chair happened to be using.
          isDeviceRevoked: (kid) => Boolean(kid && this.store.state.devices?.[kid]?.revoked),
        })
      : null;

    for (const t of [this.tabs, this.server, this.peers]) if (t) this.transports.push(t);

    // Voice rides the same encrypted mesh as everything else: the walkie hands
    // us clips, we seal and broadcast them over the peer channels, and inbound
    // clips are routed straight back to it — so audio inherits the mesh's
    // security instead of needing a channel of its own.
    this.walkie = new WalkieTalkie(
      (msg) => this.peers?.send(msg),
      { actorId: this.actor, displayName: () => this.store.me?.name || "A cousin" },
      () => this.store.select.canTalk(this.store.identity.memberId)
    );
  }

  #loadRoomSecret() {
    if (CONFIG.roomSecret) {
      try {
        return unb64(CONFIG.roomSecret);
      } catch {
        /* fall through to a generated one */
      }
    }
    try {
      const saved = localStorage.getItem(ROOM_SECRET_KEY);
      if (saved) return unb64(saved);
    } catch {
      /* no storage — a fresh secret each session, still fine */
    }
    const secret = newPairingSecret();
    try {
      localStorage.setItem(ROOM_SECRET_KEY, b64(secret));
    } catch {
      /* ephemeral */
    }
    return secret;
  }

  /**
   * Adopt a room secret handed over by a pairing code. This is how a joining
   * device enters an existing chamber: whoever invited them is authoritative
   * about which room they are joining.
   */
  #adoptRoomSecret(secret) {
    if (!(secret instanceof Uint8Array) || secret.length !== 32) return;
    this.roomSecret = secret;
    if (this.peers) this.peers.security.roomSecret = secret;
    // Re-derive the room MAC key for the room we just joined, so our ops carry
    // a MAC this room accepts and we can authenticate theirs.
    deriveRoomKey(secret)
      .then((key) => {
        this.store.roomKey = key;
      })
      .catch(() => {});
    try {
      localStorage.setItem(ROOM_SECRET_KEY, b64(secret));
    } catch {
      /* ephemeral */
    }
  }

  /**
   * Adopt a room secret carried by a seat code (base64url). Same validated path
   * a pairing code uses, so the MAC key is re-derived and the length is checked.
   */
  adoptRoomSecretFromCode(psk) {
    this.#adoptRoomSecret(unb64(psk));
  }

  /** The room secret this device is currently in, for minting seat codes. */
  get currentRoomSecret() {
    return this.roomSecret;
  }

  /* --- lifecycle ---------------------------------------------------------- */

  /**
   * Provision the long-term signing identity before the mesh comes up.
   * Called by start(); safe to await separately in tests.
   */
  async provision() {
    if (this.identity) return this.identity;
    this.identity = await Identity.load(this.actor, this.store.storage);
    await this.directory.learn(this.actor, this.identity.spki, { pinned: true });
    if (this.peers) this.peers.security.identity = this.identity;

    // Derive the room MAC key from the shared PSK and hand it to the store
    // BEFORE anything is signed or announced, so our very first op (the identity
    // announcement) already carries a room MAC and is accepted by peers.
    try {
      this.store.roomKey = await deriveRoomKey(this.roomSecret);
    } catch {
      /* no room secret material — degrade like the rest of the crypto path */
    }
    this.store.identitySigner = this.identity; // store signs ops with it
    this.store.verifier = this.directory; // and verifies incoming ops against it

    // Announce our signing key so peers can authenticate our gossiped ops even
    // if they never pair with us directly. The announcement is self-signed, so
    // it needs no prior trust — and it must go out before our other ops so they
    // are not quarantined at the far end.
    this.store.dispatch("id.announce", { spki: b64(this.identity.spki) });
    return this.identity;
  }

  start() {
    if (this.started) return this;
    this.started = true;

    // Bring the crypto identity and room key up. The provisioning window it
    // opens is sealed at the ingest layer, not here: until store.verifier is
    // set, ingest QUARANTINES every network op instead of folding it, and once
    // the room key lands the quarantine is re-checked against it. So the mesh
    // can start immediately — which keeps our identity announcement propagating
    // promptly — without a window in which unauthenticated ops could be folded.
    this.provision()
      // Peers redial themselves from start(), but a link that opens before the
      // signing identity exists is torn down at the handshake — so nudge once
      // more the moment there is an identity to shake hands with.
      .then(() => this.peers?.redial({ reset: true }))
      .catch((err) => console.error("[cousin-congress] identity", err));

    // Fetch any schema converters this deployment points at, so an op from a
    // future build can be understood rather than merely quarantined.
    migrations.load().catch(() => {});

    for (const transport of this.transports) {
      transport.addEventListener("message", (e) =>
        this.#onMessage(transport, e.detail.msg, e.detail.peer)
      );
      transport.addEventListener("status", () => this.#emitStatus());
      transport.start();
    }

    // A freshly opened WebRTC channel is the moment to introduce ourselves.
    this.peers?.addEventListener("peeropen", (e) => {
      this.peers.send(this.#hello(), e.detail.peer);
      this.#emitStatus();
    });
    this.peers?.addEventListener("peerclose", () => this.#emitStatus());

    /* A device joined the mesh. Record it in the shared record — not just the
       local connection log — so the Chair has a durable roster of everything
       that has ever connected, with the details needed to recognise a stranger,
       and can bar one later from anywhere. */
    this.peers?.addEventListener("peersecured", (e) => {
      const { peer, fingerprint, address, safety } = e.detail || {};
      if (!fingerprint) return;
      this.store.dispatch("device.seen", {
        kid: fingerprint,
        actor: peer,
        ip: address || null,
        label: e.detail?.label || "",
        safety: safety || null,
        at: new Date().toISOString(),
      });
      this.dispatchEvent(new CustomEvent("devicejoined", { detail: e.detail }));
    });

    // If this device becomes a scoped guest, it holds only a per-share secret,
    // never the room secret — so it cannot MAC or verify room ops. Exempt it
    // from the room-membership gate; its reads are already scope-filtered and
    // arrive over the sharer's encrypted uplink.
    this.peers?.addEventListener("guest", (e) => {
      this.store.guestMode = true;
      this.store.roomKey = null;
      this.store.guestScopeId = e.detail?.id || null;
    });

    // The relay coming up is the moment a brokered redial can actually succeed:
    // until then the nudges and offers had nowhere to go.
    this.server?.addEventListener("open", () => {
      this.#broadcast(this.#hello());
      this.peers?.redial({ reset: true });
    });
    this.server?.addEventListener("poll", () => this.#pullFromServer());

    // Locally authored ops go out immediately; nothing waits on them.
    this.store.onOutbound = (ops) => this.#broadcast({ t: "ops", actor: this.actor, ops });

    // When a revocation lands — ours or the Chair's, from any device — cut off
    // any guest we are currently serving for that share.
    this.store.addEventListener("change", (e) => {
      for (const op of e.detail?.ops || []) {
        if (op.type === "share.revoke" && op.payload?.id) this.peers?.revokeGuest(op.payload.id);
      }
    });

    this.#broadcast(this.#hello());
    this.#startSweeps();

    addEventListener("online", () => {
      this.sweep();
      this.#reconnect(true);
    });
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.sweep();
        this.#reconnect(true);
      }
    });
    // A parting digest lets peers notice the gap sooner.
    addEventListener("pagehide", () => this.#broadcast({ t: "bye", actor: this.actor }));

    return this;
  }

  stop() {
    clearInterval(this.sweepTimer);
    clearInterval(this.keepaliveTimer);
    for (const transport of this.transports) transport.stop();
    this.store.onOutbound = null;
    this.started = false;
    this.#emitStatus();
  }

  #startSweeps() {
    clearInterval(this.sweepTimer);
    this.sweepTimer = setInterval(() => this.sweep(), CONFIG.sync.antiEntropyMs);
    // Keepalive: a cheap ping keeps NAT bindings and the relay socket warm so
    // sessions genuinely stay open, and nudges reconnection when they don't.
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      this.#broadcast({ t: "ping", actor: this.actor });
      this.#reconnect();
    }, 25_000);
  }

  /**
   * Re-establish the mesh after a nap or a reload. Two halves: the relay knows
   * who is online, so ask it to re-announce; and the peer transport holds a
   * durable roster of everyone we have ever shaken hands with, so it calls them
   * back itself. Reaching any one of them is enough — roster gossip returns the
   * rest — which is why this is safe to run on every wake.
   *
   * @param {boolean} wake  true for a real event (online, visible, relay up),
   *   which clears the per-peer attempt caps; false for a routine keepalive tick.
   */
  #reconnect(wake = false) {
    if (this.server?.state === "connected") this.#broadcast(this.#hello(), this.peers);
    this.peers?.redial({ reset: wake });
  }

  /**
   * Anti-entropy. Broadcasting a digest is enough: anyone holding ops we lack
   * answers with them, and anyone missing ours learns to ask. This is what
   * repairs a gap left by a dropped message or a transport that was down.
   */
  sweep() {
    this.tabs?.resetPeers();
    this.#broadcast({ t: "vv", actor: this.actor, vv: this.store.advertisedVv });
    if (this.server?.mode === "http") this.#pullFromServer();
    this.#emitStatus();
  }

  /* --- protocol ----------------------------------------------------------- */

  #hello() {
    // Advertise the gap-free frontier, not the raw max, so a peer resends any op
    // we are missing in the middle of an actor's sequence rather than assuming
    // we already hold it.
    return { t: "hello", actor: this.actor, room: CONFIG.room, vv: this.store.advertisedVv };
  }

  #broadcast(msg, except) {
    for (const transport of this.transports) {
      if (transport === except) continue;
      transport.send(msg);
    }
  }

  async #onMessage(transport, msg, peer) {
    if (!msg || msg.actor === this.actor) return;

    switch (msg.t) {
      case "hello": {
        // Answer with what they are missing, then advertise our own position
        // so they can close the gap in the other direction.
        this.#sendDelta(transport, msg.vv, peer);
        transport.send({ t: "vv", actor: this.actor, vv: this.store.advertisedVv }, peer);
        this.#emitStatus();
        break;
      }

      case "vv": {
        this.#sendDelta(transport, msg.vv, peer);
        break;
      }

      case "ops": {
        // A scoped guest ignores anything but its one item, no matter what a
        // peer sends — the client-side half of "everything else is blocked".
        const scope = this.peers?.guestScope;
        const incoming = scope
          ? (msg.ops || []).filter((op) => op?.payload?.id === scope.id)
          : msg.ops;

        const accepted = await this.store.ingest(incoming, transport.name);
        if (accepted.length) {
          // Gossip onward across OTHER transports, and — crucially — across
          // other PEERS, not just the tabs/relay. That peer-to-peer-to-peer
          // relay is what lets a node reach the whole network through a chain
          // of hops when it cannot open a direct channel to the origin.
          this.#broadcast({ t: "ops", actor: this.actor, ops: accepted }, transport);
          if (transport === this.peers) this.peers.relay({ t: "ops", actor: this.actor, ops: accepted }, peer);
          this.dispatchEvent(
            new CustomEvent("received", { detail: { count: accepted.length, via: transport.name } })
          );
        }
        break;
      }

      case "revoked": {
        // The device serving us a shared item just cut us off. Surface it so
        // the reader page can wipe the item from the screen and this device.
        if (transport === this.peers && this.peers.guestScope) {
          this.dispatchEvent(new CustomEvent("revoked", { detail: { shareId: msg.shareId } }));
        }
        break;
      }

      case "peers": {
        if (!this.peers) break;
        for (const other of msg.peers || []) {
          if (other !== this.actor) this.peers.connectTo(other).catch(() => {});
        }
        break;
      }

      case "roster": {
        // Full-mesh gossip: a secured peer just told us who else it knows, so
        // we dial anyone we are missing. Only ever arrives over an encrypted
        // channel, so the peer list is already authenticated.
        if (transport === this.peers) this.peers.handleRoster(msg.peers);
        break;
      }

      case "ptt": {
        // Walkie-talkie audio chunk, only accepted from an encrypted peer.
        if (transport !== this.peers) break;
        // Flood to the WHOLE connected mesh, not just our direct neighbours, so
        // a cousin reachable only through a chain of hops still hears it live —
        // the same transitive relay ops get. Each chunk is relayed at most once
        // (deduped by clip+seq) so it cannot loop, and we never re-flood our own
        // clip coming back around the ring.
        const key = `${msg.clipId}:${msg.seq}`;
        this.pttSeen ||= new Set();
        if (this.pttSeen.has(key)) break;
        this.pttSeen.add(key);
        if (this.pttSeen.size > 8192) this.pttSeen.delete(this.pttSeen.values().next().value);
        this.walkie?.receive(msg);
        if (msg.from !== this.actor) this.peers.relay(msg, peer);
        break;
      }

      case "ping": {
        // Keepalive; the transport already noted liveness by delivering it.
        break;
      }

      case "signal": {
        if (msg.to === this.actor) {
          this.peers?.onSignal(msg.from, msg.data).catch(() => {});
          break;
        }
        this.#forwardSignal(msg, transport, peer);
        break;
      }

      case "bye": {
        this.#emitStatus();
        break;
      }

      default:
        // Unknown verbs are ignored rather than rejected, so a newer client
        // can add protocol features without breaking an older one.
        break;
    }
  }

  #sendDelta(transport, remoteVv, peer) {
    let delta = this.store.delta(remoteVv || {});

    // If the peer is a scoped guest, this is the enforcement point: we serve
    // ONLY the one shared item, and only while the grant is live. Any request
    // for the rest of the chamber is answered with nothing. Revocation cuts
    // the connection entirely (below), but even before that, the guest cannot
    // pull anything it was not granted.
    if (transport === this.peers) {
      const scope = this.peers.peerScope(peer);
      if (scope) {
        if (!this.store.select.shareLive(scope.shareId)) {
          this.peers.revokeGuest(scope.shareId);
          return;
        }
        delta = delta.filter((op) => op?.payload?.id === scope.id);
      }
    }
    if (!delta.length) return;

    // Chunked so a large backfill cannot exceed a data-channel message cap.
    const CHUNK = 150;
    for (let i = 0; i < delta.length; i += CHUNK) {
      transport.send({ t: "ops", actor: this.actor, ops: delta.slice(i, i + CHUNK) }, peer);
    }
    this.dispatchEvent(
      new CustomEvent("sent", { detail: { count: delta.length, via: transport.name } })
    );
  }

  /**
   * Get a WebRTC handshake frame to a peer we have no channel to yet.
   *
   * The relay does this in one hop when there is one. When there is not — the
   * shipped default — the frame is handed to whatever CAN reach the target: a
   * peer we are already linked to, or another tab on this device that is. That
   * second path is what lets a freshly opened tab dial the family directly
   * instead of living forever on the back of its sibling's connection.
   *
   * Carrying somebody's handshake grants nothing: the link it produces still has
   * to prove the room secret in the application handshake before an op crosses
   * it, which is exactly why an untrusted relay was always safe to use.
   */
  #relaySignal(to, data) {
    const msg = {
      t: "signal",
      actor: this.actor,
      from: this.actor,
      to,
      data,
      sid: `${this.actor}:${(this.signalSeq = (this.signalSeq || 0) + 1)}`,
      h: 0,
    };
    if (this.server?.state === "connected") {
      this.server.send(msg);
      return true;
    }
    if (this.peers?.hasPeer(to)) {
      this.peers.send(msg, to);
      return true;
    }
    // Last resort: shout it into the mesh and across our own tabs, in case
    // someone can carry it the last hop. Report whether there was anybody at
    // all to carry it — a device with no relay, no live peer and no sibling tab
    // has NO path to the peer it wants, and the caller needs to know that
    // rather than wait forever for an answer nobody could have heard.
    const viaTabs = Boolean(this.tabs);
    const viaPeers = (this.peers?.peerList || []).length > 0;
    this.tabs?.send(msg);
    this.peers?.relay(msg);
    return viaTabs || viaPeers;
  }

  /**
   * Carry someone else's signalling frame one hop closer. Deduped by `sid` and
   * hop-capped, for the same reason the walkie flood is: a frame must reach a
   * peer that is two links away without being able to circle the mesh.
   */
  #forwardSignal(msg, from, peer) {
    const hops = (msg.h | 0) + 1;
    if (hops > SIGNAL_MAX_HOPS || !msg.sid) return;
    this.signalSeen ||= new Set();
    if (this.signalSeen.has(msg.sid)) return;
    this.signalSeen.add(msg.sid);
    if (this.signalSeen.size > 2048) this.signalSeen.delete(this.signalSeen.values().next().value);

    const forwarded = { ...msg, h: hops };
    // A direct link to the target ends the journey here rather than gossiping.
    if (this.peers?.hasPeer(msg.to)) {
      this.peers.send(forwarded, msg.to);
      return;
    }
    for (const transport of this.transports) {
      if (transport !== from && transport !== this.peers) transport.send(forwarded);
    }
    this.peers?.relay(forwarded, from === this.peers ? peer : undefined);
  }

  async #pullFromServer() {
    if (!this.server) return;
    const ops = await this.server.pull(this.store.advertisedVv);
    if (ops.length) await this.store.ingest(ops, "server");
  }

  /* --- live scoped shares ------------------------------------------------- */

  /**
   * Mint a live guest link for one item. The item is granted through a
   * replicated `share.grant` op (so the Chair can see and revoke it), and the
   * link is a scoped pairing ticket keyed by a per-share secret — the guest
   * joins the mesh but can pull only this one item.
   */
  async createGuestShare(type, id) {
    if (!this.peers) throw new Error("Peer sync is switched off.");
    const shareId = `sh-${Date.now().toString(36)}-${b64(crypto.getRandomValues(new Uint8Array(4)))}`;
    const secret = newPairingSecret();
    this.store.dispatch("share.grant", {
      id: shareId,
      itemType: type,
      itemId: id,
      by: this.store.identity.memberId || this.actor,
      grantedAt: new Date().toISOString(),
    });
    const { code } = await this.peers.createGuestInvite(shareId, type, id, secret);
    return { shareId, code };
  }

  /** Revoke a live share: record it, notify the guest so its screen wipes, and
   *  drop the connection. Callable by the sharer or the Chair. */
  revokeShare(shareId) {
    this.store.dispatch("share.revoke", { id: shareId, by: this.store.identity.memberId || this.actor });
    this.peers?.revokeGuest(shareId);
  }

  /* --- direct pairing passthrough ----------------------------------------- */

  createInvite() {
    if (!this.peers) throw new Error("Peer sync is switched off in config.js.");
    return this.peers.createInvite();
  }

  acceptInvite(code) {
    if (!this.peers) throw new Error("Peer sync is switched off in config.js.");
    return this.peers.acceptInvite(code);
  }

  completeInvite(code) {
    if (!this.peers) throw new Error("Peer sync is switched off in config.js.");
    return this.peers.completeInvite(code);
  }

  /* --- reporting ----------------------------------------------------------- */

  get status() {
    return {
      actor: this.actor,
      ops: this.store.log.size,
      replicas: Object.keys(this.store.vv).length,
      vv: this.store.vv,
      known: VV.size(this.store.vv),
      transports: this.transports.map((t) => t.status),
      peers: this.peers?.peerList ?? [],
      // True while known peers are still being called back. The banner needs
      // this to tell "we are on our way back" apart from "nobody has ever
      // paired with this device" — two situations that look identical from a
      // peer count of zero and read very differently to a cousin.
      reconnecting: Boolean(this.peers?.reconnecting),
      knownPeers: this.peers?.knownPeers?.length ?? 0,
      storageHealthy: this.store.storageHealthy,
      online: navigator.onLine,
    };
  }

  #emitStatus() {
    this.dispatchEvent(new CustomEvent("status", { detail: this.status }));
  }
}

/**
 * One reading of a status object for the connection banner, so every surface
 * that shows "are we connected?" says the same thing.
 *
 * The point of the extra state: a device with peers in its roster that it is
 * actively calling back is NOT "not connected yet" — that phrasing sends a
 * cousin off to re-pair a link that was about to come back on its own. It gets
 * its own word, and its own dot.
 */
export function describeLink(status) {
  const peers = status.peers?.filter?.((p) => p.state === "secure" || p.state === "open").length || 0;
  const relayLive = status.transports?.find((t) => t.name === "server")?.state === "connected";
  const live = peers > 0 || relayLive;
  return {
    peers,
    relayLive,
    state: live ? "live" : status.reconnecting ? "reconnecting" : status.online ? "local" : "offline",
    text:
      peers > 0
        ? `${peers} device${peers === 1 ? "" : "s"} connected`
        : status.reconnecting
          ? "reconnecting…"
          : relayLive
            ? "waiting on the relay"
            : "not connected yet",
  };
}

export default SyncCoordinator;
