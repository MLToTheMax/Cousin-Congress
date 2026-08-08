/**
 * sync-tabs.js — same-device replication.
 *
 * The cheapest transport in the stack and the one that runs everywhere: every
 * tab of the site on this device is already a full replica, so a BroadcastChannel
 * is enough to keep them in lockstep with no server and no connection setup.
 * It also means a second tab is a genuine backup of the first.
 */

import CONFIG from "./config.js";

export class TabTransport extends EventTarget {
  constructor(room = CONFIG.room) {
    super();
    this.name = "tabs";
    this.room = room;
    this.channel = null;
    this.supported = typeof BroadcastChannel !== "undefined";
    this.peers = new Set();
  }

  get status() {
    return {
      name: this.name,
      state: this.channel ? "connected" : this.supported ? "idle" : "unsupported",
      peers: this.peers.size,
      label: this.channel ? `${this.peers.size} tab${this.peers.size === 1 ? "" : "s"}` : "off",
    };
  }

  start() {
    if (!this.supported || this.channel) return;
    this.channel = new BroadcastChannel(`cc:${this.room}`);
    this.channel.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.actor) this.peers.add(msg.actor);
      this.dispatchEvent(new CustomEvent("message", { detail: { msg, peer: msg.actor } }));
    };

    // Tabs closing is not observable here, so the peer set is rebuilt from
    // scratch on every anti-entropy round rather than trusted indefinitely.
    this.dispatchEvent(new CustomEvent("status"));
  }

  stop() {
    this.channel?.close();
    this.channel = null;
    this.peers.clear();
    this.dispatchEvent(new CustomEvent("status"));
  }

  send(msg) {
    if (!this.channel) return false;
    try {
      this.channel.postMessage(msg);
      return true;
    } catch {
      // Structured clone failed — almost always an op carrying something
      // non-serializable, which is a bug worth surfacing rather than hiding.
      return false;
    }
  }

  /** Called before each anti-entropy sweep so stale tabs age out. */
  resetPeers() {
    this.peers.clear();
  }
}

export default TabTransport;
