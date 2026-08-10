/**
 * chair.js — the unified Chair dashboard and the chamber chat.
 *
 * These two surfaces need live data the CRDT state does not hold on its own —
 * the list of open connections, their byte counters, the watchdog's flags — so
 * they are painted here from the coordinator rather than through the static
 * view registry. Everything a member can see is still plain replicated state;
 * this file only adds the Chair's live operational view on top.
 *
 * Nothing here bypasses the action layer: every toggle and button is a normal
 * `data-action`, so the same permission checks (and the same Chair password)
 * apply whether they are pressed here or anywhere else.
 */

import { esc } from "./ui.js";
import { networkSvg, worldSvg, fmtBytes } from "./netmap.js";

const on = (v) => (v ? "checked" : "");

/* --------------------------------------------------------------------------
   The dashboard
   -------------------------------------------------------------------------- */

export function mountChairDashboard(store, sync, ctx) {
  const root = document.querySelector("[data-chair-dashboard]");
  if (!root) return null;

  const paint = () => {
    const s = store.state;
    const session = s.session || {};
    const members = store.select.members();
    const traffic = sync.peers?.traffic || [];
    const flags = ctx.watchdog?.flags || [];
    const log = sync.peers?.connectionLog || [];
    const security = ctx.securityLog || [];

    root.innerHTML = `
      <div class="dash">
        ${policyPanel(session)}
        ${trafficPanel(sync, traffic)}
        ${membersPanel(members, session)}
        ${devicesPanel(store)}
        ${deviceRosterPanel(store)}
        ${connectionsPanel(traffic, sync)}
        ${securityPanel(flags, security)}
        ${historyPanel(log)}
        ${explorerPanel(s)}
      </div>`;
  };

  paint();
  store.addEventListener("change", paint);
  sync.addEventListener("status", paint);
  ctx.watchdog?.addEventListener("flag", paint);
  return paint;
}

function policyPanel(session) {
  const row = (label, hint, action, checked) => `
    <div class="toggle-row">
      <div><strong>${esc(label)}</strong><br><span class="u-muted" style="font-size:var(--fs-xs)">${esc(hint)}</span></div>
      <button class="switch" data-action="${action}" role="switch" aria-checked="${checked}">
        <input type="checkbox" ${on(checked)} tabindex="-1"><span class="switch__track"></span>
      </button>
    </div>`;
  return `<section class="dash__panel">
      <h3>🔨 Chamber controls</h3>
      ${row("Lock the chamber", "Stop new devices joining", "toggle-lock", session.locked)}
      ${row("Reach other networks (STUN)", "Off = same network only, no outside servers", "toggle-stun", session.stun !== false)}
      ${row("Open chat to everyone", "Off = you pick who can chat", "chat-policy", session.chatPolicy === "all")}
      ${row("Open talkie to everyone", "Off = you pick who can talk", "talkie-policy", (session.talkiePolicy || "all") === "all")}
    </section>`;
}

function trafficPanel(sync, traffic) {
  const rules = sync.store?.state?.session?.geoRules || [];
  const world = worldSvg(traffic, { rules });
  const totalOut = traffic.reduce((n, p) => n + p.bytesOut, 0);
  const totalIn = traffic.reduce((n, p) => n + p.bytesIn, 0);
  return `<section class="dash__panel" style="grid-column:1/-1">
      <h3>🗺️ Traffic &amp; location</h3>
      <div class="grid grid--2" style="align-items:start">
        <div>
          <p class="u-muted" style="font-size:var(--fs-xs)">Who is connected to whom, and how much is flowing. Thicker lines carry more data.</p>
          ${networkSvg(traffic, { self: "You" })}
          <p class="u-mono" style="font-size:var(--fs-2xs)">${fmtBytes(totalOut)} sent · ${fmtBytes(totalIn)} received this session</p>
        </div>
        <div>
          <p class="u-muted" style="font-size:var(--fs-xs)">Approximate location, inferred from public IP. Your device never shares its own location.</p>
          ${world.svg}
          ${world.localNote}
        </div>
      </div>
    </section>`;
}

