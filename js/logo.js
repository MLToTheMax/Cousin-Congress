/**
 * logo.js — the mark: a tiny capitol built from three primary shapes.
 *
 * The old wordmark was a "CC" monogram sitting in a dull circle — legible,
 * but it read like a law firm, not a family. This replaces it with a
 * geometric abstraction of a capitol dome, built from exactly three primary
 * shapes in the three primary colours the whole app is built on:
 *
 *   - a blue circle      the rotunda / the family's shared base
 *   - a brass semicircle  the dome, capping the circle
 *   - a crimson triangle  a little flag planted on top
 *
 * No clip-art, no gradients, no photographic dome — just the shapes
 * `css/layout.css` already uses for page furniture (.deco--circle,
 * .deco--disc, .deco--tri), recomposed into a badge that reads at a glance
 * whether you are six or sixty, and still resolves cleanly at 32px in a
 * browser tab.
 *
 * Every fill is `var(--token, #hex)` — the token wins wherever tokens.css is
 * loaded (so the mark inherits theme/token changes for free), and the hex
 * fallback is the exact primary-colour value from the design brief, so the
 * mark still renders correctly in isolation (e.g. this file's own PNG
 * verification, or anywhere tokens.css hasn't loaded).
 *
 * The SVG itself is inert on purpose — geometry only, no <animate>, no
 * inline style. All motion (the idle bob, the hover wiggle) lives in
 * css/logo.css, gated behind prefers-reduced-motion like every other
 * animation in this app.
 *
 * Geometry lives in a 40x40 viewBox to match `--seal-size` in
 * css/layout.css's `.brand__seal`, so `.brand__mark` can drop into the same
 * masthead slot without a resize.
 */

/**
 * The inline mark: a static, self-contained <svg> string. No external refs,
 * no <image>, no script inside the markup — safe to inject with innerHTML
 * anywhere in the app.
 */
export const LOGO_MARK = `<svg class="brand__mark" viewBox="0 0 40 40" width="40" height="40" role="img" aria-hidden="true" focusable="false">
  <circle class="mark__base" cx="20" cy="24.8" r="12.5" fill="var(--c-blue-600, #1b3fd8)" />
  <path class="mark__dome" d="M11,15.3 A9,9 0 0 1 29,15.3 Z" fill="var(--c-yellow-500, #ffc21a)" />
  <path class="mark__flag" d="M20,2.8 L24,8.8 L16,8.8 Z" fill="var(--c-red-500, #e0243c)" />
</svg>`;

/**
 * Compact favicon build of the same three shapes, with literal hex fills —
 * a browser tab has no access to this app's tokens.css, so the fallback
 * colours from LOGO_MARK become the primary colours here. Kept as its own
 * tiny svg string (no whitespace, no comments, no class names it will never
 * use) rather than reusing LOGO_MARK, then percent-encoded at load time so
 * the exported constant is always a valid, ready-to-use data: URI.
 */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
  '<circle cx="20" cy="24.8" r="12.5" fill="#1b3fd8"/>' +
  '<path d="M11,15.3A9,9 0 0 1 29,15.3Z" fill="#ffc21a"/>' +
  '<path d="M20,2.8L24,8.8L16,8.8Z" fill="#e0243c"/>' +
  "</svg>";

export const LOGO_FAVICON = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;
