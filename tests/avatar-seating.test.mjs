/**
 * avatar-seating.test.mjs — the decorator's data model, and chamber seating.
 *
 * Two modules shipped without in-repo tests, and both handle input that arrives
 * from other people's devices:
 *
 *   - A badge spec replicates. Four of its five fields are ids into a frozen
 *     table, and that lookup is the injection defence — an unknown id from a
 *     peer must become the default rather than reach the SVG. The fifth is a
 *     glyph, which is the one field a hostile peer can put anything in.
 *   - Seat layout decides whether a chamber is readable. It used to stop at
 *     three arcs, so past roughly two dozen cousins the back row was asked to
 *     hold more seats than fit along it and the discs overlapped.
 */

import { renderAvatar, normaliseSpec, memberAvatar } from "../js/emoji-decorate.js";
import { seatRows } from "../js/views.js";

let failures = 0;
const ok = (n) => console.log(`ok  ${n}`);
const bad = (n, e = "") => { failures++; console.error(`FAIL ${n}${e ? ` — ${e}` : ""}`); };
const assert = (n, c, e) => (c ? ok(n) : bad(n, e));

/* ========================================================================= */
/* A. The badge spec is small, stable and safe                               */
/* ========================================================================= */
{
  const spec = normaliseSpec({ emoji: "🦊", bg: "blue", shape: "shield", accessory: "crown", ring: "gold" });
  assert("a well-formed spec survives normalisation", spec.emoji === "🦊" && spec.shape === "shield");

  const size = JSON.stringify(spec).length;
  assert(`a spec stays small enough to replicate freely (${size}B)`, size < 160, `${size} bytes`);

  // Unknown ids must fall back rather than reach the SVG.
  const hostile = normaliseSpec({
    emoji: "🦊",
    bg: '"/><script>alert(1)</script>',
    shape: "../../etc/passwd",
    accessory: "<img onerror=x>",
    ring: "javascript:alert(1)",
  });
  const svg = renderAvatar(hostile, 44);
  assert("an unknown colour id falls back", hostile.bg !== '"/><script>alert(1)</script>');
  assert("an unknown shape id falls back", hostile.shape !== "../../etc/passwd");
  assert("no script tag survives into the SVG", !/<script/i.test(svg));
  assert("no inline event handler survives into the SVG", !/\son\w+=/i.test(svg));
  assert("no javascript: URL survives into the SVG", !/javascript:/i.test(svg));

  // The glyph is the one free-text field, so it must be escaped and clamped.
  const injected = renderAvatar(normaliseSpec({ emoji: "<script>alert(1)</script>" }), 44);
  assert("a markup glyph is escaped, not embedded", !/<script/i.test(injected));
  const longGlyph = normaliseSpec({ emoji: "🦊🐻🐼🦁🐯🐨🐸🐵" });
  assert("a glyph is clamped to a single character", [...longGlyph.emoji].length <= 2, JSON.stringify(longGlyph.emoji));

  // Rendering must never throw on junk, because it runs inside a paint loop.
  for (const junk of [null, undefined, {}, { emoji: "" }, { emoji: 42 }, [], "nope"]) {
    let threw = false;
    try { renderAvatar(normaliseSpec(junk), 32); } catch { threw = true; }
    assert(`renderAvatar survives ${JSON.stringify(junk)}`, !threw);
  }

  // A cousin who never opened the decorator keeps the emoji they had.
  const legacy = memberAvatar({ icon: "🐢", name: "Al" }, 44);
  assert("a bare legacy icon still renders", typeof legacy === "string" && legacy.includes("<svg"));
  assert("the legacy glyph is the one that was set", legacy.includes("🐢"));
}

/* ========================================================================= */
/* B. Seating scales without collisions                                      */
/* ========================================================================= */
{
  // Capacity per arc, front row outward — the same rule the layout uses.
  const capacity = (index) => 6 + index * 3;

  for (const n of [1, 2, 5, 6, 7, 12, 16, 17, 24, 30, 40, 60]) {
    const rows = seatRows(n);
    const seated = rows.reduce((a, b) => a + b, 0);
    assert(`${n} cousins: every cousin gets a seat`, seated === n, `seated ${seated}`);
    assert(`${n} cousins: no empty arc`, rows.every((r) => r >= 1), JSON.stringify(rows));
    const over = rows.map((count, i) => (count > capacity(i) ? `row${i}=${count}>${capacity(i)}` : null)).filter(Boolean);
    assert(`${n} cousins: no arc is overfilled`, over.length === 0, over.join(" "));
  }

  // The shape should stay chamber-like: back rows never sparser than front.
  const big = seatRows(40);
  const ascending = big.every((count, i) => i === 0 || count >= big[i - 1]);
  assert("arcs grow from the rostrum outward", ascending, JSON.stringify(big));

  // A small family stays on one row rather than being spread thin.
  assert("six or fewer cousins share one arc", seatRows(6).length === 1);
}

console.log(failures ? `\n${failures} FAILURES` : "\navatar-seating: badge specs are small and injection-safe, seating scales without collisions");
process.exit(failures ? 1 : 0);
