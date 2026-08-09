/**
 * geoip.js — a tiny, offline, coarse IP-to-place table.
 *
 * The Chair's network map wants to show roughly WHERE a device is. A full
 * GeoIP database is tens of megabytes and would defeat the "no outside servers,
 * works offline" promise, so this is deliberately coarse: a compact table of
 * well-known IPv4 allocations mapped to a country and an approximate centroid,
 * plus the Chair's own rules for their known networks. It answers "probably
 * North America" / "looks like the home network", not "123 Main Street".
 *
 * Two honesty notes that belong next to the code:
 *  - Member devices never geolocate themselves. Only the Chair's app infers a
 *    location, and only from the public IP the connection already exposed.
 *  - Private and carrier-grade-NAT ranges cannot be placed at all; they resolve
 *    to "local network", which is the truthful answer.
 *
 * The Chair can extend this at runtime with their own rules (an office IP range
 * → "Grandma's house"), which is both more accurate for a family and keeps the
 * shipped table small.
 */

import { matchAddress } from "./netrules.js";

/**
 * Country centroids used to place a pin. Approximate lat/long of a central
 * point, chosen for legibility on a small world map rather than precision.
 */
const PLACES = {
  US: { name: "United States", lat: 39.8, lon: -98.6 },
  CA: { name: "Canada", lat: 56.1, lon: -106.3 },
  MX: { name: "Mexico", lat: 23.6, lon: -102.5 },
  GB: { name: "United Kingdom", lat: 54.0, lon: -2.9 },
  IE: { name: "Ireland", lat: 53.4, lon: -8.2 },
  FR: { name: "France", lat: 46.6, lon: 2.2 },
  DE: { name: "Germany", lat: 51.2, lon: 10.4 },
  NL: { name: "Netherlands", lat: 52.1, lon: 5.3 },
  ES: { name: "Spain", lat: 40.0, lon: -3.7 },
  IT: { name: "Italy", lat: 41.9, lon: 12.6 },
  SE: { name: "Sweden", lat: 60.1, lon: 18.6 },
  IN: { name: "India", lat: 22.6, lon: 78.9 },
  CN: { name: "China", lat: 35.9, lon: 104.2 },
  JP: { name: "Japan", lat: 36.2, lon: 138.3 },
  KR: { name: "South Korea", lat: 36.5, lon: 127.9 },
  SG: { name: "Singapore", lat: 1.35, lon: 103.8 },
  AU: { name: "Australia", lat: -25.7, lon: 134.5 },
  NZ: { name: "New Zealand", lat: -41.8, lon: 172.7 },
  BR: { name: "Brazil", lat: -14.2, lon: -51.9 },
  ZA: { name: "South Africa", lat: -30.6, lon: 22.9 },
  AE: { name: "United Arab Emirates", lat: 24.0, lon: 54.0 },
  LOCAL: { name: "Local network", lat: 0, lon: 0, local: true },
  UNKNOWN: { name: "Unknown", lat: 0, lon: 0, unknown: true },
};

/**
 * A very small, curated set of large allocations. This is intentionally not
 * exhaustive: it recognises common consumer and cloud ranges well enough to
 * colour a map, and everything else falls back to "unknown" rather than
 * pretending to a precision it does not have.
 */
const RANGES = [
  // Private / local — always truthful.
  ["10.0.0.0/8", "LOCAL"],
  ["172.16.0.0/12", "LOCAL"],
  ["192.168.0.0/16", "LOCAL"],
  ["100.64.0.0/10", "LOCAL"], // carrier-grade NAT
  ["169.254.0.0/16", "LOCAL"],
  ["127.0.0.0/8", "LOCAL"],
  // A handful of large, recognisable public blocks (coarse country hints).
  ["3.0.0.0/8", "US"],
  ["4.0.0.0/8", "US"],
  ["8.0.0.0/8", "US"],
  ["12.0.0.0/8", "US"],
  ["23.0.0.0/8", "US"],
  ["50.0.0.0/8", "US"],
  ["64.0.0.0/8", "US"],
  ["66.0.0.0/8", "US"],
  ["68.0.0.0/8", "US"],
  ["71.0.0.0/8", "US"],
  ["72.0.0.0/8", "US"],
  ["96.0.0.0/8", "US"],
  ["98.0.0.0/8", "US"],
  ["99.0.0.0/8", "CA"],
  ["24.0.0.0/8", "CA"],
  ["47.0.0.0/8", "CA"],
  ["148.0.0.0/8", "MX"],
  ["2.16.0.0/12", "GB"],
  ["51.0.0.0/8", "GB"],
  ["81.0.0.0/8", "GB"],
  ["86.0.0.0/8", "IE"],
  ["77.0.0.0/8", "FR"],
  ["78.0.0.0/8", "FR"],
  ["88.0.0.0/8", "DE"],
  ["91.0.0.0/8", "DE"],
  ["94.0.0.0/8", "NL"],
  ["79.0.0.0/8", "ES"],
  ["93.0.0.0/8", "IT"],
  ["83.0.0.0/8", "SE"],
  ["49.0.0.0/8", "IN"],
  ["59.0.0.0/8", "IN"],
  ["1.0.0.0/8", "CN"],
  ["14.0.0.0/8", "CN"],
  ["27.0.0.0/8", "CN"],
  ["36.0.0.0/8", "CN"],
  ["58.0.0.0/8", "CN"],
  ["126.0.0.0/8", "JP"],
  ["133.0.0.0/8", "JP"],
  ["175.0.0.0/8", "KR"],
  ["119.0.0.0/8", "SG"],
  ["1.128.0.0/11", "AU"],
  ["101.160.0.0/11", "AU"],
  ["203.0.0.0/8", "AU"],
  ["122.0.0.0/8", "NZ"],
  ["177.0.0.0/8", "BR"],
  ["189.0.0.0/8", "BR"],
  ["196.0.0.0/8", "ZA"],
  ["5.192.0.0/10", "AE"],
];

/**
 * Look an address up.
 * @param addr the IP string
 * @param rules optional Chair-authored geo rules: [{cidr, place, label, lat, lon}]
 * @returns {{code, name, lat, lon, label?, local?, unknown?, source}}
 */
export function locate(addr, rules = []) {
  if (typeof addr !== "string" || !addr) return { code: "UNKNOWN", ...PLACES.UNKNOWN, source: "none" };

  // The Chair's own rules win — they know their family's networks best.
  for (const rule of rules) {
    if (rule.cidr && matchAddress(addr, rule.cidr)) {
      const base = rule.place && PLACES[rule.place] ? PLACES[rule.place] : {};
      return {
        code: rule.place || "CUSTOM",
        name: rule.label || base.name || "Chair-defined place",
        lat: rule.lat ?? base.lat ?? 0,
        lon: rule.lon ?? base.lon ?? 0,
        label: rule.label,
        source: "rule",
      };
    }
  }

  // IPv6 is not placed by the shipped table; the Chair can add a rule for it.
  if (addr.includes(":")) return { code: "UNKNOWN", ...PLACES.UNKNOWN, source: "v6" };

  for (const [cidr, code] of RANGES) {
    if (matchAddress(addr, cidr)) return { code, ...PLACES[code], source: "table" };
  }
  return { code: "UNKNOWN", ...PLACES.UNKNOWN, source: "miss" };
}

/** Equirectangular projection to a 0..1 box, for plotting on a world map. */
export function project(lat, lon) {
  return { x: (lon + 180) / 360, y: (90 - lat) / 180 };
}

export const PLACE_TABLE = PLACES;
export default locate;
