/**
 * connect.js — the pairing surface and the live-connection chrome.
 *
 * This is the one screen whose entire job is to answer "are we connected?" for
 * someone who does not care how. So the technical machinery — version vectors,
 * transports, the wire format — is tucked into a drawer, and what is left in
 * front is: a code to show, a camera to scan with, a count of who is here, and
 * four emoji to check out loud.
 *
 * The QR decoder and the themed Seal Card are loaded lazily. They are the two
 * heaviest modules in the app and only this page needs them, so importing them
 * on demand keeps every other page light — and lets the page still render if a
 * browser chokes on one of them.
 */

import { qs, qsa, toast, copyText } from "./ui.js";
import { encodeQR, qrToSvg } from "./qr.js";

let decoderModule = null;
let sealcardModule = null;

async function loadDecoder() {
  if (!decoderModule) decoderModule = await import("./qr-decode.js").catch(() => null);
  return decoderModule;
}
async function loadSealcard() {
  if (!sealcardModule) sealcardModule = await import("./sealcard.js").catch(() => null);
  return sealcardModule;
}

/* --------------------------------------------------------------------------
   The live-connection banner, present on every page
   -------------------------------------------------------------------------- */

const SAFETY_FACES = "🦉🦊🐸🐼🦄🐙";

export function mountLinkBanner(sync) {
  const banner = qs("[data-link-banner]");
  if (!banner) return;

  const paint = () => {
    const status = sync.status;
    const peers = status.peers?.filter?.((p) => p.state === "secure" || p.state === "open").length || 0;
    const relay = status.transports?.find((t) => t.name === "server");
    const relayLive = relay?.state === "connected";
    const total = peers + (relayLive ? 1 : 0);

    banner.dataset.link = total > 0 ? "live" : status.online ? "local" : "offline";

    const count = qs("[data-link-count]", banner);
    if (count) count.textContent = String(peers);

    const text = qs("[data-link-text]", banner);
    if (text) {
      text.textContent =
        peers > 0
          ? `${peers} device${peers === 1 ? "" : "s"} connected`
          : relayLive
            ? "waiting on the relay"
            : "not connected yet";
    }

    const cta = qs("[data-link-cta]", banner);
    if (cta) cta.hidden = peers > 0;
  };

  sync.addEventListener("status", paint);
  paint();
  return paint;
}

/* --------------------------------------------------------------------------
   The connect page proper
   -------------------------------------------------------------------------- */

export function mountConnect(sync) {
  // Wire each control only if its markup is on this page, rather than requiring
  // one wrapper element around all of them. The old connect page had a
  // [data-connect] wrapper and the rebuilt pairing page does not, so gating the
  // whole function on that wrapper silently left EVERY pairing control dead —
  // the buttons were there, nothing was listening, and pairing was impossible.
  // Each wire* already no-ops when its own element is absent.
  if (!qs("[data-qr-frame]") && !qs("[data-scanner]") && !qs("[data-code-file]") && !qs("[data-peer-list]")) {
    return;
  }

  wireShow(sync);
  wireScan(sync);
  wireUpload(sync);
  wirePeers(sync);
}

/* --- the pairing flow (pair.html) ------------------------------------------ */

/**
 * The pairing page is a single screen with one card that swaps panes, so the
 * whole journey — choose a side, show or scan, done — never grows the page or
 * asks anyone to scroll. This controller is just the pane switch plus the
 * plumbing that moves the flow forward when something actually connects.
 */
