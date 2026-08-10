/**
 * app.js — boot.
 *
 * Order matters here. The static page is already complete when this runs, so
 * everything below is enhancement: the chrome comes up first, the durable log
 * is opened and painted second, and replication is started last. If any stage
 * fails the page keeps whatever the previous stage gave it.
 */

import CONFIG from "./config.js";
import store from "./store.js";
import SyncCoordinator from "./sync.js";
import initCursor from "./cursor.js";
import initActions from "./actions.js";
import renderAll from "./views.js";
import { initClock, initFilters, initReveal, initTheme, qs, qsa, esc, h, raw, toast } from "./ui.js";
import { select } from "./crdt.js";
import { LOGO_MARK } from "./logo.js";
import { Notifier } from "./notify.js";
import { Watchdog } from "./watchdog.js";
import { addressAllowed } from "./netrules.js";

document.documentElement.classList.add("js");

/* Drop the playful primary-shape mark into every masthead slot. */
for (const slot of qsa("[data-logo]")) slot.innerHTML = LOGO_MARK;

/* --------------------------------------------------------------------------
   Chrome that does not depend on data
   -------------------------------------------------------------------------- */

initTheme();
initClock();
if (CONFIG.features.customCursor) initCursor();

/* --------------------------------------------------------------------------
   Identity chrome
   -------------------------------------------------------------------------- */

