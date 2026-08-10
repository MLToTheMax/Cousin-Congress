/**
 * version.js — what build am I looking at?
 *
 * A local-first app is copied around: a cousin scans a code from a phone still
 * running last month's build, someone opens a zip from a chat, GitHub Pages
 * serves a cached bundle. When something behaves oddly, "which version are you
 * on?" is the very first question — so the answer sits in the footer of every
 * page rather than being buried in a file nobody opens.
 *
 * SCHEMA_VERSION is separate and deliberately so: this is the human build label,
 * that is the on-the-wire data format (see schema.js).
 */

export const VERSION = "1.0.0";

/** Bumped by hand alongside VERSION; shown next to it so builds are orderable. */
export const BUILD = "2026.08.10";

/** One short string for the footer, e.g. "v1.0.0 · 2026.08.10". */
export const versionLabel = () => `v${VERSION} · ${BUILD}`;

/**
 * Paint the label into every [data-version] slot. Also exposes the version on
 * the global for support questions ("open the console and type CousinCongress
 * .version") and as a data attribute for automated checks.
 */
export function mountVersion(doc = document) {
  const label = versionLabel();
  for (const node of doc.querySelectorAll("[data-version]")) {
    node.textContent = label;
    node.title = `Cousin Congress ${label} · data format v${
      // Late import avoids a cycle; schema.js is tiny and already loaded.
      globalThis.__ccSchemaVersion ?? "?"
    }`;
  }
  doc.documentElement.dataset.ccVersion = VERSION;
  return label;
}

export default { VERSION, BUILD, versionLabel, mountVersion };