export function mountPairFlow(sync) {
  const flow = qs("[data-pair-flow]");
  if (!flow) return;

  const panes = [...flow.querySelectorAll("[data-pane]")];
  const show = (name) => {
    for (const p of panes) p.hidden = p.dataset.pane !== name;
    // Stop the camera whenever we leave the scanning pane.
    if (name !== "join") qs("[data-action='stop-scan']")?.click();
  };
  flow.__showPane = show;

  document.addEventListener("click", (event) => {
    const mode = event.target.closest("[data-action='pair-mode']");
    if (mode) {
      show(mode.dataset.mode);
      // Showing a code? Mint one immediately — nobody should have to press twice.
      if (mode.dataset.mode === "host") qs("[data-action='show-code']")?.click();
      // Scanning? Open the camera immediately for the same reason.
      if (mode.dataset.mode === "join") qs("[data-action='start-scan']")?.click();
      return;
    }
    if (event.target.closest("[data-action='pair-back']")) show("choose");
  });

  // Paste-a-code fallback for anyone whose camera is unavailable.
  qs("[data-action='paste-code']")?.addEventListener("click", async () => {
    const value = qs("[data-paste-code]")?.value?.trim();
    if (!value) return toast("Paste the code first.", "warn");
    await consumeScannedCode(sync, value);
  });

  // Upload-a-picture lives in the scan pane on this page.
  qs("[data-code-file]")?.closest(".pair__upload")?.addEventListener("click", () => {
    qs("[data-code-file]")?.click();
  });

  // When a peer secures, move to "done" and show the safety word.
  const onPeers = () => {
    const peers = sync.status.peers || [];
    const live = peers.filter((p) => p.state === "open" || p.secured);
    if (live.length && !flow.dataset.done) {
      flow.dataset.done = "1";
      show("done");
    }
    const safety = live.find((p) => p.safety)?.safety;
    const box = qs("[data-pair-safety]");
    if (safety && box) {
      box.hidden = false;
      const word = qs("[data-safety-word]");
      if (word) word.textContent = safety;
    }
  };
  sync.addEventListener("status", onPeers);
  onPeers();

  show("choose");

  // Arrived by scanning a code with the phone's own camera? The ticket is in the
  // address bar. Use it straight away and scrub it, so the whole journey for the
  // joining cousin is: point camera, tap the notification, done.
  const scanned = pairCodeFromLocation();
  if (scanned) {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* best effort */
    }
    toast("Joining your cousin's chamber…");
    consumeScannedCode(sync, scanned);
  }
}

/**
 * Wrap a pairing ticket in a link to this app.
 *
 * A QR holding a bare ticket is useless to the thing most people point at it:
 * the phone's built-in camera. It sees text it cannot act on and offers nothing,
 * so pairing appears simply not to work unless you already knew to open the app
 * and use its in-page scanner first.
 *
 * As a URL, the camera offers to open it, the app loads, and the fragment is
 * consumed on arrival. The ticket rides in the FRAGMENT, which browsers never
 * send to a server — the same reason seat codes use one.
 */
export const PAIR_PREFIX = "#p=";

export function pairLink(payload, loc = location) {
  const path = loc.pathname.replace(/\/[^/]*$/, "/");
  return `${loc.origin}${path}connect.html${PAIR_PREFIX}${encodeURIComponent(payload)}`;
}