function membersPanel(members, session) {
  if (!members.length) return `<section class="dash__panel"><h3>👥 Members</h3><p class="empty">None yet.</p></section>`;
  const rows = members
    .map((m) => {
      const devices = Object.keys(m.keys || {}).length;
      const dot = devices === 0 ? "unclaimed" : `${devices} device${devices === 1 ? "" : "s"}`;
      return `<div class="toggle-row">
        <div><strong>${esc(m.icon || "🪑")} ${esc(m.name)}</strong>
          ${m.frozen ? '<span class="conn-row__badge conn-row__badge--guest">frozen</span>' : ""}
          <br><span class="u-muted" style="font-size:var(--fs-2xs)">🔑 ${dot}</span>
        </div>
        <div class="cluster" style="gap:var(--sp-1)">
          <button class="btn btn--ghost btn--sm" data-action="toggle-talk" data-member="${esc(m.id)}" title="Walkie">📻 ${m.canTalk ? "on" : "off"}</button>
          <button class="btn btn--ghost btn--sm" data-action="toggle-chat" data-member="${esc(m.id)}" title="Chat">💬 ${m.canChat ? "on" : "off"}</button>
          <button class="btn btn--ghost btn--sm" data-action="seat-qr" data-member="${esc(m.id)}" title="Show a sign-in code they can scan">🎟️ Sign-in code</button>
          <button class="btn btn--ghost btn--sm" data-action="toggle-freeze" data-member="${esc(m.id)}">${m.frozen ? "Thaw" : "Freeze"}</button>
          ${devices ? `<button class="btn btn--ghost btn--sm" data-action="reset-seat" data-member="${esc(m.id)}" title="Unregister this seat's devices for recovery">Reset devices</button>` : ""}
        </div>
      </div>`;
    })
    .join("");
  return `<section class="dash__panel"><h3>👥 Members &amp; permissions</h3>${rows}</section>`;
}

/**
 * Device registration: who holds the gavel, and who is asking to. This is the
 * human side of the authorisation model — the Chair approves a new Chair device
 * here, and resets a seat's devices from the Members panel above.
 */
function devicesPanel(store) {
  const requests = store.select.chairRequests();
  const seatRequests = store.select.seatRequests();
  const chairs = store.select.chairDevices();
  const short = (kid) => `${String(kid || "").slice(0, 10)}…`;

  const requestRows = requests.length
    ? requests
        .map((r) => `
          <div class="toggle-row">
            <div><strong>🙋 A device wants the gavel</strong><br>
              <span class="u-mono u-muted" style="font-size:var(--fs-2xs)">${esc(short(r.kid))}${r.name ? ` · ${esc(r.name)}` : ""}</span></div>
            <button class="btn btn--sm" data-action="approve-chair" data-kid="${esc(r.kid)}" data-actor="${esc(r.actor || "")}">Approve</button>
          </div>`)
        .join("")
    : `<p class="u-muted" style="font-size:var(--fs-xs)">No devices are waiting for the gavel.</p>`;

  const seatRows = seatRequests.length
    ? seatRequests
        .map((r) => `
          <div class="toggle-row">
            <div><strong>🪑 A device wants ${esc(r.memberIcon || "")} ${esc(r.memberName || "a seat")}</strong><br>
              <span class="u-mono u-muted" style="font-size:var(--fs-2xs)">${esc(short(r.kid))}</span></div>
            <button class="btn btn--sm" data-action="approve-seat" data-member="${esc(r.memberId)}" data-kid="${esc(r.kid)}">Approve</button>
          </div>`)
        .join("")
    : "";

  const chairRows = chairs.length
    ? `<p class="u-muted" style="font-size:var(--fs-xs);margin-top:var(--sp-3)">Chair devices: ${chairs
        .map((c) => `<span class="u-mono">${esc(short(c.kid))}</span>`)
        .join(", ")}</p>`
    : `<p class="u-muted" style="font-size:var(--fs-xs);margin-top:var(--sp-3)">No Chair device is registered yet — the first to take the gavel becomes the root.</p>`;

  return `<section class="dash__panel">
      <h3>🔐 Devices &amp; approvals</h3>
      ${requestRows}
      ${seatRows ? `<hr style="border:none;border-top:1px solid var(--line);margin:var(--sp-3) 0">${seatRows}` : ""}
      ${chairRows}
    </section>`;
}

/**
 * Every device that has ever joined this chamber — not just what is connected
 * right now. This is the Chair's answer to "who is that?": a name, the network
 * it came from, when it first appeared and when it was last seen, and a way to
 * bar it. The ban lives in the replicated record, so every peer enforces it.
 */
