/**
 * netmap.js — the Chair's traffic-flow and location map.
 *
 * Two views over the same live data, drawn as inline SVG with no library and
 * no tiles fetched from anywhere:
 *
 *   - A NETWORK graph: every connected device is a node, every live channel an
 *     edge, and the edge's weight is how much data has actually crossed it.
 *     Members and guests are drawn differently. This is always available and
 *     entirely local — it is just what the mesh already knows about itself.
 *
 *   - A WORLD map: the same devices pinned to an approximate location inferred
 *     from their public IP (Chair-side only; member devices never geolocate).
 *     The base map is a low-detail world outline embedded in the code, and the
 *     places come from the offline table in geoip.js, so the whole thing works
 *     on a plane.
 *
 * The map is a moderation aid, not surveillance: it shows the Chair "these two
 * cousins are on the same home network, this guest is somewhere in Europe",
 * which is exactly enough to notice something out of place.
 */

import { locate, project } from "./geoip.js";

/** A deliberately low-detail world outline (equirectangular), as SVG paths in a
 *  360x180 lon/lat box. Enough to orient a pin, small enough to inline. */
const WORLD_OUTLINE =
  "M0 0h360v180H0z"; // ocean rect; continents drawn as blobs below for legibility

/** Coarse continent blobs (equirectangular, 360x180). Illustrative, not survey. */
const CONTINENTS = [
  // North America
  "M40 30 Q70 20 95 40 Q110 60 90 90 Q70 110 55 95 Q35 70 40 30Z",
  // South America
  "M95 100 Q110 100 108 130 Q100 165 85 160 Q78 130 95 100Z",
  // Europe
  "M165 35 Q185 28 195 45 Q188 60 172 58 Q160 50 165 35Z",
  // Africa
  "M170 70 Q195 65 200 95 Q190 135 172 130 Q160 100 170 70Z",
  // Asia
  "M200 30 Q260 22 300 50 Q280 85 240 80 Q205 70 200 30Z",
  // Australia
  "M290 120 Q320 115 325 135 Q305 150 288 140 Q285 128 290 120Z",
];

const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/* --------------------------------------------------------------------------
   Network graph
   -------------------------------------------------------------------------- */

/**
 * Lay out a hub-and-spoke graph: this device in the centre, peers on a ring,
 * spoke thickness scaled by total bytes. A ring keeps it readable for a family
 * without needing a force simulation.
 */
export function networkSvg(traffic, { self = "This device", size = 320 } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.36;
  const peers = traffic.slice(0, 24);
  const maxBytes = Math.max(1, ...peers.map((p) => p.bytesIn + p.bytesOut));

  let edges = "";
  let nodes = "";
  peers.forEach((p, i) => {
    const angle = (i / Math.max(peers.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    const weight = 1 + ((p.bytesIn + p.bytesOut) / maxBytes) * 6;
    const colour = p.isolated ? "var(--absent)" : p.guest ? "var(--c-yellow-500)" : "var(--c-green-500)";
    const dash = p.state === "secure" ? "" : ` stroke-dasharray="4 4"`;
    edges += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${colour}" stroke-width="${weight.toFixed(1)}" stroke-linecap="round" opacity="0.7"${dash}><title>${esc(p.id)} · ${fmtBytes(p.bytesIn + p.bytesOut)}</title></line>`;
    nodes += `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
        <circle r="11" fill="${colour}" stroke="var(--bg-raised)" stroke-width="2"></circle>
        <title>${esc(p.id)} — ${p.guest ? "guest" : "member"}${p.isolated ? " (isolated)" : ""}\n${fmtBytes(p.bytesOut)} sent · ${fmtBytes(p.bytesIn)} received</title>
      </g>`;
  });

  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Network connections" style="width:100%;height:auto">
      ${edges}
      <g transform="translate(${cx},${cy})">
        <circle r="16" fill="var(--c-blue-600)" stroke="var(--bg-raised)" stroke-width="3"></circle>
        <text y="34" text-anchor="middle" font-size="11" fill="var(--text-muted)">${esc(self)}</text>
        <title>${esc(self)}</title>
      </g>
      ${nodes || `<text x="${cx}" y="${cy + 60}" text-anchor="middle" font-size="12" fill="var(--text-faint)">No one else connected yet</text>`}
    </svg>`;
}

/* --------------------------------------------------------------------------
   World map
   -------------------------------------------------------------------------- */

export function worldSvg(traffic, { rules = [], width = 480 } = {}) {
  const height = width / 2;

  // Group peers by inferred place so overlapping pins cluster into one.
  const byPlace = new Map();
  for (const p of traffic) {
    const loc = locate(p.ip, rules);
    const key = loc.local ? "LOCAL" : loc.unknown ? "UNKNOWN" : `${loc.lat},${loc.lon}`;
    const entry = byPlace.get(key) || { loc, peers: [] };
    entry.peers.push(p);
    byPlace.set(key, entry);
  }

  let pins = "";
  let localNote = "";
  for (const { loc, peers } of byPlace.values()) {
    if (loc.local) {
      localNote = `<div class="netmap__local">🏠 ${peers.length} device${peers.length === 1 ? "" : "s"} on the local network</div>`;
      continue;
    }
    if (loc.unknown) continue;
    const { x, y } = project(loc.lat, loc.lon);
    const px = (x * width).toFixed(1);
    const py = (y * height).toFixed(1);
    const guest = peers.some((p) => p.guest);
    pins += `<g transform="translate(${px},${py})">
        <circle r="${4 + Math.min(peers.length, 6)}" fill="${guest ? "var(--c-yellow-500)" : "var(--c-red-500)"}" opacity="0.85"></circle>
        <circle r="3" fill="#fff"></circle>
        <title>${esc(loc.name)} — ${peers.length} device${peers.length === 1 ? "" : "s"}${guest ? " (incl. guest)" : ""}</title>
      </g>`;
  }

  const continents = CONTINENTS.map(
    (d) => `<path d="${scalePath(d, width / 360, height / 180)}" fill="var(--line-strong)" opacity="0.35"></path>`
  ).join("");

  return {
    svg: `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Where devices are connecting from" style="width:100%;height:auto;background:var(--bg-sunken);border-radius:var(--r-md)">
        <rect width="${width}" height="${height}" fill="var(--bg-sunken)"></rect>
        ${continents}
        ${pins || `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="12" fill="var(--text-faint)">No placeable devices</text>`}
      </svg>`,
    localNote,
  };
}

/* --------------------------------------------------------------------------
   helpers
   -------------------------------------------------------------------------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Scale the numbers inside an SVG path's coordinate list. */
function scalePath(d, sx, sy) {
  let flip = true;
  return d.replace(/-?\d+(\.\d+)?/g, (n) => {
    const v = Number(n) * (flip ? sx : sy);
    flip = !flip;
    return v.toFixed(1);
  });
}

export { fmtBytes };
export default { networkSvg, worldSvg };