/** A pairing ticket carried in this page's address bar, if we arrived by scan. */
export function pairCodeFromLocation(loc = location) {
  const hash = loc.hash || "";
  if (!hash.startsWith(PAIR_PREFIX)) return null;
  try {
    return decodeURIComponent(hash.slice(PAIR_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

/* --- showing our own code -------------------------------------------------- */

async function wireShow(sync) {
  const frame = qs("[data-qr-frame]");
  const answerBox = qs("[data-answer-box]");
  if (!frame) return;

  const showButton = qs("[data-action='show-code']");
  showButton?.addEventListener("click", async () => {
    showButton.disabled = true;
    showButton.textContent = "Drawing your code…";
    try {
      const { code, compact } = await sync.createInvite();
      await paintCode(frame, compact); // QR/card use the short form; text uses the picture code
      ensureScannable(frame);
      const raw = qs("[data-code-text]");
      if (raw) raw.value = code;
      qs("[data-code-out]")?.removeAttribute("hidden");
      toast("Show this to your cousin's camera, or send them the picture.");
    } catch (error) {
      toast(String(error.message || error), "err");
    } finally {
      showButton.disabled = false;
      showButton.textContent = "Show my code again";
    }
  });

  // The inviter pastes back the reply code (or scans it) to finish.
  qs("[data-action='finish-pair']")?.addEventListener("click", async () => {
    const value = answerBox?.value?.trim();
    if (!value) return toast("Paste or scan the reply code first.", "warn");
    try {
      await sync.completeInvite(value);
      toast("Paired! 🎉 Your chambers are syncing now.");
      answerBox.value = "";
    } catch (error) {
      toast(String(error.message || error), "err");
    }
  });
}

/**
 * Render a code either as a Seal Card (pretty, themed) or a plain QR, whichever
 * the toggle asks for. Falls back to a plain QR if the Seal Card module is
 * unavailable, because a scannable-but-plain code always beats no code.
 */
async function paintCode(frame, payload) {
  const wantsCard = qs("[data-card-toggle]")?.checked;
  if (wantsCard) {
    const sc = await loadSealcard();
    if (sc?.renderSealCard) {
      try {
        const me = window.CousinCongress?.store?.me;
        const { svg } = await sc.renderSealCard({
          payload,
          name: me?.name || "A cousin",
          icon: me?.icon || "🪑",
          subtitle: "Scan me to join the chamber",
        });
        frame.innerHTML = svg;
        frame.classList.add("qr-frame--card");
        return;
      } catch {
        /* fall through to a plain QR */
      }
    }
  }
  frame.classList.remove("qr-frame--card");
  paintQr(frame, pairLink(payload));
}

/**
 * Draw a scannable QR into a frame, and make it enlargeable.
 *
 * Scannability is a pixel budget, not a rendering detail. A pairing ticket is
 * ~750 bytes, which lands around a version-20 symbol — 97 modules to a side.
 * A phone camera needs roughly 3-4 CSS pixels per module at arm's length, so
 * that code has to be drawn at ~300px or more. Squeeze the frame down to fit a
 * layout and the code is still *correct* and still completely unreadable, which
 * is exactly how this page broke: 111 modules inside 155px is 1.4px a module.
 *
 * Two defences. Error-correction level L rather than M, because these codes are
 * shown on a clean backlit screen at close range and never printed — the extra
 * capacity buys a smaller symbol, which is worth far more here than redundancy
 * we do not need. And a tap enlarges the code to fill the screen, which is the
 * only reliable answer when the sharing device is itself a narrow phone.
 */
function paintQr(frame, text) {
  frame.innerHTML = qrToSvg(encodeQR(text, { ecl: "L" }), { margin: 3 });
  const svg = frame.querySelector("svg");
  // Remember the module count so we can judge later whether what we drew is
  // actually large enough to read. Only plain QRs get this: the Seal Card is a
  // whole illustrated card and its viewBox says nothing about module size.
  frame.dataset.qrModules = Number((svg?.getAttribute("viewBox") || "").split(" ")[2]) || 0;
  frame.classList.add("pair__qr--zoomable");
  frame.setAttribute("role", "button");
  frame.setAttribute("tabindex", "0");
  frame.setAttribute("title", "Tap to enlarge");
  frame.setAttribute("aria-label", "Pairing code — activate to enlarge for scanning");
  if (!frame.__zoomWired) {
    frame.__zoomWired = true;
    const open = () => zoomQr(frame.querySelector("svg"));
    frame.addEventListener("click", open);
    frame.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  }
}

/* A code smaller than this cannot be read by a camera, so we would rather spill
   a little than draw something decorative. Past the upper bound the extra size
   buys nothing and only eats the fold. */
const MIN_QR_PX = 240;
const MAX_QR_PX = 384;

/**
 * Give the pairing code every pixel the fold has left.
 *
 * Sizing this in `vh` was guesswork that had to be retuned for each viewport
 * and was wrong on all the ones nobody measured: at 360x640 the code came out
 * 266px across, which is 2.7 pixels per module — small enough that the app's own
 * decoder cannot read its own output. The chrome above the code (masthead, live
 * connection banner, pane heading, action row) varies by device and by page
 * state, so the only reliable number is a measured one.
 *
 * Collapse the code to nothing, read what the rest of the fold actually costs,
 * then spend the remainder on the code — the same trick fitFloorConsole uses.
 */
export function fitPairCode() {
  const pair = document.querySelector(".pair");
  if (!pair) return;

  const apply = () => {
    const frame = pair.querySelector(".pair__pane:not([hidden]) .pair__qr");
    if (!frame) return;
    // Clear first, so each pass measures the layout rather than its predecessor.
    pair.style.removeProperty("--pair-qr");
    pair.style.setProperty("--pair-qr", "0px");
    const room = document.documentElement.clientHeight - pair.getBoundingClientRect().bottom;
    const width = Math.min(
      MAX_QR_PX,
      Math.max(MIN_QR_PX, Math.floor(room)),
      Math.floor(frame.parentElement.clientWidth),
    );
    pair.style.setProperty("--pair-qr", `${width}px`);
  };

  apply();

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      apply();
    });
  };
  addEventListener("resize", schedule, { passive: true });
  addEventListener("orientationchange", schedule);
  // Panes swap without a resize, and each one leaves a different amount of room.
  new MutationObserver(schedule).observe(pair, {
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  const banner = document.querySelector("[data-link-banner]");
  if (banner && typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(banner);
}

/**
 * Below this a code is decoration. Measured, not guessed: the app's own decoder
 * reads its own output reliably at 3.1 px per module and fails outright at 2.5,
 * so anything under ~2.9 is a code we should not be asking a camera to try.
 */
const MIN_PX_PER_MODULE = 2.9;

/**
 * On a short screen the fold cannot hold both the page chrome and a code big
 * enough to scan. Rather than draw an unreadable one and let someone stand
 * there failing to scan it, hand them the fullscreen version straight away —
 * which is still a single screen, just one entirely given over to the code.
 */
function ensureScannable(frame) {
  // Two frames before judging. The first lets layout settle after the paint;
  // the second lets fitPairCode's own rAF-scheduled measurement land, since it
  // is what decides the final width. Checking any earlier reads the stylesheet
  // fallback and concludes a 251px code is fine when it is about to be 251px.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const modules = Number(frame?.dataset.qrModules) || 0;
      if (!modules) return;
      const width = frame.getBoundingClientRect().width;
      if (!width || width / modules >= MIN_PX_PER_MODULE) return;
      zoomQr(frame.querySelector("svg"));
    }),
  );
}

/** Blow a code up to fill the screen — the largest a device can possibly show. */
function zoomQr(svg) {
  if (!svg) return;
  const back = document.querySelector(".qr-zoom");
  if (back) back.remove();
  const layer = document.createElement("div");
  layer.className = "qr-zoom";
  layer.innerHTML = `<div class="qr-zoom__code">${svg.outerHTML}</div>
    <p class="qr-zoom__hint">Point your cousin's camera at this. Tap anywhere to close.</p>`;
  const close = () => {
    layer.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  layer.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(layer);
}

/* --- scanning with the camera --------------------------------------------- */

function wireScan(sync) {
  const scanner = qs("[data-scanner]");
  const video = qs("[data-scanner] video");
  if (!scanner || !video) return;

  let stream = null;
  let raf = 0;
  let detector = null;
  const canvas = document.createElement("canvas");

  const stop = () => {
    cancelAnimationFrame(raf);
    for (const track of stream?.getTracks() || []) track.stop();
    stream = null;
    scanner.hidden = true;
  };

  const onCode = async (text) => {
    stop();
    await consumeScannedCode(sync, text);
  };

  const tick = async () => {
    if (!stream) return;
    if (video.readyState >= 2) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0);

      try {
        if (detector) {
          const found = await detector.detect(canvas);
          if (found.length) return onCode(found[0].rawValue);
        } else {
          const dec = await loadDecoder();
          if (dec?.decodeQRFromImageData) {
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const text = dec.decodeQRFromImageData(image);
            if (text) return onCode(text);
          }
        }
      } catch {
        /* a frame that fails to decode is normal; keep scanning */
      }
    }
    raf = requestAnimationFrame(tick);
  };

  qs("[data-action='start-scan']")?.addEventListener("click", async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      scanner.hidden = false;
      // Prefer the platform detector where it exists; fall back to ours.
      if ("BarcodeDetector" in window) {
        try {
          detector = new BarcodeDetector({ formats: ["qr_code"] });
        } catch {
          detector = null;
        }
      }
      raf = requestAnimationFrame(tick);
    } catch (error) {
      const denied = error?.name === "NotAllowedError";
      toast(
        denied
          ? "The camera is blocked. Allow it, or upload a picture of the code instead."
          : "No camera here — upload a picture of the code instead.",
        "warn"
      );
    }
  });

  qs("[data-action='stop-scan']")?.addEventListener("click", stop);
  addEventListener("pagehide", stop);
}