function deviceRosterPanel(store) {
  const devices = Object.values(store.state.devices || {}).sort((a, b) =>
    String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""))
  );
  if (!devices.length) {
    return `<section class="dash__panel"><h3>Devices</h3><p class="empty">No devices have joined yet.</p></section>`;
  }
  const when = (hlc) => {
    const d = hlc ? new Date(Number(String(hlc).split(":")[0])) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : "—";
  };
  const rows = devices
    .slice(0, 30)
    .map((d) => {
      const member = d.memberId ? store.select.member(d.memberId) : null;
      const who = member ? `${member.icon || ""} ${member.name}` : d.label || "Unidentified device";
      return `<div class="conn-row${d.revoked ? " conn-row--revoked" : ""}">
        <span class="conn-row__badge conn-row__badge--${d.revoked ? "guest" : "member"}">${d.revoked ? "barred" : "device"}</span>
        <span><strong>${esc(who)}</strong><br>
          <span class="u-mono u-muted" style="font-size:var(--fs-2xs)">${esc(String(d.id).slice(0, 12))}…</span></span>
        <span class="conn-row__meta">${esc(d.ip || "network unknown")} · first ${esc(when(d.firstSeen))} · last ${esc(when(d.lastSeen))}</span>
        <span class="cluster" style="gap:var(--sp-1)">
          ${d.revoked
            ? `<button class="btn btn--ghost btn--sm" data-action="unrevoke-device" data-kid="${esc(d.id)}">Allow again</button>`
            : `<button class="btn btn--danger btn--sm" data-action="revoke-device" data-kid="${esc(d.id)}">Bar this device</button>`}
        </span>
      </div>`;
    })
    .join("");
  return `<section class="dash__panel" style="grid-column:1/-1">
      <h3>Devices that have joined</h3>
      <p class="u-muted" style="font-size:var(--fs-xs)">Barring a device disconnects it and blocks it everywhere, not just here.</p>
      <div class="stack">${rows}</div>
    </section>`;
}

function connectionsPanel(traffic, sync) {
  if (!traffic.length) return `<section class="dash__panel"><h3>🔌 Live connections</h3><p class="empty">Nobody connected right now.</p></section>`;
  const rows = traffic
    .map((p) => `
      <div class="conn-row">
        <span class="conn-row__badge conn-row__badge--${p.guest ? "guest" : "member"}">${p.guest ? "guest" : "member"}</span>
        <span><strong class="u-mono">${esc(p.id.slice(0, 14))}…</strong>${p.isolated ? " · 🔇 isolated" : ""}</span>
        <span class="cluster" style="gap:var(--sp-1)">
          <button class="btn btn--ghost btn--sm" data-action="isolate-peer" data-peer="${esc(p.id)}">${p.isolated ? "Release" : "Isolate"}</button>
          <button class="btn btn--danger btn--sm" data-action="disconnect-peer" data-peer="${esc(p.id)}">Disconnect</button>
        </span>
        <span class="conn-row__meta">${esc(p.ip || "IP unknown")} · ${fmtBytes(p.bytesIn + p.bytesOut)}</span>
      </div>`)
    .join("");
  return `<section class="dash__panel" style="grid-column:1/-1"><h3>🔌 Live connections</h3><div class="stack">${rows}</div></section>`;
}

function securityPanel(flags, security) {
  const flagRows = flags.length
    ? flags
        .slice(0, 8)
        .map((f) => `
          <div class="flag" data-flag>
            <strong>🔎 Unusual login (${Math.round(f.score * 100)}%)</strong>
            <span class="flag__reasons">${esc((f.reasons || []).join("; "))}</span>
            <span class="u-mono" style="font-size:var(--fs-2xs)">${esc(f.ip || "?")} · ${esc((f.fingerprint || "").slice(0, 8))}</span>
            <div class="cluster">
              <button class="btn btn--ghost btn--sm" data-action="watchdog-verdict" data-verdict="fine" data-fp="${esc(f.fingerprint || "")}" data-ip="${esc(f.ip || "")}">👍 Fine</button>
              <button class="btn btn--danger btn--sm" data-action="watchdog-verdict" data-verdict="bad" data-fp="${esc(f.fingerprint || "")}" data-ip="${esc(f.ip || "")}">🚨 Suspicious</button>
            </div>
          </div>`)
        .join("")
    : `<p class="u-muted" style="font-size:var(--fs-sm)">Nothing unusual. The watchdog is watching.</p>`;

  const tampers = security.length
    ? `<div class="notice notice--err" style="margin-top:var(--sp-3)"><div><strong>${security.length}</strong> message(s) failed a security check this session — a sign someone tried to tamper with the record. The devices that saw it were warned.</div></div>`
    : "";

  return `<section class="dash__panel"><h3>🛡️ Security</h3>${flagRows}${tampers}</section>`;
}

