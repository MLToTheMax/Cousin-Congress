/**
 * Cousin Congress — Cloudflare Worker.
 *
 * The optional server tier. It adds three things the static site cannot do by
 * itself, and deliberately nothing else:
 *
 *   1. Durable, always-on custody of the op log (Durable Object storage), so
 *      the chamber survives every browser being closed at once.
 *   2. A relay, so two members who are never online simultaneously still
 *      converge (WebSocket when possible, HTTP delta polling otherwise).
 *   3. WebRTC signaling + peer discovery, so browsers can pair automatically
 *      instead of exchanging invite codes.
 *
 * It also accepts the two genuinely private flows — constituent messages and
 * bulletin subscriptions — which are stored server-side and never replicated.
 *
 * The Worker speaks the same tiny protocol as every other transport:
 * hello / vv / ops / signal / peers. It validates shape and size, never
 * content: the clients own the CRDT semantics, and the server never folds
 * state. That keeps it a dumb, durable pipe — easy to audit, hard to corrupt.
 *
 * Deploy:  cd worker && npx wrangler deploy
 * Then set `apiBase` in js/config.js to the printed URL.
 */

const MAX_OPS_PER_POST = 500;
const MAX_OP_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ROOM_LEN = 64;
const RATE_LIMIT_PER_MIN = 240;

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-congress-key",
    "access-control-max-age": "86400",
  };
}

const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) },
  });

const err = (env, status, message) => json(env, { error: message }, status);

function isValidOp(op) {
  return (
    op &&
    typeof op === "object" &&
    typeof op.actor === "string" &&
    op.actor.length > 0 &&
    op.actor.length <= 64 &&
    Number.isInteger(op.seq) &&
    op.seq >= 0 &&
    typeof op.hlc === "string" &&
    op.hlc.length <= 128 &&
    typeof op.type === "string" &&
    op.type.length <= 64 &&
    op.payload !== null &&
    typeof op.payload === "object" &&
    JSON.stringify(op).length <= MAX_OP_BYTES
  );
}

const roomOk = (room) =>
  typeof room === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(room) && room.length <= MAX_ROOM_LEN;

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("body too large");
  return JSON.parse(text);
}

