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
import { initClock, initFilters, initReveal, initTheme, qs, qsa, esc, h, raw } from "./ui.js";
import { select } from "./crdt.js";

document.documentElement.classList.add("js");

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
  for (const node of qsa("[data-render='openVotes']")) {
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
  watchReveal = initReveal();

  const sync = new SyncCoordinator(store);
  initActions(store, sync);

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

  // Deep links into a single bill re-render just that region.
  addEventListener("hashchange", () => schedulePaint(sync));

  // Expose the store for the console — genuinely useful for a chamber that
  // runs on its own log, and harmless since everything here is local anyway.
  window.CousinCongress = { store, sync, select, config: CONFIG };
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
