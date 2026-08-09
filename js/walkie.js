/**
 * walkie.js — push-to-talk across the chamber.
 *
 * Why clips rather than a live audio stream: adding a media track to the
 * existing peer connections would force a renegotiation on every mesh change,
 * and a continuously open microphone in a house full of children is the wrong
 * default on both privacy and battery. Press-hold-release matches how a
 * walkie-talkie actually behaves, the microphone is only live while the button
 * is held, and the recorded clip rides the same encrypted data channel as
 * everything else — so voice inherits the mesh's security properties for free
 * instead of needing its own.
 *
 * The transport is injected. This module never touches a peer connection
 * directly; it is handed a `send` that has already sealed whatever it is
 * given, which is what keeps voice from quietly becoming the one unencrypted
 * thing in the building.
 */

const MAX_CLIP_MS = 30_000;
const CHUNK_BYTES = 12 * 1024; // conservative for the smallest data-channel buffers
const MAX_INCOMING_BYTES = 4 * 1024 * 1024;
const ASSEMBLY_TIMEOUT_MS = 30_000;

/** Preference order: Opus is tiny and universally decodable where supported. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
];

const bytesToBase64 = (bytes) => {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const base64ToBytes = (text) => {
  const binary = atob(text);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};

export class WalkieTalkie extends EventTarget {
  /**
   * @param {(msg: object) => void} send  broadcasts a message to every peer
   * @param {{actorId: string, displayName: () => string}} identity
   */
  constructor(send, identity, permit = null) {
    super();
    this.send = send;
    this.identity = identity;
    // Optional gate: returns true if this device is allowed to transmit. The
    // Chair sets the policy; the mic simply asks before it opens.
    this.permit = permit;
    this.supported =
      typeof MediaRecorder !== "undefined" &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia);

    this.enabled = false;
    this.stream = null;
    this.recorder = null;
    this.transmitting = false;
    this.startedAt = 0;
    this.autoStop = null;

    /** clipId -> {from, name, mime, total, parts: Map, bytes, at} */
    this.incoming = new Map();
    this.queue = [];
    this.playing = null;
    this.audioContext = null;
    /** Recently completed clip ids, so a duplicate broadcast is not replayed. */
    this.seen = new Set();
  }

  get state() {
    return {
      supported: this.supported,
      enabled: this.enabled,
      transmitting: this.transmitting,
      receiving: Boolean(this.playing),
      speaker: this.playing?.name || null,
      queued: this.queue.length,
    };
  }

  #emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
    if (name !== "state") this.dispatchEvent(new CustomEvent("state", { detail: this.state }));
  }

  /* --- microphone ---------------------------------------------------------- */

  /**
   * Ask for the microphone. Deliberately separate from transmitting so the
   * permission prompt happens when the member opts in, not mid-sentence when
   * they first press the button.
   */
  async enable() {
    if (!this.supported) {
      this.#emit("error", { message: "This browser can't record audio." });
      return false;
    }
    if (this.enabled) return true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      this.enabled = true;
      this.#emit("enabled");
      return true;
    } catch (error) {
      const denied = error?.name === "NotAllowedError";
      this.#emit("error", {
        message: denied
          ? "The microphone is blocked. Allow it in your browser's address bar to talk."
          : `No microphone available (${error?.name || "unknown"}).`,
      });
      return false;
    }
  }

  disable() {
    this.stopTransmit();
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    this.enabled = false;
    this.#emit("disabled");
  }

  /* --- transmitting -------------------------------------------------------- */

  async startTransmit() {
    if (this.transmitting) return;
    if (this.permit && !this.permit()) {
      this.#emit("error", { message: "The Chair hasn't given this seat the talkie yet." });
      return;
    }
    if (!this.enabled && !(await this.enable())) return;

    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const chunks = [];

    try {
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    } catch (error) {
      this.#emit("error", { message: `Recorder refused to start: ${error.message}` });
      return;
    }

    this.recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    this.recorder.onstop = () => {
      const blob = new Blob(chunks, { type: this.recorder.mimeType || mime || "audio/webm" });
      // Anything under a moment is a mis-tap, not a transmission.
      if (blob.size > 800 && Date.now() - this.startedAt > 250) this.#broadcast(blob);
      this.recorder = null;
    };

    this.recorder.start();
    this.transmitting = true;
    this.startedAt = Date.now();
    this.#beep(880, 0.07);

    // A held button on a phone that goes to sleep must not record forever.
    this.autoStop = setTimeout(() => this.stopTransmit(), MAX_CLIP_MS);
    this.#emit("transmit-start");
  }

  stopTransmit() {
    clearTimeout(this.autoStop);
    if (!this.transmitting) return;
    this.transmitting = false;
    try {
      this.recorder?.stop();
    } catch {
      /* already stopped */
    }
    this.#beep(560, 0.06);
    this.#emit("transmit-stop");
  }

  async #broadcast(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const clipId = `${this.identity.actorId}:${Date.now().toString(36)}`;
    const encoded = bytesToBase64(bytes);
    const total = Math.ceil(encoded.length / CHUNK_BYTES);

    // Mark our own clip as seen so a peer echoing it back is not played to us.
    this.seen.add(clipId);

    for (let i = 0; i < total; i += 1) {
      this.send({
        t: "ptt",
        clipId,
        seq: i,
        total,
        mime: blob.type,
        from: this.identity.actorId,
        name: this.identity.displayName?.() || "A cousin",
        chunk: encoded.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES),
      });
    }
    this.#emit("sent", { clipId, bytes: bytes.length, chunks: total });
  }

  /* --- receiving ----------------------------------------------------------- */

  /** Feed every inbound `ptt` message here. Returns true if it was consumed. */
  receive(msg) {
    if (!msg || msg.t !== "ptt") return false;
    if (typeof msg.clipId !== "string" || msg.clipId.length > 96) return true;
    if (!Number.isInteger(msg.seq) || !Number.isInteger(msg.total)) return true;
    if (msg.total < 1 || msg.total > 512 || msg.seq < 0 || msg.seq >= msg.total) return true;
    if (typeof msg.chunk !== "string" || msg.chunk.length > CHUNK_BYTES + 16) return true;
    if (msg.from === this.identity.actorId || this.seen.has(msg.clipId)) return true;

    this.#sweep();

    let entry = this.incoming.get(msg.clipId);
    if (!entry) {
      if (this.incoming.size > 8) return true; // flood guard
      entry = {
        from: msg.from,
        name: typeof msg.name === "string" ? msg.name.slice(0, 60) : "A cousin",
        mime: typeof msg.mime === "string" ? msg.mime.slice(0, 60) : "audio/webm",
        total: msg.total,
        parts: new Map(),
        bytes: 0,
        at: Date.now(),
      };
      this.incoming.set(msg.clipId, entry);
      this.#emit("receiving", { clipId: msg.clipId, name: entry.name });
    }

    entry.bytes += msg.chunk.length;
    if (entry.bytes > MAX_INCOMING_BYTES) {
      this.incoming.delete(msg.clipId);
      return true;
    }
    entry.parts.set(msg.seq, msg.chunk);

    if (entry.parts.size === entry.total) {
      this.incoming.delete(msg.clipId);
      this.seen.add(msg.clipId);
      if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value);

      let encoded = "";
      for (let i = 0; i < entry.total; i += 1) encoded += entry.parts.get(i);
      try {
        const blob = new Blob([base64ToBytes(encoded)], { type: entry.mime });
        this.#enqueue({ name: entry.name, from: entry.from, url: URL.createObjectURL(blob) });
      } catch {
        /* a corrupt clip is dropped rather than crashing the channel */
      }
    }
    return true;
  }

  /** Drop half-assembled clips from a peer that vanished mid-transmission. */
  #sweep() {
    const cutoff = Date.now() - ASSEMBLY_TIMEOUT_MS;
    for (const [id, entry] of this.incoming) {
      if (entry.at < cutoff) this.incoming.delete(id);
    }
  }

  /* --- playback ------------------------------------------------------------ */

  #enqueue(clip) {
    this.queue.push(clip);
    this.#emit("queued", clip);
    if (!this.playing) this.#playNext();
  }

  #playNext() {
    const clip = this.queue.shift();
    if (!clip) {
      this.playing = null;
      this.#emit("idle");
      return;
    }
    this.playing = clip;
    this.#emit("playing", clip);
    this.#beep(660, 0.05);

    const audio = new Audio(clip.url);
    const done = () => {
      URL.revokeObjectURL(clip.url);
      this.#playNext();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(() => {
      // Autoplay is gated until the member has interacted with the page. The
      // UI surfaces this so they can tap once to open the channel.
      this.#emit("blocked", clip);
      done();
    });
  }

  /** Short radio chirp, so pressing and releasing feel like a real handset. */
  #beep(frequency, duration) {
    try {
      this.audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioContext.state === "suspended") this.audioContext.resume();
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.type = "square";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.06, this.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.audioContext.currentTime + duration);
      osc.connect(gain).connect(this.audioContext.destination);
      osc.start();
      osc.stop(this.audioContext.currentTime + duration);
    } catch {
      /* chirps are decoration; never let one break the channel */
    }
  }
}

export default WalkieTalkie;
