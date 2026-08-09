/**
 * seatcode.js — "here is your seat" codes.
 *
 * A pairing code answers "connect these two devices". A SEAT code answers a
 * different question: "which cousin is this?". The Chair enrols a member, hands
 * them a code (on screen, printed, or in a chat), and the first device to scan
 * it becomes that member — no typing, no picking yourself off a list.
 *
 * WHAT IS IN ONE
 *
 *   { t:"seat", v:1, room, memberId, name, icon, psk }
 *
 * The room secret rides along so the scanner joins the right chamber, exactly
 * as a pairing code does. That makes a seat code a real credential: whoever
 * holds it can enter the room as that cousin. It is the same honest trade the
 * pairing code makes — the code IS the credential — and it is why the Chair
 * should show it to one cousin rather than post it publicly.
 *
 * FIRST SCANNER WINS
 *
 * Claiming binds this device's signing key to the seat (`member.claimKey`), and
 * the authorisation rules already say the first key to claim an unclaimed seat
 * owns it. So a code that leaks after the cousin has used it does NOT hand the
 * seat over: a second device is refused until the Chair enrols it. The Chair can
 * always reset a seat's devices and re-issue.
 *
 * DEEP LINK
 *
 * The code is encoded as an absolute URL — `https://…/index.html#s=…` — so a
 * phone's ordinary camera opens the site AND carries the payload in one scan.
 * The payload sits in the fragment, which browsers never send to a server, so
 * even a hosted deployment never sees a seat secret.
 */

import { b64, unb64 } from "./crypto.js";

export const SEAT_PREFIX = "#s=";

const te = new TextEncoder();
const td = new TextDecoder();

/** Where the app lives, so a scanned code can open it directly. */
export function baseUrl(loc = location) {
  const path = loc.pathname.replace(/\/[^/]*$/, "/");
  return `${loc.origin}${path}index.html`;
}

/**
 * Build a seat code. Returns both the deep link (for the QR) and the raw
 * payload (for anyone who wants to paste text instead).
 */
export function makeSeatCode({ room, memberId, name, icon, roomSecret }, loc = location) {
  if (!memberId) throw new Error("A seat code needs a member.");
  const body = {
    t: "seat",
    v: 1,
    room,
    memberId,
    name: name || "",
    icon: icon || "🪑",
    psk: roomSecret ? b64(roomSecret) : null,
  };
  const payload = b64(te.encode(JSON.stringify(body)));
  return { url: `${baseUrl(loc)}${SEAT_PREFIX}${payload}`, payload, body };
}

/** Parse a seat code from a URL, a bare payload, or a full fragment. */
export function readSeatCode(text) {
  if (typeof text !== "string" || !text) return null;
  let payload = text.trim();
  const at = payload.indexOf(SEAT_PREFIX);
  if (at >= 0) payload = payload.slice(at + SEAT_PREFIX.length);
  // Tolerate a stray fragment or query tacked on the end.
  payload = payload.split(/[#?&\s]/)[0];
  if (!payload) return null;
  try {
    const body = JSON.parse(td.decode(unb64(payload)));
    if (!body || body.t !== "seat" || !body.memberId) return null;
    return body;
  } catch {
    return null;
  }
}

/** True if this looks like a seat code rather than a pairing ticket. */
export const isSeatCode = (text) => readSeatCode(text) !== null;

/** Read one out of the current address bar, if the page was opened by a scan. */
export function seatCodeFromLocation(loc = location) {
  const hash = loc.hash || "";
  return hash.startsWith(SEAT_PREFIX) ? readSeatCode(hash) : null;
}

/** Scrub the code from the address bar so a shared screenshot cannot leak it. */
export function clearSeatCodeFromLocation() {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* best effort */
  }
}

export default { makeSeatCode, readSeatCode, isSeatCode, seatCodeFromLocation, baseUrl };