function paintIdentity() {
  const me = store.me;
  for (const node of qsa("[data-me='name']")) {
    node.textContent = me?.name || store.identity.displayName || "Unclaimed seat";
  }
  for (const node of qsa("[data-me='seat']")) {
    node.hidden = Boolean(me);
  }
  for (const node of qsa("[data-me='seated']")) {
    node.hidden = !me;
  }
  for (const node of qsa("[data-render='openVotes'], [data-render='directory']")) {
    node.dataset.member = store.identity.memberId || "";
  }
  const select = qs("[data-me='member-select']");
  if (select && !select.dataset.filled) {
    select.innerHTML =
      `<option value="">Choose a seat…</option>` +
      store.select
        .members()
        .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`)
        .join("");
    select.dataset.filled = "true";
    select.value = store.identity.memberId || "";
  }
}

/* --------------------------------------------------------------------------
   Replication console
   -------------------------------------------------------------------------- */

function paintSyncStatus(sync) {
  const status = sync.status;

  for (const node of qsa("[data-conn]")) {
    const relay = status.transports.find((t) => t.name === "server");
    const peers = status.transports.find((t) => t.name === "peers");
    const live = relay?.state === "connected" || (peers?.peers ?? 0) > 0;
    node.dataset.conn = live ? "live" : status.storageHealthy ? "static" : "error";
    const label = qs("[data-conn-label]", node) || node;
    label.textContent = live
      ? "Replicating"
      : status.online
        ? "Local only"
        : "Offline — still recording";
  }

  const panel = qs("[data-render='syncStatus']");
  if (!panel) return;

  panel.innerHTML = h`
    <div class="kpi-rail">
      <div class="kpi"><span class="kpi__value">${status.ops}</span><span class="kpi__label">Operations held</span></div>
      <div class="kpi"><span class="kpi__value">${status.replicas}</span><span class="kpi__label">Replicas seen</span></div>
      <div class="kpi"><span class="kpi__value">${status.peers.filter((p) => p.state === "open").length}</span><span class="kpi__label">Peers connected</span></div>
      <div class="kpi"><span class="kpi__value">${status.storageHealthy ? "OK" : "!"}</span><span class="kpi__label">Local durability</span></div>
    </div>

    <div class="rows" style="margin-top:var(--sp-4)">
      ${raw(
        status.transports
          .map(
            (t) => h`<div class="row">
              <span class="row__when">${t.name}</span>
              <div class="row__what">
                <span class="row__title">${t.label}</span>
                <span class="row__note">${t.state}${t.queued ? raw(h` · ${t.queued} queued`) : raw("")}</span>
              </div>
              <span class="badge badge--${raw(t.state === "connected" ? "yea" : t.state === "unsupported" || t.state === "offline" ? "absent" : "present")}">${t.state}</span>
            </div>`
          )
          .join("")
      )}
    </div>

    <h3 style="margin-top:var(--sp-5);font-size:var(--fs-md);font-family:var(--font-body)">Version vector</h3>
    <p class="field__hint">Each replica and the highest operation this device holds from it. Two devices showing the same vector are exactly in step.</p>
    <div class="table-wrap" style="margin-top:var(--sp-3)">
      <table class="table" style="min-width:0">
        <thead><tr><th>Replica</th><th>Ops held</th><th></th></tr></thead>
        <tbody>
          ${raw(
            Object.entries(status.vv)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(
                ([actor, seq]) => h`<tr>
                  <td class="u-mono">${actor}${actor === status.actor ? " (this device)" : ""}</td>
                  <td class="is-num">${seq + 1}</td>
                  <td>${actor === "genesis" ? "shipped snapshot" : ""}</td>
                </tr>`
              )
              .join("")
          )}
        </tbody>
      </table>
    </div>`;
}

/* --------------------------------------------------------------------------
   Paint loop
   -------------------------------------------------------------------------- */

let frame = 0;
let watchReveal = null;

function schedulePaint(sync) {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    // Identity first: renderers read the claimed seat off their region's
    // dataset, so it must be stamped before the regions repaint.
    paintIdentity();
    renderAll(store.state);
    paintSyncStatus(sync);
    initFilters();
    watchReveal?.();
  });
}

/* --------------------------------------------------------------------------
   Start
   -------------------------------------------------------------------------- */

async function boot() {
  // The interface icon sprite goes in first, before anything renders markup
  // that references it. (Cousins keep their emoji; the chrome uses these.)
  try {
    const { installSprite } = await import("./icons-ui.js");
    installSprite();
  } catch {
    /* icons are decoration — never let them stop the chamber booting */
  }

  // The build label in the footer, so "which version are you on?" is always
  // answerable without opening a file.
  try {
    const { mountVersion, VERSION } = await import("./version.js");
    mountVersion();
    window.CousinCongress = { ...(window.CousinCongress || {}), version: VERSION };
  } catch {
    /* a missing label never blocks the chamber */
  }

  watchReveal = initReveal();

  const sync = new SyncCoordinator(store);
  // One shared context for every subsystem. The chair's state tools write a
  // measurement onto it and repaint through it, so actions and the dashboard
  // must be looking at the same object.
  const appCtx = {};
  initActions(store, sync, appCtx);

  // Seat picker is plain markup, so it is wired here rather than in actions.
  document.addEventListener("change", (event) => {
    if (event.target?.dataset?.me !== "member-select") return;
    const memberId = event.target.value || null;
    store.setIdentity({
      memberId,
      displayName: memberId ? select.member(store.state, memberId)?.name || "" : "",
    });
  });

  store.addEventListener("change", () => schedulePaint(sync));
  store.addEventListener("identity", () => schedulePaint(sync));
  store.addEventListener("storage", (event) => {
    if (!event.detail.healthy) {
      import("./ui.js").then(({ toast }) =>
        toast("This browser refused to save locally. Export your log to avoid losing work.", "err")
      );
    }
  });

  sync.addEventListener("status", () => paintSyncStatus(sync));
  sync.addEventListener("received", () => schedulePaint(sync));

  await store.init();
  schedulePaint(sync);

  sync.start();

  // Expose the store for the console before wiring the extras, so the extras
  // can extend the global rather than race the base assignment.
  window.CousinCongress = { store, sync, select, config: CONFIG };

  await wireExtras(sync, appCtx);

  // Deep links into a single bill re-render just that region.
  addEventListener("hashchange", () => schedulePaint(sync));
}

/* --------------------------------------------------------------------------
   Everything the newer subsystems need wired: connection chrome, gating,
   notifications, the login watchdog, moderation alerts, and page controllers.
   Kept in one place so boot() stays legible.
   -------------------------------------------------------------------------- */

/**
 * @param {object} appCtx The one shared context, also handed to initActions —
 *   the chair's state tools write a measurement onto it and repaint through it,
 *   so both halves must be looking at the same object.
 */
async function wireExtras(sync, appCtx = {}) {
  /* Connect-first gating: the primary calls to action change once at least one
     other device is on the mesh, so a newcomer is pointed at pairing before
     they can act on demo data they think is real. */
  const paintGate = () => {
    const connected = (sync.status.peers || []).some((p) => p.state === "secure" || p.state === "open");
    for (const el of qsa("[data-when='connected']")) el.hidden = !connected;
    for (const el of qsa("[data-when='disconnected']")) el.hidden = connected;
  };
  sync.addEventListener("status", paintGate);
  paintGate();

  /* Access gating: a feature a member can't use renders as a greyed "ask the
     Chair" card instead of dead controls. Two body classes drive the CSS —
     is-seated (a seat is claimed) and is-chair (the gavel is unlocked here). */
  const paintAccess = () => {
    document.body.classList.toggle("is-seated", Boolean(store.identity.memberId));
    document.body.classList.toggle("is-chair", isChairHere());
  };
  store.addEventListener("change", paintAccess);
  store.addEventListener("identity", paintAccess);
  // The gavel unlock lives in sessionStorage; re-check shortly after any click.
  document.addEventListener("click", () => setTimeout(paintAccess, 60), true);
  paintAccess();

  /* The three-emoji congress seal, derived from the room secret so everyone in
     the same congress sees the same three and an outsider's differs at a glance. */
  const CONGRESS_EMOJI = [
    "🦊", "🐻", "🐼", "🦁", "🐯", "🐨", "🐸", "🐵", "🦉", "🦄",
    "🐢", "🐙", "🦋", "🐝", "🐬", "🦕", "🌵", "🌻", "🍁", "🍄",
    "⭐", "🌈", "🔥", "❄️", "⚡", "🌊", "🌙", "☀️", "🍎", "🍋",
    "🍉", "🍇", "🍕", "🍔", "🍩", "🍪", "🧁", "🎈", "🎸", "🚀",
    "⚽", "🏀", "🎲", "🧩", "🎁", "🔔", "🗝️", "🧭", "⛵", "🏰",
  ];
  const paintCongress = async () => {
    try {
      const secret = sync.roomSecret;
      if (!secret) return;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", secret));
      const seal = [0, 1, 2].map((i) => CONGRESS_EMOJI[digest[i] % CONGRESS_EMOJI.length]).join(" ");
      for (const el of qsa("[data-congress-code]")) el.textContent = seal;
    } catch {
      /* no WebCrypto — leave the placeholder dots */
    }
  };
  paintCongress();
  sync.addEventListener("status", paintCongress);

  /* A seat code the Chair handed out: the cousin scanned it with their phone's
     ordinary camera, the deep link opened the site, and the payload is sitting
     in the fragment. Take the seat, then scrub it from the address bar so a
     screenshot of the page cannot pass the credential on. */
  try {
    const seatcode = await import("./seatcode.js");
    const seat = seatcode.seatCodeFromLocation();
    if (seat) {
      seatcode.clearSeatCodeFromLocation();
      const { redeemSeatCode } = await import("./auth.js");
      await redeemSeatCode(seat, sync);
    }
  } catch (error) {
    console.warn("[cousin-congress] seat code", error);
  }

  /* The always-present connection banner + the connect-page controllers. */
  const connect = await import("./connect.js");
  connect.mountLinkBanner(sync);
  connect.mountConnect(sync);
  connect.mountPairFlow(sync);

  /* The Floor console measures its own headroom (see fitFloorConsole). */
  fitFloorConsole();
  connect.mountWalkie(sync.walkie);
  connect.mountEventLog(store, sync);

  /* The chamber chat (present only on pages that include its hooks). */
  const chair = await import("./chair.js");
  chair.mountChat(store);

  /* Notifications: a per-device unread list and an optional browser nudge. */
  const notifier = new Notifier(store);
  let firstNotifyBuild = true;
  const refreshNotifs = () => {
    notifier.rebuild();
    notifier.nudgeNew(firstNotifyBuild);
    firstNotifyBuild = false;
    for (const bell of qsa("[data-notif-count]")) {
      const n = notifier.unread;
      bell.textContent = n > 99 ? "99+" : String(n);
      bell.hidden = n === 0;
    }
    const panel = qs("[data-render='notifications']");
    if (panel) paintNotifications(panel, notifier);
  };
  store.addEventListener("change", refreshNotifs);
  refreshNotifs();
  qs("[data-action='notif-read-all']")?.addEventListener("click", () => {
    notifier.markAllRead();
    refreshNotifs();
  });
  qs("[data-action='notif-enable']")?.addEventListener("click", async () => {
    const perm = await notifier.requestWebPermission();
    toast(perm === "granted" ? "Notifications on." : "Notifications stay off — that's fine.");
  });

  /* The login watchdog: classify each connection, flag the odd ones, and apply
     the Chair's address rules by dropping a peer whose IP is blocked. */
  const watchdog = new Watchdog();
  watchdog.seed({
    fingerprints: sync.directory.list().map((k) => k.fingerprint),
  });
  sync.peers?.security && (sync.peers.security.onAddress = (actor, ip) => {
    const rules = store.state.session?.ipRules || [];
    const member = memberForActor(actor);
    return addressAllowed(rules, ip, member?.id || null);
  });
  sync.peers?.addEventListener("address", (e) => {
    const { actor, ip } = e.detail;
    const member = memberForActor(actor);
    watchdog.observe({ actor, ip, fingerprint: fpForActor(sync, actor), memberId: member?.id, guest: Boolean(sync.peers.peerScope(actor)) }, Date.now());
  });
  watchdog.addEventListener("flag", (e) => {
    // The Chair is alerted; everyone else is reassured this is being watched.
    if (isChairHere()) toast(`🔎 Unusual login: ${e.detail.reasons[0] || "looks off"} — check the Chair dashboard.`, "warn");
    schedulePaint(sync);
  });
  window.CousinCongress = { ...window.CousinCongress, notifier, watchdog };
  // Actions need the watchdog + a per-item resolver for share links.
  sync.__watchdog = watchdog;

  /* Security alerts: a detected forgery/tamper is the loud one. Warn THIS user
     plainly and tell them to contact the Chair; log it for the dashboard. */
  const securityLog = [];
  store.addEventListener("forgery", (e) => {
    securityLog.unshift({ ...e.detail, at: Date.now() });
    showSecurityBanner();
    schedulePaint(sync);
  });
  window.CousinCongress.securityLog = securityLog;

  /* Now that the watchdog and security log exist, mount the Chair dashboard. */
  chair.mountChairDashboard(store, sync, Object.assign(appCtx, { watchdog, securityLog }));

  /* Frozen overlay: if the Chair has frozen this seat, lock the screen. */
  const paintFrozen = () => {
    const me = store.me;
    let overlay = qs("#cc-frozen");
    if (me?.frozen) {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "cc-frozen";
        overlay.className = "frozen-overlay";
        overlay.innerHTML =
          `<div class="frozen-overlay__card"><div class="frozen-overlay__icon">❄️</div>` +
          `<h2>You've been paused by the Chair</h2>` +
          `<p>Your seat is frozen, so actions are locked for now. Please contact the Chair to be let back in.</p></div>`;
        document.body.append(overlay);
      }
    } else {
      overlay?.remove();
    }
  };
  store.addEventListener("change", paintFrozen);
  store.addEventListener("frozen", () => toast("You're frozen — contact the Chair.", "err"));
  paintFrozen();

  /* If we joined as a scoped guest and get revoked, wipe the screen. */
  sync.addEventListener("revoked", () => {
    for (const region of qsa("[data-render]")) region.innerHTML =
      `<div class="empty">🔒 Access to this item was ended by the Chair.</div>`;
    toast("Your access was revoked.", "warn");
  });
}

