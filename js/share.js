/**
 * share.js — capability links that unlock exactly one item.
 *
 * The chamber is private: to see it you pair a device and hold the room secret.
 * But sometimes a cousin wants to send just one thing to someone outside the
 * chamber — a single news note, one bill's text, one docket entry — without
 * handing over the keys to everything.
 *
 * A share link does precisely that. The one item is sealed under a brand-new
 * random key, and that key is placed in the URL's **fragment** (the part after
 * `#`). Browsers never send the fragment to a server, so the key reaches the
 * recipient's browser and nowhere else — not the relay, not GitHub Pages, not
 * the page's own web server logs. The recipient opens the link, their browser
 * decrypts the one item locally, and shows it read-only. There is no mesh to
 * join, no room secret, no other item reachable: the capability is the link,
 * and the link is one item.
 *
 * This is the well-understood "encrypted pastebin in the fragment" pattern
 * (as used by client-side-encrypted note tools). Its security rests on the
 * same fact every time: whoever holds the link holds the item. Treat a share
 * link like the contents themselves.
 */

const te = new TextEncoder();
const td = new TextDecoder();

/** URL-safe base64 with no padding — compact and fragment-clean. */
const b64u = (bytes) => {
  let s = "";
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const unb64u = (text) => {
  const p = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

/** Fields we are willing to reveal per item type. Anything else is stripped so
 *  a share can never leak an internal flag, a signature, or another item's id. */
const SHAREABLE = {
  news: ["title", "category", "excerpt", "body", "author", "published", "memberNote"],
  bill: ["number", "title", "summary", "text", "stage", "introduced", "session", "sponsorName"],
  docket: ["title", "kind", "starts", "durationMin", "room", "note"],
};

const TYPE_LABEL = { news: "Dispatch", bill: "Bill", docket: "Docket item" };

function pick(item, allowed) {
  const out = {};
  for (const key of allowed) if (item[key] !== undefined) out[key] = item[key];
  return out;
}

/* --------------------------------------------------------------------------
   Creating a link
   -------------------------------------------------------------------------- */

/**
 * Seal one item into a shareable link.
 * @param type "news" | "bill" | "docket"
 * @param item the record (already resolved to display form)
 * @param opts.base absolute or relative URL of read.html
 * @returns {Promise<string>} the full share URL
 */
export async function createShareLink(type, item, { base = "read.html" } = {}) {
  const allowed = SHAREABLE[type];
  if (!allowed) throw new Error(`Cannot share a "${type}".`);

  const payload = {
    v: 1,
    type,
    label: TYPE_LABEL[type] || "Item",
    item: pick(item, allowed),
    sharedAt: new Date().toISOString(),
  };

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, te.encode(JSON.stringify(payload)))
  );
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));

  // The key goes in the fragment, the ciphertext in the query — so even a
  // server that logs the full request line only ever records the ciphertext.
  const box = new Uint8Array(nonce.length + sealed.length);
  box.set(nonce);
  box.set(sealed, nonce.length);

  const url = new URL(base, location.href);
  url.search = `?c=${b64u(box)}`;
  url.hash = `k=${b64u(rawKey)}`;
  return url.toString();
}

/* --------------------------------------------------------------------------
   Opening a link (runs on read.html)
   -------------------------------------------------------------------------- */

/**
 * Decrypt a share link from the current location.
 * @returns {Promise<{type,label,item,sharedAt}|null>}
 */
export async function openShareFromLocation() {
  const params = new URLSearchParams(location.search);
  const cipher = params.get("c");
  const keyParam = new URLSearchParams(location.hash.replace(/^#/, "")).get("k");
  if (!cipher || !keyParam) return null;

  try {
    const box = unb64u(cipher);
    if (box.length < 13) return null;
    const nonce = box.subarray(0, 12);
    const sealed = box.subarray(12);

    const key = await crypto.subtle.importKey("raw", unb64u(keyParam), { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, sealed)
    );
    const payload = JSON.parse(td.decode(plain));
    if (!payload || typeof payload !== "object" || !SHAREABLE[payload.type]) return null;
    // Re-strip on open too: never trust that the sealer restricted the fields.
    payload.item = pick(payload.item || {}, SHAREABLE[payload.type]);
    return payload;
  } catch {
    // Wrong key, truncated link, or tampered ciphertext all land here. The
    // page shows a friendly "this link didn't work" rather than a stack trace.
    return null;
  }
}

export const shareTypeLabel = (type) => TYPE_LABEL[type] || "Item";

export default { createShareLink, openShareFromLocation };
