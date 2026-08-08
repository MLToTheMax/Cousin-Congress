/**
 * icons.js — the picture alphabet.
 *
 * Pairing codes and match badges are written in emoji instead of base64
 * gibberish: a fixed table of 256 single-codepoint emoji encodes one byte
 * each, so a code is a string of little pictures a kid can copy into the
 * family chat. Every emoji here is a single code point with emoji
 * presentation by default (no variation selectors, no ZWJ sequences), which
 * is what lets [...string] round-trip cleanly through chat apps.
 */

const TABLE =
  "🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔" +
  "🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞" +
  "🐜🦗🐢🐍🦎🦖🦕🐙🦑🦐🦀🐡🐠🐟🐬🐳" +
  "🐋🦈🐊🐅🐆🦓🦍🐘🦏🐪🐫🦒🐃🐂🐄🐎" +
  "🐖🐏🐑🐐🦌🐕🐩🐈🐓🦃🐇🐁🐀🦔🦚🦜" +
  "🍏🍎🍐🍊🍋🍌🍉🍇🍓🍈🍒🍑🥭🍍🥥🥝" +
  "🍅🍆🥑🥦🥬🥒🌽🥕🥔🍠🥐🥯🍞🥖🥨🧀" +
  "🥚🍳🥞🥓🥩🍗🍖🌭🍔🍟🍕🥪🥙🌮🌯🥗" +
  "🥘🍝🍜🍲🍛🍣🍱🥟🍤🍙🍚🍘🍥🥠🍢🍡" +
  "🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪🌰🥜" +
  "⚽🏀🏈⚾🥎🎾🏐🏉🎱🏓🏸🥅🎣🎽🎿🛷" +
  "🥌🎯🎳🎮🎲🧩🎭🎨🎼🎤🎧🎷🎸🎹🎺🎻" +
  "🥁🎬🏹🎪🎢🎡🎠🧸🎈🎉🎊🎁🏆🥇🥈🥉" +
  "🚗🚕🚙🚌🚎🚑🚒🚐🚚🚛🚜🛴🚲🛵🚁🚀" +
  "🛸🚂🚆🚇🚊🚉🛫🛬⛵🚤⚓🚢🗿🗽🗼🏰" +
  "🌵🎄🌲🌳🌴🌱🌿🍀🎍🎋🍁🍄🐚🌾🌷🌹";

export const ICONS = [...TABLE];

const INDEX = new Map(ICONS.map((icon, i) => [icon, i]));

if (ICONS.length !== 256 || INDEX.size !== 256) {
  // A duplicated or multi-codepoint entry would corrupt every code silently.
  console.error(
    `[cousin-congress] icon table invalid: ${ICONS.length} glyphs, ${INDEX.size} unique`
  );
}

/** One emoji per byte. */
export function emojiEncode(bytes) {
  let out = "";
  for (const b of bytes) out += ICONS[b];
  return out;
}

/**
 * Inverse of emojiEncode. Anything that is not in the table — whitespace,
 * line breaks, stray punctuation a chat app added — is simply skipped, so a
 * code survives being wrapped, quoted, or decorated.
 */
export function emojiDecode(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const i = INDEX.get(ch);
    if (i !== undefined) bytes.push(i);
  }
  return Uint8Array.from(bytes);
}

/** True when a string is mostly made of table emoji (i.e., one of our codes). */
export function looksLikeIconCode(text) {
  let hits = 0;
  let glyphs = 0;
  for (const ch of String(text)) {
    if (/\s/.test(ch)) continue;
    glyphs += 1;
    if (INDEX.has(ch)) hits += 1;
  }
  return glyphs > 0 && hits / glyphs > 0.5;
}

/**
 * A short "match badge" for a code: both cousins should see the same four
 * pictures. Comparing pictures is a verification step a six-year-old can run.
 */
export async function iconFingerprint(text, length = 4) {
  const data = new TextEncoder().encode(String(text));
  let bytes;
  if (globalThis.crypto?.subtle) {
    bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  } else {
    // Non-secure-context fallback: FNV-1a, folded. Only feeds a badge.
    let h = 0x811c9dc5;
    for (const b of data) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    bytes = new Uint8Array([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff, (h >> 24) & 0xff]);
  }
  let out = "";
  for (let i = 0; i < length; i += 1) out += ICONS[bytes[i % bytes.length]];
  return out;
}

/** Curated picks for member avatars in the chair's console. */
export const AVATAR_CHOICES = [
  "🦉", "🦊", "🐸", "🐼", "🦄", "🐙", "🦖", "🐝",
  "🌊", "🌱", "🍀", "🌹", "🍿", "🍩", "🍕", "🍉",
  "🎲", "🎨", "🎧", "🎸", "🚀", "⚓", "🏰", "🏆",
];