function historyPanel(log) {
  const rows = log
    .slice(-40)
    .reverse()
    .map((l) => {
      const t = new Date(l.at).toLocaleTimeString(undefined, { hour12: false });
      return `<div class="connlog__line">
        <span>${t}</span>
        <span class="connlog__ev connlog__ev--${esc(l.event)}">${esc(l.event)}</span>
        <span class="u-mono">${esc((l.actor || "?").slice(0, 12))}</span>
        <span>${esc(l.ip || (l.guest ? "guest" : ""))}</span>
      </div>`;
    })
    .join("");
  return `<section class="dash__panel" style="grid-column:1/-1">
      <h3>📜 Connection history</h3>
      <p class="u-muted" style="font-size:var(--fs-xs)">Every authentication, so you can spot a device you don't recognise.</p>
      <div class="connlog">${rows || '<p class="empty">No connections yet.</p>'}</div>
    </section>`;
}

/** Data explorer: what the shared record is made of, so the Chair can prune. */
function explorerPanel(state) {
  const tables = [
    ["members", "Members"], ["votes", "Votes"], ["ballots", "Ballots"], ["bills", "Bills"],
    ["news", "Newsroom"], ["docket", "Docket"], ["statuses", "Status updates"], ["chat", "Chat"],
    ["announcements", "Announcements"], ["comments", "Comments"], ["shares", "Shares"],
  ];
  const rows = tables
    .map(([key, label]) => {
      const all = Object.values(state[key] || {});
      const live = all.filter((r) => r && !r._deleted).length;
      return `<tr><td>${esc(label)}</td><td class="is-num">${live}</td><td class="is-num">${all.length}</td></tr>`;
    })
    .join("");
  return `<section class="dash__panel" style="grid-column:1/-1">
      <h3>🗂️ Data explorer</h3>
      <p class="u-muted" style="font-size:var(--fs-xs)">What is stored and replicated to every device. Clearing the demo data and retiring old items keeps the chamber light.</p>
      <table class="explorer-table">
        <thead><tr><th>Kind</th><th class="is-num">Live</th><th class="is-num">Total (incl. tombstones)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="cluster" style="margin-top:var(--sp-3)">
        <button class="btn btn--ghost btn--sm" data-action="clear-demo">🧹 Clear the example data</button>
        <button class="btn btn--ghost btn--sm" data-action="export-log">💾 Export the whole record</button>
      </div>
    </section>`;
}

/* --------------------------------------------------------------------------
   Chat
   -------------------------------------------------------------------------- */

export function mountChat(store) {
  const log = document.querySelector("[data-chat-log]");
  if (!log) return;

  const paint = () => {
    const messages = store.select.chat(80);
    log.innerHTML = messages.length
      ? messages
          .map(
            (m) => `<div class="chat__msg">
              <span class="chat__who">${esc(m.icon || "🪑")} ${esc(m.name || "A cousin")}</span>
              <span class="chat__text">${esc(m.text)}</span>
            </div>`
          )
          .join("")
      : `<p class="empty">No messages yet.</p>`;
    log.scrollTop = log.scrollHeight;
  };

  paint();
  store.addEventListener("change", paint);

  // Gate the composer on permission, and say why when it is closed.
  const gate = () => {
    const form = document.querySelector("[data-action='chat-send']");
    if (!form) return;
    const allowed = store.select.canChat(store.identity.memberId);
    form.querySelector("input,button")?.toggleAttribute("disabled", !allowed);
    const note = document.querySelector("[data-chat-note]");
    if (note) note.textContent = allowed ? "" : "The Chair hasn't switched chat on for your seat yet.";
  };
  gate();
  store.addEventListener("change", gate);
  store.addEventListener("identity", gate);
}

export default mountChairDashboard;