/* --------------------------------------------------------------------------
   Worker entry
   -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // Optional shared secret for write endpoints. Leave WRITE_KEY unset for
    // the family-trust model; set it and mirror in config.js to gate writes.
    if (env.WRITE_KEY && request.method === "POST") {
      if (request.headers.get("x-congress-key") !== env.WRITE_KEY) {
        return err(env, 401, "missing or wrong x-congress-key");
      }
    }

    try {
      // Room-scoped traffic (WebSocket + room HTTP) goes to the Durable Object.
      const roomMatch = url.pathname.match(/^\/room\/([^/]+)\/(ws|info)$/);
      if (roomMatch) {
        const room = decodeURIComponent(roomMatch[1]);
        if (!roomOk(room)) return err(env, 400, "bad room name");
        const id = env.CHAMBER.idFromName(room);
        return env.CHAMBER.get(id).fetch(request);
      }

      if (url.pathname === "/api/ops" && request.method === "POST") {
        return this.postOps(request, env);
      }
      if (url.pathname === "/api/ops/since" && request.method === "POST") {
        return this.opsSince(request, env);
      }
      if (url.pathname === "/api/messages" && request.method === "POST") {
        return this.postMessage(request, env);
      }
      if (url.pathname === "/api/subscribe" && request.method === "POST") {
        return this.postSubscribe(request, env);
      }
      if (url.pathname === "/api/health") {
        return json(env, { ok: true, service: "cousin-congress", at: new Date().toISOString() });
      }

      return err(env, 404, "no such route");
    } catch (error) {
      if (error instanceof SyntaxError) return err(env, 400, "invalid JSON");
      if (String(error.message).includes("too large")) return err(env, 413, "body too large");
      console.error("worker error", error);
      return err(env, 500, "internal error");
    }
  },

  /** HTTP fallback: append ops to the room's Durable Object. */
  async postOps(request, env) {
    const body = await readJson(request);
    if (!roomOk(body.room)) return err(env, 400, "bad room");
    const id = env.CHAMBER.idFromName(body.room);
    return env.CHAMBER.get(id).fetch("https://do/ingest", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** HTTP fallback: version-vector delta pull. */
  async opsSince(request, env) {
    const body = await readJson(request);
    if (!roomOk(body.room)) return err(env, 400, "bad room");
    const id = env.CHAMBER.idFromName(body.room);
    return env.CHAMBER.get(id).fetch("https://do/since", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Private constituent mail — stored in D1 when bound, KV otherwise. */
  async postMessage(request, env) {
    const body = await readJson(request);
    const { name, email, topic, body: text } = body || {};
    if (!name || !email || !text || String(text).length > 4000) {
      return err(env, 400, "name, email and body are required");
    }
    const record = {
      id: crypto.randomUUID(),
      name: String(name).slice(0, 120),
      email: String(email).slice(0, 200),
      topic: String(topic || "petition").slice(0, 40),
      body: String(text).slice(0, 4000),
      receivedAt: new Date().toISOString(),
    };

    if (env.DB) {
      await env.DB.prepare(
        "INSERT INTO messages (id, name, email, topic, body, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
      )
        .bind(record.id, record.name, record.email, record.topic, record.body, record.receivedAt)
        .run();
    } else if (env.MAILBOX) {
      await env.MAILBOX.put(`msg:${record.receivedAt}:${record.id}`, JSON.stringify(record));
    } else {
      return err(env, 503, "no storage bound for messages — bind D1 (DB) or KV (MAILBOX)");
    }
    return json(env, { ok: true, id: record.id });
  },

  /** Bulletin subscriptions — idempotent on email. */
  async postSubscribe(request, env) {
    const body = await readJson(request);
    const email = String(body?.email || "").slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(env, 400, "a valid email is required");

    if (env.DB) {
      await env.DB.prepare(
        "INSERT INTO subscribers (email, subscribed_at) VALUES (?1, ?2) ON CONFLICT(email) DO NOTHING"
      )
        .bind(email, new Date().toISOString())
        .run();
    } else if (env.MAILBOX) {
      await env.MAILBOX.put(`sub:${email}`, new Date().toISOString());
    } else {
      return err(env, 503, "no storage bound for subscriptions — bind D1 (DB) or KV (MAILBOX)");
    }
    return json(env, { ok: true });
  },
};

/* ==========================================================================
   ChamberRoom — one Durable Object per room
   ========================================================================== */

export class ChamberRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** Live sockets: actorId -> WebSocket */
    this.sockets = new Map();
    /** Naive per-actor rate limiting, reset each minute. */
    this.rates = new Map();
    this.rateWindow = 0;
  }

  /* --- storage ------------------------------------------------------------
     Ops are stored one key per op ("op:<actor>:<seq padded>") so writes are
     append-only and reads can be filtered. The version vector is one key.  */

  async loadVv() {
    return (await this.state.storage.get("vv")) || {};
  }

  async storeOps(ops) {
    const vv = await this.loadVv();
    const fresh = [];
    const writes = {};

    for (const op of ops) {
      if (!isValidOp(op)) continue;
      if ((vv[op.actor] ?? -1) >= op.seq) continue; // already have it
      vv[op.actor] = Math.max(vv[op.actor] ?? -1, op.seq);
      writes[`op:${op.actor}:${String(op.seq).padStart(10, "0")}`] = op;
      fresh.push(op);
    }

    if (fresh.length) {
      writes.vv = vv;
      await this.state.storage.put(writes);
    }
    return { fresh, vv };
  }

  /** Everything the caller's vector is missing. */
  async delta(remoteVv) {
    const out = [];
    const seen = remoteVv && typeof remoteVv === "object" ? remoteVv : {};
    const all = await this.state.storage.list({ prefix: "op:" });
    for (const op of all.values()) {
      if ((seen[op.actor] ?? -1) < op.seq) out.push(op);
    }
    return out;
  }

  rateLimited(actor) {
    const now = Math.floor(Date.now() / 60000);
    if (now !== this.rateWindow) {
      this.rateWindow = now;
      this.rates.clear();
    }
    const count = (this.rates.get(actor) || 0) + 1;
    this.rates.set(actor, count);
    return count > RATE_LIMIT_PER_MIN;
  }

  /* --- entry -------------------------------------------------------------- */

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) return this.handleWebSocket(request, url);

    if (url.pathname === "/ingest") {
      const { actor, ops } = await request.json();
      if (!Array.isArray(ops) || ops.length > MAX_OPS_PER_POST) {
        return new Response(JSON.stringify({ error: "bad ops" }), { status: 400, headers: JSON_HEADERS });
      }
      if (this.rateLimited(actor || "anon")) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: JSON_HEADERS });
      }
      const { fresh, vv } = await this.storeOps(ops);
      if (fresh.length) this.broadcast({ t: "ops", actor: "server", ops: fresh }, actor);
      return new Response(JSON.stringify({ ok: true, accepted: fresh.length, vv }), {
        headers: { ...JSON_HEADERS, ...corsHeaders(this.env) },
      });
    }

    if (url.pathname === "/since") {
      const { vv } = await request.json();
      const ops = await this.delta(vv);
      return new Response(JSON.stringify({ ops, vv: await this.loadVv() }), {
        headers: { ...JSON_HEADERS, ...corsHeaders(this.env) },
      });
    }

    if (url.pathname.endsWith("/info")) {
      const vv = await this.loadVv();
      return new Response(
        JSON.stringify({
          replicas: Object.keys(vv).length,
          online: [...this.sockets.keys()],
          vv,
        }),
        { headers: { ...JSON_HEADERS, ...corsHeaders(this.env) } }
      );
    }

    return new Response("not found", { status: 404 });
  }

  /* --- websockets ---------------------------------------------------------- */

  async handleWebSocket(request, url) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const actor = (url.searchParams.get("actor") || "").slice(0, 64);
    if (!actor) return new Response("actor required", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // One socket per actor: a reconnect replaces the old one.
    this.sockets.get(actor)?.close(1000, "superseded");
    this.sockets.set(actor, server);

    server.addEventListener("message", (event) => this.onMessage(actor, server, event));
    const drop = () => {
      if (this.sockets.get(actor) === server) {
        this.sockets.delete(actor);
        this.broadcastPeers();
      }
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    // Tell everyone (including the newcomer) who is online, so clients can
    // start WebRTC pairing among themselves.
    this.broadcastPeers();

    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(actor, socket, event) {
    if (typeof event.data !== "string" || event.data.length > MAX_BODY_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.t) {
      case "hello": {
        // Answer with the delta the client is missing, then our vector so the
        // client can push what the server is missing.
        const ops = await this.delta(msg.vv);
        for (let i = 0; i < ops.length; i += 150) {
          this.send(socket, { t: "ops", actor: "server", ops: ops.slice(i, i + 150) });
        }
        this.send(socket, { t: "vv", actor: "server", vv: await this.loadVv() });
        break;
      }

      case "vv": {
        const ops = await this.delta(msg.vv);
        for (let i = 0; i < ops.length; i += 150) {
          this.send(socket, { t: "ops", actor: "server", ops: ops.slice(i, i + 150) });
        }
        break;
      }

      case "ops": {
        if (!Array.isArray(msg.ops) || msg.ops.length > MAX_OPS_PER_POST) return;
        if (this.rateLimited(actor)) return;
        const { fresh } = await this.storeOps(msg.ops);
        // Relay only what was genuinely new, and never back to the sender.
        if (fresh.length) this.broadcast({ t: "ops", actor, ops: fresh }, actor);
        break;
      }

      case "signal": {
        // WebRTC handshake relay: point-to-point, never stored, never inspected.
        if (typeof msg.to !== "string") return;
        const target = this.sockets.get(msg.to);
        if (target) {
          this.send(target, { t: "signal", actor, from: actor, to: msg.to, data: msg.data });
        }
        break;
      }

      case "bye": {
        socket.close(1000, "bye");
        break;
      }

      default:
        break; // forward-compatible: unknown verbs ignored
    }
  }

  send(socket, msg) {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* socket already closing; the close handler cleans up */
    }
  }

  broadcast(msg, exceptActor) {
    const body = JSON.stringify(msg);
    for (const [actor, socket] of this.sockets) {
      if (actor === exceptActor) continue;
      try {
        socket.send(body);
      } catch {
        /* handled by close listener */
      }
    }
  }

  broadcastPeers() {
    this.broadcast({ t: "peers", actor: "server", peers: [...this.sockets.keys()] });
  }
}