/* --- uploading a picture of a code ---------------------------------------- */

function wireUpload(sync) {
  const input = qs("[data-code-file]");
  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const image = await fileToImageData(file);
      let text = null;

      if ("BarcodeDetector" in window) {
        try {
          const bitmap = await createImageBitmap(file);
          const found = await new BarcodeDetector({ formats: ["qr_code"] }).detect(bitmap);
          if (found.length) text = found[0].rawValue;
        } catch {
          /* fall through to our decoder */
        }
      }
      if (!text) {
        const dec = await loadDecoder();
        text = dec?.decodeQRFromImageData?.(image) ?? null;
      }

      if (text) await consumeScannedCode(sync, text);
      else toast("Couldn't read a code in that picture — try a clearer, closer photo.", "warn");
    } catch {
      toast("Couldn't open that image.", "err");
    } finally {
      input.value = "";
    }
  });
}

async function fileToImageData(file) {
  const bitmap = await createImageBitmap(file);
  // Cap the working size so a 12-megapixel phone photo does not stall the page;
  // a QR only needs a few hundred pixels across to decode.
  const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * A scanned code is either an invite (we answer it) or a reply to an invite we
 * showed (we complete it). We try to tell which from its role and act.
 */
async function consumeScannedCode(sync, text) {
  // A seat code from the Chair ("here is your seat") is not a pairing ticket —
  // it says who this device is. Handle it first, since it is the flow most
  // cousins will use: scan the code the Chair gave you and you are seated.
  // A camera hands us whatever the QR literally said, which is now a URL. Unwrap
  // a pairing link back to its ticket before anything tries to decode it.
  const fromLink = pairCodeFromLocation({ hash: String(text).slice(String(text).indexOf("#")) });
  if (fromLink) text = fromLink;

  const { readSeatCode } = await import("./seatcode.js");
  const seat = readSeatCode(text);
  if (seat) {
    const { redeemSeatCode } = await import("./auth.js");
    await redeemSeatCode(seat, sync);
    return;
  }

  try {
    const { code, compact } = await sync.acceptInvite(text);
    const box = qs("[data-answer-out]");
    if (box) {
      box.value = code;
      qs("[data-answer-out-wrap]")?.removeAttribute("hidden");
    }
    // Also render the reply as a QR so the other phone can scan it straight back.
    // Deliberately the bare ticket, not a pair link: the inviter reads this with
    // the in-page scanner while their offer is still pending in memory. A link
    // would navigate their page, and the reload would throw that pending offer
    // away — leaving them with a reply for a connection that no longer exists.
    const frame = qs("[data-reply-frame]");
    if (frame) {
      paintQr(frame, compact);
      ensureScannable(frame);
    }
    qs("[data-pair-flow]")?.__showPane?.("reply");
    toast("Scanned! Show your reply code back to your cousin.");
  } catch (error) {
    // Not an invite — maybe it is the reply to our own invite.
    try {
      await sync.completeInvite(text);
      toast("Paired! 🎉");
    } catch {
      toast(String(error.message || error), "err");
    }
  }
}

/* --- the live peer list --------------------------------------------------- */

function wirePeers(sync) {
  const list = qs("[data-peer-list]");
  if (!list) return;

  const paint = () => {
    const peers = sync.status.peers || [];
    if (!peers.length) {
      list.innerHTML = `<p class="empty">No devices connected yet. Show your code, or scan a cousin's.</p>`;
      return;
    }
    list.innerHTML = peers
      .map((p) => {
        const safety = p.safety ? `<span class="peer-row__safety" title="Safety word">${escapeText(p.safety)}</span>` : "";
        const state = p.state === "secure" ? "connected" : "connecting";
        return `<div class="peer-row" data-state="${state === "connected" ? "open" : "connecting"}">
            <span class="peer-row__dot"></span>
            <span>${escapeText(p.id.slice(0, 12))}… · <strong>${state}</strong></span>
            ${safety}
          </div>`;
      })
      .join("");
  };

  sync.addEventListener("status", paint);
  paint();
}

// Small local escaper — the peer id and safety word are ours, but belt and braces.
const escapeText = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* --------------------------------------------------------------------------
   Walkie-talkie — push and hold to talk to everyone connected
   -------------------------------------------------------------------------- */

export function mountWalkie(walkie) {
  const button = qs("[data-ptt]");
  const status = qs("[data-walkie-status]");
  if (!button || !walkie) return;

  if (!walkie.supported) {
    button.disabled = true;
    if (status) status.textContent = "This browser can't do walkie-talkie.";
    return;
  }

  // Press-and-hold on pointer, and space/enter for keyboard users.
  const start = (event) => {
    event.preventDefault();
    button.dataset.transmitting = "true";
    walkie.startTransmit();
  };
  const stop = () => {
    button.dataset.transmitting = "false";
    walkie.stopTransmit();
  };

  button.addEventListener("pointerdown", start);
  addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && button.dataset.transmitting !== "true") start(e);
  });
  button.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") stop();
  });

  walkie.addEventListener("state", () => {
    const s = walkie.state;
    if (!status) return;
    if (s.transmitting) status.innerHTML = `<span class="walkie__speaking">You're talking…</span>`;
    else if (s.receiving) status.innerHTML = `<span class="walkie__speaking">${escapeText(s.speaker || "A cousin")} is talking…</span>`;
    else status.textContent = s.queued ? `${s.queued} clip${s.queued === 1 ? "" : "s"} waiting…` : "Hold the button to talk.";
  });

  walkie.addEventListener("error", (e) => toast(e.detail.message, "warn"));
  walkie.addEventListener("blocked", () => toast("Tap once anywhere to let the chamber play audio.", "warn"));
}

