/**
 * emoji.test.mjs — the catalogue has to be safe to store, not just pretty.
 *
 * A badge is written into the op log, replicated to every cousin's device and
 * printed on seal cards, so the thing this file mostly cares about is that no
 * entry is a sequence pretending to be a character. A ZWJ family, a skin-tone
 * modifier or a stray variation selector all round-trip as one glyph on the
 * machine that authored them and as two or three boxes on a cousin's tablet,
 * and by then the choice is already in the log.
 *
 * Run: node tests/emoji.test.mjs
 * No dependencies — this one is plain node against the shipped module.
 */

import {
  EMOJI_GROUPS,
  searchEmoji,
  RANDOM_BADGE,
  emojiName,
} from "../js/emoji.js";

let failures = 0;
let checks = 0;

const check = (ok, message) => {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
  return ok;
};

const codePoints = (char) => [...char].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`);

/* --------------------------------------------------------------------------
   Shape of the catalogue
   -------------------------------------------------------------------------- */

const MIN_ENTRIES = 400;
const MIN_GROUPS = 8;

const all = EMOJI_GROUPS.flatMap((group) => group.emoji);

console.log("Catalogue");
console.log(`  ${EMOJI_GROUPS.length} groups, ${all.length} emoji`);
for (const group of EMOJI_GROUPS) {
  console.log(`  ${group.icon} ${group.label.padEnd(18)} ${String(group.emoji.length).padStart(3)}`);
}

check(EMOJI_GROUPS.length >= MIN_GROUPS, `only ${EMOJI_GROUPS.length} groups, want ${MIN_GROUPS}`);
check(all.length >= MIN_ENTRIES, `only ${all.length} emoji, want at least ${MIN_ENTRIES}`);

for (const group of EMOJI_GROUPS) {
  check(typeof group.id === "string" && /^[a-z-]+$/.test(group.id), `bad group id ${group.id}`);
  check(Boolean(group.label), `group ${group.id} has no label`);
  check(Boolean(group.icon), `group ${group.id} has no icon`);
  check(group.emoji.length >= 20, `group ${group.id} has only ${group.emoji.length} emoji`);
}

const ids = EMOJI_GROUPS.map((g) => g.id);
check(new Set(ids).size === ids.length, `duplicate group ids: ${ids.join(", ")}`);

// The group icons sit in the jump bar and go through exactly the same font and
// storage path as the badges, so they get the same rule rather than a pass for
// being chrome.
for (const group of EMOJI_GROUPS) {
  check(
    [...group.icon].length === 1 && /^\p{Emoji_Presentation}$/u.test(group.icon),
    `group ${group.id} icon ${group.icon} is not a single-codepoint emoji`
  );
}

/* --------------------------------------------------------------------------
   Every char is one safe grapheme
   -------------------------------------------------------------------------- */

const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const SKIN_TONES = [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff];
const TAG_RANGE = [0xe0020, 0xe007f];
const REGIONAL = [0x1f1e6, 0x1f1ff];
const KEYCAP = 0x20e3;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

console.log("\nGlyph safety");
let unsafe = 0;

for (const entry of all) {
  const points = [...entry.char].map((c) => c.codePointAt(0));

  const one = check(
    points.length === 1,
    `${entry.name}: ${codePoints(entry.char).join(" ")} is ${points.length} code points`
  );
  if (!one) unsafe += 1;

  const graphemes = [...segmenter.segment(entry.char)];
  check(graphemes.length === 1, `${entry.name}: ${entry.char} is ${graphemes.length} graphemes`);

  for (const point of points) {
    check(point !== ZWJ, `${entry.name}: contains a zero-width joiner`);
    check(point !== VS15 && point !== VS16, `${entry.name}: contains a variation selector`);
    check(!SKIN_TONES.includes(point), `${entry.name}: contains a skin-tone modifier`);
    check(point !== KEYCAP, `${entry.name}: is a keycap sequence`);
    check(
      point < REGIONAL[0] || point > REGIONAL[1],
      `${entry.name}: is built from regional indicators (a flag)`
    );
    check(point < TAG_RANGE[0] || point > TAG_RANGE[1], `${entry.name}: contains a tag character`);
  }

  // The property that actually decides whether a font paints colour without
  // being asked. Anything that is Emoji but not Emoji_Presentation needs a
  // U+FE0F to look like an emoji at all, and we have just banned those.
  const presents = check(
    /^\p{Emoji_Presentation}$/u.test(entry.char),
    `${entry.name}: ${entry.char} ${codePoints(entry.char)} is not Emoji_Presentation`
  );
  if (!presents) unsafe += 1;
}

console.log(`  ${all.length - unsafe}/${all.length} glyphs are single-codepoint emoji-presentation`);

/* --------------------------------------------------------------------------
   No duplicates, everything named
   -------------------------------------------------------------------------- */

console.log("\nNames and keywords");

const seen = new Map();
for (const group of EMOJI_GROUPS) {
  for (const entry of group.emoji) {
    const first = seen.get(entry.char);
    check(!first, `${entry.char} appears in both ${first} and ${group.id}`);
    if (!first) seen.set(entry.char, group.id);
  }
}
check(seen.size === all.length, `${all.length - seen.size} duplicate chars`);

const names = new Map();
for (const entry of all) {
  check(
    typeof entry.name === "string" && entry.name.length >= 2,
    `${entry.char} has no usable name (${JSON.stringify(entry.name)})`
  );
  check(
    /^[a-z][a-z ]*$/.test(entry.name),
    `${entry.char}: name ${JSON.stringify(entry.name)} is not plain lowercase words`
  );
  check(
    Array.isArray(entry.keywords) && entry.keywords.length >= 1,
    `${entry.char} (${entry.name}) has no keywords`
  );
  check(
    entry.keywords.every((word) => /^[a-z]+$/.test(word)),
    `${entry.char} (${entry.name}) has an odd keyword: ${entry.keywords.join(" ")}`
  );
  check(
    !entry.keywords.includes(entry.name),
    `${entry.char} (${entry.name}) repeats its name as a keyword`
  );
  check(
    new Set(entry.keywords).size === entry.keywords.length,
    `${entry.char} (${entry.name}) lists a keyword twice: ${entry.keywords.join(" ")}`
  );
  const clash = names.get(entry.name);
  check(!clash, `name "${entry.name}" is used by both ${clash} and ${entry.char}`);
  if (!clash) names.set(entry.name, entry.char);
}
console.log(`  ${names.size} distinct names, ${all.reduce((n, e) => n + e.keywords.length, 0)} keywords`);

check(emojiName("🦊") === "fox", `emojiName("🦊") gave ${JSON.stringify(emojiName("🦊"))}`);
check(emojiName("nope") === "", "emojiName should return an empty string for a stranger");

/* --------------------------------------------------------------------------
   Search
   -------------------------------------------------------------------------- */

console.log("\nSearch");

/** True when the query genuinely appears in the entry, name or keywords. */
const relevant = (entry, query) =>
  entry.name.includes(query) || entry.keywords.some((word) => word.includes(query));

const QUERIES = [
  { query: "cat", first: "🐱", expect: ["😺", "🐈"] },
  { query: "pizza", first: "🍕", expect: [] },
  { query: "star", first: "⭐", expect: ["🌟", "🌠"] },
  { query: "ball", first: null, expect: ["⚽", "🏀", "🎾", "🏐"], topFour: ["⚽", "🏀", "🏈", "⚾"] },
  { query: "dog", first: "🐶", expect: ["🐕", "🌭"] },
  { query: "moon", first: null, expect: ["🌙", "🌕", "🌚"] },
];

for (const { query, first, expect, topFour } of QUERIES) {
  const results = searchEmoji(query, 40);
  const chars = results.map((entry) => entry.char);
  console.log(`  ${query.padEnd(7)} ${results.length} hits  ${chars.slice(0, 12).join(" ")}`);

  check(results.length > 0, `"${query}" found nothing`);
  if (first) {
    check(chars[0] === first, `"${query}" ranked ${chars[0]} first, wanted ${first}`);
  }
  for (const want of expect) {
    check(chars.includes(want), `"${query}" missed ${want}`);
  }
  if (topFour) {
    check(
      chars.slice(0, 4).join("") === topFour.join(""),
      `"${query}" opened with ${chars.slice(0, 4).join(" ")}, wanted ${topFour.join(" ")}`
    );
  }
  for (const entry of results) {
    check(relevant(entry, query), `"${query}" returned ${entry.char} (${entry.name}) — no match in it`);
  }
  // Anything with the query as a whole word should outrank a mere substring.
  const wordHit = results.findIndex((e) => e.name.split(" ").includes(query) || e.keywords.includes(query));
  const infixOnly = results.findIndex((e) => !e.name.split(" ").includes(query) && !e.keywords.includes(query));
  if (wordHit >= 0 && infixOnly >= 0) {
    check(wordHit < infixOnly, `"${query}" ranked a partial word above an exact one`);
  }
}

check(searchEmoji("").length === 0, "an empty query should return nothing");
check(searchEmoji("   ").length === 0, "a whitespace query should return nothing");
check(searchEmoji(null).length === 0, "a null query should return nothing");
check(searchEmoji("cat", 3).length === 3, "the limit is not being applied");
check(searchEmoji("CAT", 5)[0].char === "🐱", "search should be case-insensitive");
check(
  searchEmoji("zzzzqqq").length === 0,
  "a nonsense query should return nothing rather than everything"
);

// A badge nobody can search for is a badge only scrolling will find, so every
// entry has to come back near the top for its own name. This is the check that
// catches a name whose words are so common that the entry drowns in them.
let unfindable = 0;
let deepest = 0;
for (const entry of all) {
  const ranked = searchEmoji(entry.name, all.length).map((hit) => hit.char);
  const rank = ranked.indexOf(entry.char);
  if (rank < 0) {
    unfindable += 1;
    check(false, `${entry.char} (${entry.name}) cannot be found by its own name`);
  } else {
    if (rank > deepest) deepest = rank;
    check(rank < 5, `${entry.char} (${entry.name}) ranks ${rank} for its own name`);
  }
}
console.log(`  every name finds its own badge, worst rank ${deepest}, ${unfindable} unfindable`);

// Limits and junk arguments. searchEmoji is handed whatever an input box holds,
// so a NaN or a negative limit has to come back empty rather than unbounded.
check(searchEmoji("cat", 0).length === 0, "a limit of 0 should return nothing");
check(searchEmoji("cat", -3).length === 0, "a negative limit should return nothing");
check(searchEmoji("cat", NaN).length === 0, "a NaN limit should return nothing");
check(searchEmoji("cat", Infinity).length > 0, "an infinite limit should still return the hits");
check(searchEmoji(0).length === 0, "a number query should not match");
check(searchEmoji({}).length === 0, "an object query should not match");
check(searchEmoji([]).length === 0, "an array query should not match");
check(searchEmoji(".*").length === 0, "the query is matched literally, not as a regex");
check(searchEmoji("\t\ncat\n").length === searchEmoji("cat").length, "odd whitespace should tokenise the same");

// BY_CHAR is a Map rather than an object literal; these are the keys that would
// come back with something borrowed from Object.prototype if it were not.
check(emojiName("__proto__") === "", "emojiName should not leak Object.prototype");
check(emojiName("constructor") === "", "emojiName should not leak a constructor");
check(emojiName("🦊🦊") === "", "emojiName should not match a doubled glyph");
check(emojiName(null) === "" && emojiName(undefined) === "", "emojiName should tolerate no argument");

// Two tokens narrow: "red apple" should not simply concatenate the two sets.
const narrowed = searchEmoji("red apple", 10);
check(narrowed.length > 0 && narrowed[0].char === "🍎", "multi-word search should narrow to 🍎");
check(
  narrowed.every((entry) => relevant(entry, "red") && relevant(entry, "apple")),
  "multi-word search returned an entry matching only one token"
);

/* --------------------------------------------------------------------------
   RANDOM_BADGE
   -------------------------------------------------------------------------- */

console.log("\nRandom badge");
const drawn = new Set();
for (let i = 0; i < 400; i += 1) {
  const char = RANDOM_BADGE();
  check(seen.has(char), `RANDOM_BADGE returned ${char}, which is not in the catalogue`);
  drawn.add(char);
}
console.log(`  400 draws produced ${drawn.size} distinct badges`);
check(drawn.size > 100, `400 draws only produced ${drawn.size} distinct badges — not random enough`);

/* --------------------------------------------------------------------------
   The picker must not reach for a document at import time
   -------------------------------------------------------------------------- */

const source = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("../js/emoji.js", import.meta.url), "utf8")
);
check(!/\.innerHTML/.test(source), "emoji.js assigns innerHTML somewhere");
check(!/insertAdjacentHTML/.test(source), "emoji.js uses insertAdjacentHTML");
check(
  !/^\s*(import|export)[^\n]*\bfrom\s+["'](?!\.)/m.test(source),
  "emoji.js imports something that is not a relative path"
);

/* -------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("emoji: OK");
