/**
 * Share-link round-trips and the properties that make them safe: the key lives
 * only in the fragment, tampering is rejected, and no field outside the
 * allow-list ever survives the trip.
 */

import { createShareLink, openShareFromLocation } from "../js/share.js";

let failures = 0;
const ok = (n) => console.log(`ok  ${n}`);
const bad = (n, e = "") => {
  failures += 1;
  console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`);
};
const assert = (n, c, e) => (c ? ok(n) : bad(n, e));

// Minimal location shim so the module can build and read URLs under node.
function setLocation(url) {
  const u = new URL(url);
  globalThis.location = { href: u.href, search: u.search, hash: u.hash, origin: u.origin };
}
setLocation("https://fam.example/read.html");

const bill = {
  id: "b-secret-1",
  number: "H.CC. 7",
  title: "The Treehouse Access Act",
  summary: "Governs who may climb the treehouse and when.",
  text: "SECTION 1. Access is granted to all cousins in good standing.",
  stage: "floor",
  introduced: "2026-08-01T00:00:00.000Z",
  sponsor: "m-internal-id", // must NOT leak
  auth: { hash: "secret" }, // must NOT leak
  _hlc: "internal",
};

const link = await createShareLink("bill", bill, { base: "https://fam.example/read.html" });

/* --- structure ------------------------------------------------------------ */

const url = new URL(link);
assert("ciphertext is in the query string", url.searchParams.has("c"));
assert("key is in the fragment", url.hash.startsWith("#k="));
assert("the key is NOT in the query", !url.search.includes("k="));
assert("no plaintext title in the link", !link.includes("Treehouse"));

/* --- round-trip ----------------------------------------------------------- */

setLocation(link);
const opened = await openShareFromLocation();
assert("link decrypts", opened !== null);
assert("type preserved", opened?.type === "bill");
assert("shared field preserved", opened?.item.title === "The Treehouse Access Act");
assert("body preserved", opened?.item.text.includes("good standing"));

/* --- allow-list enforcement ---------------------------------------------- */

assert("internal sponsor id stripped", opened?.item.sponsor === undefined);
assert("auth object stripped", opened?.item.auth === undefined);
assert("internal _hlc stripped", opened?.item._hlc === undefined);
assert("raw id stripped", opened?.item.id === undefined);

/* --- tampering ------------------------------------------------------------ */

{
  // Flip a byte of the ciphertext; GCM must reject it.
  const u = new URL(link);
  const c = u.searchParams.get("c");
  const flipped = (c[10] === "A" ? "B" : "A") + c.slice(1); // change first char
  u.search = `?c=${flipped}`;
  setLocation(u.toString());
  const tampered = await openShareFromLocation();
  assert("tampered ciphertext is rejected", tampered === null);
}

{
  // Wrong key must not decrypt.
  const u = new URL(link);
  u.hash = "#k=" + "A".repeat(43);
  setLocation(u.toString());
  const wrong = await openShareFromLocation();
  assert("wrong key is rejected", wrong === null);
}

{
  // Missing fragment entirely (e.g. a server that stripped it) → no leak.
  const u = new URL(link);
  u.hash = "";
  setLocation(u.toString());
  assert("no key means no decrypt", (await openShareFromLocation()) === null);
}

/* --- other types ---------------------------------------------------------- */

for (const [type, item, probe] of [
  ["news", { title: "Hello", body: "World", author: "June", secret: "x" }, "Hello"],
  ["docket", { title: "Hearing", kind: "hearing", starts: "2026-08-08T16:00:00Z", room: "kitchen", memberOnly: "x" }, "Hearing"],
]) {
  const l = await createShareLink(type, item, { base: "https://fam.example/read.html" });
  setLocation(l);
  const o = await openShareFromLocation();
  assert(`${type} round-trips`, o?.item.title === probe);
  assert(`${type} strips unknown fields`, o?.item.secret === undefined && o?.item.memberOnly === undefined);
}

console.log(failures ? `\n${failures} FAILURES` : "\nshare: capability links round-trip and stay scoped to one item");
process.exit(failures ? 1 : 0);