/* --------------------------------------------------------------------------
   Event log & wire-format viewer — the "for the curious" drawer
   -------------------------------------------------------------------------- */

export function mountEventLog(store, sync) {
  const log = qs("[data-eventlog]");
  if (!log) return;

  const MAX = 200;
  const lines = [];
  const stamp = () => new Date().toLocaleTimeString(undefined, { hour12: false });

  const add = (kind, cls, detail) => {
    lines.push({ t: stamp(), kind, cls, detail });
    if (lines.length > MAX) lines.shift();
    log.innerHTML = lines
      .slice()
      .reverse()
      .map(
        (l) =>
          `<div class="eventlog__line"><span class="eventlog__time">${l.t}</span>` +
          `<span class="eventlog__kind eventlog__kind--${l.cls}">${escapeText(l.kind)}</span>` +
          `<span>${escapeText(l.detail)}</span></div>`
      )
      .join("");
  };

  store.addEventListener("change", (e) => {
    const d = e.detail || {};
    if (d.reason === "local") add("dispatch", "out", (d.ops || []).map((o) => o.type).join(", "));
    else if (d.reason === "remote") add("received", "in", `${(d.ops || []).length} op(s) via ${d.source}`);
  });

  sync.addEventListener("sent", (e) => add("delta→", "out", `${e.detail.count} op(s) via ${e.detail.via}`));
  sync.addEventListener("received", (e) => add("←delta", "in", `${e.detail.count} op(s) via ${e.detail.via}`));
  sync.addEventListener("status", () => {
    const secure = (sync.status.peers || []).filter((p) => p.state === "secure").length;
    add("mesh", "info", `${secure} secure peer(s)`);
  });

  // The wire-format viewer: show the shape of a sealed envelope, honestly.
  const wire = qs("[data-wire-format]");
  if (wire) {
    wire.textContent = JSON.stringify(
      {
        note: "What one sealed message looks like on the wire. The relay sees only this.",
        h: { e: 0, c: 3, a: "<sender>", s: "CC-P384-AES256GCM-XCHACHA20-HKDFSHA384-v2" },
        n: "<24-byte XChaCha nonce, base64url>",
        c: "<AES-256-GCM ⊂ XChaCha20-Poly1305 ciphertext, base64url>",
      },
      null,
      2
    );
  }

  add("ready", "info", "event log started");
}

export default mountConnect;