/* --- small helpers the wiring needs --------------------------------------- */

function memberForActor(actor) {
  // A device announces its member when it claims a seat; until then, unknown.
  // The base id (before the tab suffix) is the stable actor for a device.
  const base = String(actor).split(".")[0];
  return select.members(store.state).find((m) => m.deviceActor === base || m.id === actor) || null;
}

function fpForActor(sync, actor) {
  return sync.directory.get(actor)?.fingerprint || null;
}

function isChairHere() {
  try {
    return sessionStorage.getItem("cc.chair") === (store.state.session?.chairAuth?.hash || " ");
  } catch {
    return false;
  }
}

let securityBannerShown = false;
function showSecurityBanner() {
  if (securityBannerShown) return;
  securityBannerShown = true;
  const bar = document.createElement("div");
  bar.className = "security-banner";
  bar.setAttribute("role", "alert");
  bar.innerHTML =
    `<span>⚠️ Something unexpected is happening on the network — a message failed its security check. ` +
    `This can be harmless, but if it keeps happening, please contact your Chair.</span>` +
    `<button aria-label="Dismiss">×</button>`;
  bar.querySelector("button").addEventListener("click", () => {
    bar.remove();
    securityBannerShown = false;
  });
  document.body.prepend(bar);
  setTimeout(() => {
    bar.remove();
    securityBannerShown = false;
  }, 15000);
}

