/**
 * sync-server.js — optional Cloudflare relay.
 *
 * The server is a convenience, not an authority. It does three things: it
 * keeps a durable copy of the log so state survives every browser being
 * closed, it relays ops to members who are not simultaneously online, and it
 * brokers the WebRTC handshake so peers can pair without copy-pasting codes.
 *
 * All three are optional. With `apiBase` empty this transport reports
 * "offline" and the rest of the application is unaffected.
 */

import CONFIG from "./config.js";

const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];

export class ServerTransport extends EventTarget {
  constructor(actor, room = CONFIG.room) {
    super();
    this.name = "server";
    this.actor = actor;
    this.room = room;
    this.base = (CONFIG.apiBase || "").replace(/\/$/, "");
    this.ws = null;
    this.state = this.base ? "idle" : "offline";
    this.attempt = 0;
    this.timer = null;
    this.stopped = true;
    this.mode = "ws"; // "ws" | "http"
    this.pollTimer = null;
    this.lastError = "";
    /** Ops we could not deliver yet; drained on reconnect. */
    this.outbox = [];
  }

  get status() {
    return {
      name: this.name,
      state: this.state,
      mode: this.mode,
      queued: this.outbox.length,
      label:
        this.state === "connected"
          ? this.mode === "ws"
            ? "relay live"
            : "relay (polling)"
          : this.state === "offline"
            ? "not configured"
            : this.state,
    };
  }

  #setState(state, error = "") {
    if (this.state === state && !error) return;
    this.state = state;
    this.lastError = error;
    this.dispatchEvent(new CustomEvent("status"));
  }

  start() {
    if (!this.base) {
      this.#setState("offline");
      return;
    }
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pollTimer);
    this.ws?.close();
    this.ws = null;
    this.#setState("idle");
  }

  /* --- WebSocket --------------------------------------------------------- */

  #connect() {
    if (this.stopped || this.ws) return;
    this.#setState("connecting");

    const url = new URL(`${this.base}/room/${encodeURIComponent(this.room)}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("actor", this.actor);

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.#fallbackOrRetry(String(err));
      return;
    }

    socket.onopen = () => {
      this.ws = socket;
      this.attempt = 0;
      this.mode = "ws";
      this.#setState("connected");
      this.#drain();
      this.dispatchEvent(new CustomEvent("open"));
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      this.dispatchEvent(new CustomEvent("message", { detail: { msg, peer: msg.actor } }));
    };

    socket.onclose = () => {
      const wasConnected = this.ws === socket;
      this.ws = null;
      if (!this.stopped) this.#fallbackOrRetry(wasConnected ? "closed" : "refused");
    };

    socket.onerror = () => {
      // `onclose` always follows; retry logic lives there so it runs once.
    };
  }

  #fallbackOrRetry(reason) {
    this.attempt += 1;
    // Two failed socket attempts usually means a proxy that blocks upgrades,
    // so switch to plain HTTP delta polling rather than retrying forever.
    if (this.attempt >= 2 && this.mode === "ws") {
      this.mode = "http";
      this.#startPolling();
      return;
    }
    this.#setState("retrying", reason);
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#connect(), wait);
  }

  /* --- HTTP fallback ------------------------------------------------------ */

  #startPolling() {
    clearInterval(this.pollTimer);
    this.#setState("connected");
    const poll = () => this.dispatchEvent(new CustomEvent("poll"));
    this.pollTimer = setInterval(poll, 8000);
    poll();
    this.#drain();
  }

  /** Ask for everything the server holds that `vv` does not describe. */
  async pull(vv) {
    if (!this.base) return [];
    try {
      const res = await fetch(`${this.base}/api/ops/since`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: this.room, actor: this.actor, vv }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return Array.isArray(body.ops) ? body.ops : [];
    } catch (err) {
      this.#setState("retrying", String(err));
      return [];
    }
  }

  async #post(ops) {
    const res = await fetch(`${this.base}/api/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: this.room, actor: this.actor, ops }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /* --- send -------------------------------------------------------------- */

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }

    // Only ops are worth queueing: digests and signaling are ephemeral, and
    // replaying a stale handshake on reconnect would just confuse the peer.
    if (msg.t === "ops" && Array.isArray(msg.ops)) {
      this.outbox.push(...msg.ops);
      if (this.mode === "http" && this.base) this.#drain();
      this.dispatchEvent(new CustomEvent("status"));
    }
    return false;
  }

  async #drain() {
    if (!this.outbox.length || !this.base) return;
    const batch = this.outbox.slice();
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t: "ops", actor: this.actor, ops: batch }));
      } else {
        await this.#post(batch);
      }
      // Drop exactly what we sent; anything appended meanwhile survives.
      this.outbox = this.outbox.slice(batch.length);
      this.dispatchEvent(new CustomEvent("status"));
    } catch {
      // Stay queued. The next reconnect or poll tick tries again.
    }
  }
}

export default ServerTransport;
