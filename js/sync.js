/**
 * sync.js — the replication coordinator.
 *
 * One wire protocol, three interchangeable transports. Every transport is a
 * dumb pipe that carries these messages:
 *
 *   hello  { vv }   introduce ourselves and advertise what we hold
 *   vv     { vv }   a digest, sent on connect and on every anti-entropy sweep
 *   ops    { ops }  a delta, or a freshly authored op being gossiped
 *   signal { data } WebRTC handshake, relayed by the server for peers
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

export class SyncCoordinator extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.actor = store.actorId;
    this.transports = [];
    this.sweepTimer = null;
    this.started = false;

    this.tabs = CONFIG.sync.tabs ? new TabTransport() : null;
    this.server = CONFIG.sync.server ? new ServerTransport(this.actor) : null;
    this.peers = CONFIG.sync.peers
      ? new PeerTransport(this.actor, (to, data) => this.#relaySignal(to, data))
      : null;

    for (const t of [this.tabs, this.server, this.peers]) if (t) this.transports.push(t);
  }

  /* --- lifecycle ---------------------------------------------------------- */

  start() {
    if (this.started) return this;
    this.started = true;

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

    this.server?.addEventListener("open", () => this.#broadcast(this.#hello()));
    this.server?.addEventListener("poll", () => this.#pullFromServer());

    // Locally authored ops go out immediately; nothing waits on them.
    this.store.onOutbound = (ops) => this.#broadcast({ t: "ops", actor: this.actor, ops });

    this.#broadcast(this.#hello());
    this.#startSweeps();

    addEventListener("online", () => this.sweep());
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.sweep();
    });
    // A parting digest lets peers notice the gap sooner.
    addEventListener("pagehide", () => this.#broadcast({ t: "bye", actor: this.actor }));

    return this;
  }

  stop() {
    clearInterval(this.sweepTimer);
    for (const transport of this.transports) transport.stop();
    this.store.onOutbound = null;
    this.started = false;
    this.#emitStatus();
  }

  #startSweeps() {
    clearInterval(this.sweepTimer);
    this.sweepTimer = setInterval(() => this.sweep(), CONFIG.sync.antiEntropyMs);
  }

  /**
   * Anti-entropy. Broadcasting a digest is enough: anyone holding ops we lack
   * answers with them, and anyone missing ours learns to ask. This is what
   * repairs a gap left by a dropped message or a transport that was down.
   */
  sweep() {
    this.tabs?.resetPeers();
    this.#broadcast({ t: "vv", actor: this.actor, vv: this.store.vv });
    if (this.server?.mode === "http") this.#pullFromServer();
    this.#emitStatus();
  }

  /* --- protocol ----------------------------------------------------------- */

  #hello() {
    return { t: "hello", actor: this.actor, room: CONFIG.room, vv: this.store.vv };
  }

  #broadcast(msg, except) {
    for (const transport of this.transports) {
      if (transport === except) continue;
      transport.send(msg);
    }
  }

  #onMessage(transport, msg, peer) {
    if (!msg || msg.actor === this.actor) return;

    switch (msg.t) {
      case "hello": {
        // Answer with what they are missing, then advertise our own position
        // so they can close the gap in the other direction.
        this.#sendDelta(transport, msg.vv, peer);
        transport.send({ t: "vv", actor: this.actor, vv: this.store.vv }, peer);
        this.#emitStatus();
        break;
      }

      case "vv": {
        this.#sendDelta(transport, msg.vv, peer);
        break;
      }

      case "ops": {
        const accepted = this.store.ingest(msg.ops, transport.name);
        if (accepted.length) {
          // Gossip onward, but never back down the pipe it arrived on. This
          // is what lets a client paired to one peer inherit the whole mesh.
          this.#broadcast({ t: "ops", actor: this.actor, ops: accepted }, transport);
          this.dispatchEvent(
            new CustomEvent("received", { detail: { count: accepted.length, via: transport.name } })
          );
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

      case "signal": {
        if (msg.to === this.actor) this.peers?.onSignal(msg.from, msg.data).catch(() => {});
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
    const delta = this.store.delta(remoteVv || {});
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

  #relaySignal(to, data) {
    this.server?.send({ t: "signal", actor: this.actor, from: this.actor, to, data });
  }

  async #pullFromServer() {
    if (!this.server) return;
    const ops = await this.server.pull(this.store.vv);
    if (ops.length) this.store.ingest(ops, "server");
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
      storageHealthy: this.store.storageHealthy,
      online: navigator.onLine,
    };
  }

  #emitStatus() {
    this.dispatchEvent(new CustomEvent("status", { detail: this.status }));
  }
}

export default SyncCoordinator;