function paintNotifications(panel, notifier) {
  const items = notifier.items;
  if (!items.length) {
    panel.innerHTML = `<p class="empty">Nothing new yet. When votes open or bills move, you'll see it here.</p>`;
    return;
  }
  panel.innerHTML = items
    .map(
      (n) =>
        `<a class="notif ${notifier.readIds.has(n.id) ? "" : "notif--unread"}" href="${esc(n.href || "#")}">` +
        `<span class="notif__icon">${esc(n.icon || "•")}</span>` +
        `<span class="notif__body"><strong>${esc(n.title)}</strong><span>${esc(n.body || "")}</span></span></a>`
    )
    .join("");
}

boot().catch((error) => {
  console.error("[cousin-congress] boot failed", error);
  // The static page stands on its own; say so rather than failing silently.
  const banner = qs("[data-boot-error]");
  if (banner) {
    banner.hidden = false;
    banner.textContent =
      "Live features could not start in this browser. Everything on this page is still readable.";
  }
});

/**
 * Size the Floor console to the space that is genuinely left over.
 *
 * The console wants to fill the screen exactly once — no page scroll, no
 * clipped pane. That means subtracting everything above it (masthead, ticker,
 * connection banner, page header) and below it (footer margin), and none of
 * that is a CSS variable: half is injected by the shell and all of it changes
 * with viewport width as things wrap.
 *
 * It was a hard-coded 23rem, measured once on one screen. That is right on that
 * screen and wrong everywhere else — on a short laptop the clamp's own minimum
 * exceeded the space available, so the console overflowed the fold it exists to
 * fit inside. Measuring the real offset costs one layout read per resize and is
 * correct on every screen, including ones that did not exist when it was tuned.
 */
