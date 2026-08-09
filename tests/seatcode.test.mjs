/**
 * seatcode.test.mjs — "here is your seat" codes.
 *
 * A seat code is a deep link the Chair hands a cousin: scanning it opens the
 * site AND says which cousin this device is. These pin the round-trip, the
 * URL shape (payload in the FRAGMENT, which browsers never send to a server),
 * and that hostile input is refused rather than throwing.
 */

import { makeSeatCode, readSeatCode, isSeatCode, seatCodeFromLocation, baseUrl } from "../js/seatcode.js";

let failures = 0;
const assert = (n, c, e) => (c ? console.log(`ok  ${n}`) : (failures++, console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`)));

const loc = { origin: "https://cousins.example", pathname: "/congress/connect.html", hash: "" };
const secret = new Uint8Array(32).fill(7);

/* --- round trip ---------------------------------------------------------- */
const { url, payload, body } = makeSeatCode(
  { room: "cousin-congress", memberId: "m-al", name: "Al", icon: "🦊", roomSecret: secret },
  loc
);

assert("the code is an absolute URL to the site", url.startsWith("https://cousins.example/congress/index.html"));
assert("the payload rides in the FRAGMENT, never the query", url.includes("#s=") && !url.split("#")[0].includes("s="));
assert("base URL is derived from the page location", baseUrl(loc) === "https://cousins.example/congress/index.html");

const back = readSeatCode(url);
assert("a seat code round-trips from its URL", back?.memberId === "m-al" && back.name === "Al" && back.icon === "🦊");
assert("the room travels with it", back?.room === "cousin-congress");
assert("the room secret travels with it", typeof back?.psk === "string" && back.psk.length > 20);
assert("a bare payload also parses", readSeatCode(payload)?.memberId === "m-al");
assert("a bare fragment also parses", readSeatCode(`#s=${payload}`)?.memberId === "m-al");
assert("a trailing query/fragment is tolerated", readSeatCode(`${url}&utm=x`)?.memberId === "m-al");

/* --- detection ----------------------------------------------------------- */
assert("isSeatCode recognises one", isSeatCode(url));
assert("a pairing ticket is NOT a seat code", !isSeatCode("z.eyJ0IjoicGFpciJ9"));
assert("an emoji pairing code is NOT a seat code", !isSeatCode("🦊🐻🐼🦁🐯🐨"));

/* --- hostile input is refused, never thrown ------------------------------ */
for (const bad of [null, undefined, "", "   ", "#s=", "#s=@@@@", "https://x/#s=notbase64!!", "{}", "#s=" + Buffer.from('{"t":"nope"}').toString("base64url"), "#s=" + Buffer.from('{"t":"seat"}').toString("base64url")]) {
  let threw = false, out;
  try { out = readSeatCode(bad); } catch { threw = true; }
  assert(`refuses ${JSON.stringify(String(bad).slice(0, 28))} without throwing`, !threw && out === null);
}

/* --- location helper ----------------------------------------------------- */
assert("seatCodeFromLocation reads a fragment", seatCodeFromLocation({ ...loc, hash: `#s=${payload}` })?.memberId === "m-al");
assert("seatCodeFromLocation ignores an unrelated fragment", seatCodeFromLocation({ ...loc, hash: "#k=abc" }) === null);
assert("seatCodeFromLocation ignores an empty fragment", seatCodeFromLocation(loc) === null);

/* --- refusals ------------------------------------------------------------ */
let threw = false;
try { makeSeatCode({ room: "r" }, loc); } catch { threw = true; }
assert("a seat code without a member is refused", threw);

/* --- a code minted without a room secret still works (local-only room) --- */
const noPsk = makeSeatCode({ room: "r", memberId: "m-bo", name: "Bo" }, loc);
assert("a code with no room secret still round-trips", readSeatCode(noPsk.url)?.memberId === "m-bo");
assert("and carries a null psk rather than a broken one", readSeatCode(noPsk.url)?.psk === null);

console.log(failures ? `\n${failures} FAILURES` : "\nseatcode: deep links round-trip, fragment-only, hostile input refused");
process.exit(failures ? 1 : 0);
