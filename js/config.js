/**
 * config.js — deployment configuration.
 *
 * Everything here is optional. With the file exactly as shipped, the site is
 * a fully working local-first application: it seeds from the static JSON in
 * /data, records every action in a durable local op log, and syncs across
 * tabs and directly between browsers over WebRTC. Filling in `apiBase` adds
 * an always-on relay and server-side durability on top of that — it is never
 * required for correctness.
 */

export const CONFIG = {
  /**
   * Cloudflare Worker origin, e.g. "https://cousin-congress.<you>.workers.dev".
   * Empty string = no server. The app stays fully functional.
   */
  apiBase: "",

  /** Logical room. Peers only exchange state within the same room. */
  room: "cousin-congress",

  /** Where the genesis snapshot lives, relative to the page. */
  dataBase: "data",

  /** Transports, each independently switchable. */
  sync: {
    tabs: true, // BroadcastChannel between tabs on this device
    server: true, // Durable Object WebSocket relay (needs apiBase)
    peers: true, // WebRTC data channels between browsers
    /**
     * ICE servers for WebRTC. STUN is enough for most home networks; add a
     * TURN entry if cousins sit behind symmetric NATs.
     */
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.l.google.com:19302" },
    ],
    /** Anti-entropy sweep interval (ms). Heals any gap a live message missed. */
    antiEntropyMs: 20000,
    /** Compact the log into a snapshot once it exceeds this many ops. */
    compactAfter: 400,
  },

  /**
   * Identity. The chamber is small and social, not adversarial: a member
   * claims a seat and the claim is recorded in the log. Set `requireKey` and
   * deploy the Worker if you want writes gated on a shared secret.
   */
  identity: {
    requireKey: false,
    storageKey: "cc.identity",
  },

  /** Feature switches, mostly useful when embedding a single section. */
  features: {
    customCursor: true,
    liveClock: true,
    offlineQueue: true,
  },
};

export default CONFIG;