function fitFloorConsole() {
  const app = document.querySelector(".floor-app");
  if (!app) return;

  const apply = () => {
    // Read the distance from the viewport top to the console in its natural
    // position. Clearing the override first stops each pass from measuring the
    // previous pass's answer and drifting.
    app.style.removeProperty("--floor-chrome");
    const top = app.getBoundingClientRect().top + window.scrollY;
    const breathingRoom = 24; // a little air under the console
    app.style.setProperty("--floor-chrome", `${Math.max(0, Math.round(top + breathingRoom))}px`);

    // Correct once against reality. The offset above accounts for what is
    // ABOVE the console, but padding and margins below it are the page's
    // business and not worth enumerating in JS. Measuring the leftover
    // overflow and folding it back in gets there in one extra pass, and is
    // right regardless of what the stylesheet does underneath.
    const spill = Math.round(app.getBoundingClientRect().bottom - document.documentElement.clientHeight);
    if (spill > 1) {
      const chrome = parseFloat(app.style.getPropertyValue("--floor-chrome")) || 0;
      app.style.setProperty("--floor-chrome", `${Math.round(chrome + spill)}px`);
    }
  };

  apply();

  // Re-measure when the chrome above can have changed height: a resize, an
  // orientation flip, or the connection banner appearing when a peer arrives.
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
  const banner = document.querySelector("[data-link-banner]");
  if (banner && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(schedule).observe(banner);
  }
}
