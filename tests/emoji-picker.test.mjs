/**
 * emoji-picker.test.mjs — the half of emoji.js that only exists in a browser.
 *
 * emoji.test.mjs can reason about the catalogue in plain node, but the picker
 * is DOM and nothing else: a roving tabindex, arrow keys that have to know how
 * wide the grid turned out to be, and a search box that hands focus to the grid
 * and takes it back. None of that has a meaningful non-browser form — a shim
 * would be asserting against the shim — so it is driven in real chromium with
 * the real stylesheet, because the arrow keys read their step size back out of
 * the laid-out grid and a picker with no CSS has one column.
 *
 * The reason to keep this in the suite rather than run it once by hand: the
 * choice a child makes here is written into the op log and replicated, so a
 * picker that quietly picks something nobody pointed at is a data bug, not a
 * cosmetic one.
 *
 * Run: node tests/emoji-picker.test.mjs
 * Needs the scratchpad devDependency (playwright). Nothing here is imported by
 * shipped code.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import { chromium } from "/tmp/claude-0/-home-user-Cousin-Congress/3ed12ed5-f595-5592-93db-45e4895ed3e3/scratchpad/node_modules/playwright/index.mjs";

/** The image on this box is not the revision playwright-core wants; find it. */
function chromiumPath() {
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const build = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .pop();
  const path = build && `${root}/${build}/chrome-linux/chrome`;
  return path && existsSync(path) ? path : undefined;
}

/**
 * The host page puts the picker inside a form on purpose. Enter in a search box
 * is a submit by default, and the members panel this is destined for is a form,
 * so "does Enter navigate away mid-choice" is a question worth being able to
 * answer.
 */
function serveRepo() {
  const root = new URL("..", import.meta.url).pathname;
  const server = createServer((request, response) => {
    const path = request.url.split("?")[0];
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><meta charset=utf-8>
         <link rel=stylesheet href="/css/tokens.css">
         <link rel=stylesheet href="/css/base.css">
         <link rel=stylesheet href="/css/components.css">
         <link rel=stylesheet href="/css/emoji.css">
         <form id="form" action="/submitted"><div id="host"></div></form>
         <div id="spare"></div>`
      );
      return;
    }
    try {
      const body = readFileSync(root + path);
      const type = path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return server;
}

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

const server = serveRepo();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: chromiumPath() });
// Narrow enough that the grid wraps to a handful of columns, which is the case
// the arrow keys actually have to get right.
const page = await browser.newPage({ viewport: { width: 520, height: 700 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
await page.goto(`http://127.0.0.1:${port}/`);

/** Fresh picker in #host, with pick/close spies hung off window. */
const mount = (options = {}) =>
  page.evaluate(async (opts) => {
    const module = window.emoji ?? (window.emoji = await import("/js/emoji.js"));
    const host = document.getElementById("host");
    window.api?.destroy();
    host.replaceChildren();
    window.picked = [];
    window.closeCalls = 0;
    window.closeEvents = 0;
    // Replaces the node, and with it any listener a previous case left behind —
    // counting events on a host that accumulated listeners would read as the
    // picker firing twice.
    const fresh = host.cloneNode(false);
    host.replaceWith(fresh);
    fresh.addEventListener("emoji-picker-close", () => {
      window.closeEvents += 1;
    });
    window.api = module.mountEmojiPicker(fresh, {
      ...opts,
      onPick: (char, entry) => window.picked.push([char, entry ? entry.name : null]),
      onClose: () => {
        window.closeCalls += 1;
      },
    });
    return {
      groups: module.EMOJI_GROUPS.length,
      total: module.EMOJI_GROUPS.flatMap((group) => group.emoji).length,
    };
  }, options);

const input = () => page.locator(".emoji-picker__input");
const options = () => page.locator("[role=option]");
const spy = (fn) => page.evaluate(fn);

/* --------------------------------------------------------------------------
   Structure
   -------------------------------------------------------------------------- */

console.log("Structure");
const catalogue = await mount({ value: "🦊" });
console.log(`  ${catalogue.groups} groups / ${catalogue.total} emoji`);

check((await page.locator("[role=listbox]").count()) === 1, "there should be exactly one listbox");
check((await options().count()) === catalogue.total, "every catalogue entry should be an option");
check(
  (await page.locator("[role=option][aria-selected=true]").count()) === 1,
  "exactly one option should start selected"
);
check(
  (await page.locator("[role=option][aria-selected=true]").getAttribute("data-char")) === "🦊",
  "the selected option should be the value passed in"
);
check(
  (await page.locator("[role=option][tabindex='0']").count()) === 1,
  "a roving tabindex means exactly one option is tabbable"
);

// 44px is the usual floor for a finger; these are for a five-year-old's finger.
const box = await page.locator("[role=option]").first().boundingBox();
check(box.width >= 44 && box.height >= 44, `option is ${box.width}x${box.height}, want >= 44px`);

/* --------------------------------------------------------------------------
   Searching
   -------------------------------------------------------------------------- */

console.log("\nSearch");
await input().fill("pizza");
check((await options().count()) === 1, "'pizza' should filter to a single option");
check(
  (await options().first().getAttribute("data-char")) === "🍕",
  "and the single option should be the pizza"
);

await input().fill("zzzqqq");
check((await options().count()) === 0, "a nonsense query should leave no options");
check(await page.locator(".emoji-picker__empty").isVisible(), "the empty message should show");

// Nothing to move onto: this must be a no-op rather than a throw.
await input().press("ArrowDown");
check(
  (await spy(() => document.activeElement.tagName)) === "INPUT",
  "ArrowDown with no results should leave focus in the search box"
);

await input().fill("");
check((await options().count()) === catalogue.total, "clearing the box should restore every option");

/* --------------------------------------------------------------------------
   Keyboard
   -------------------------------------------------------------------------- */

console.log("\nKeyboard");
await mount({ value: "🦊" });
await input().focus();
await input().press("ArrowDown");
check(
  (await spy(() => document.activeElement.dataset.char)) === "🦊",
  "ArrowDown from the search box should land on the current badge"
);

await page.keyboard.press("ArrowRight");
const afterRight = await spy(() => document.activeElement.dataset.char);
check(afterRight !== "🦊", `ArrowRight should move (stayed on ${afterRight})`);
await page.keyboard.press("ArrowLeft");
check(
  (await spy(() => document.activeElement.dataset.char)) === "🦊",
  "ArrowLeft should come back"
);

await page.keyboard.press("ArrowDown");
const afterDown = await spy(() => document.activeElement.dataset.char);
check(afterDown !== "🦊", `ArrowDown should move a row (stayed on ${afterDown})`);
await page.keyboard.press("ArrowUp");
check(
  (await spy(() => document.activeElement.dataset.char)) === "🦊",
  "ArrowUp should come back to the same badge"
);

await page.keyboard.press("Home");
check(
  (await spy(() => document.activeElement.dataset.char)) ===
    (await options().first().getAttribute("data-char")),
  "Home should go to the first badge"
);
// Off the top row is the documented way back to the search box.
await page.keyboard.press("ArrowUp");
check(
  (await spy(() => document.activeElement.tagName)) === "INPUT",
  "ArrowUp from the top row should return to the search box"
);

await input().press("ArrowDown");
await page.keyboard.press("End");
check(
  (await spy(() => document.activeElement.dataset.char)) ===
    (await options().last().getAttribute("data-char")),
  "End should go to the last badge"
);

await page.keyboard.press("Enter");
check(
  (await spy(() => window.picked.at(-1)?.[0])) === (await options().last().getAttribute("data-char")),
  "Enter should pick the focused badge"
);
check(
  (await page.locator("[role=option][tabindex='0']").count()) === 1,
  "picking should not leave a second tab stop behind"
);

await page.keyboard.press("Space");
check((await spy(() => window.picked.length)) === 2, "Space should pick as well as Enter");

// Typing anywhere in the grid falls through to the search box, so a child never
// has to find it first.
await page.keyboard.press("c");
await page.keyboard.press("a");
await page.keyboard.press("t");
check((await input().inputValue()) === "cat", "typing in the grid should type into the search box");
check(
  (await spy(() => document.activeElement.className.includes("emoji-picker__input"))) === true,
  "and focus should follow into the search box"
);
check(
  (await options().first().getAttribute("data-char")) === "🐱",
  "and the results should be the search results"
);

/* --------------------------------------------------------------------------
   Enter is not a pick unless something was typed

   Regression: Enter on an empty search box used to pick items[0] — whatever the
   catalogue happens to start with — so opening the picker and pressing Enter
   silently committed a badge nobody had pointed at.
   -------------------------------------------------------------------------- */

console.log("\nEnter on an empty search box");
await mount({});
await spy(() => {
  window.submits = 0;
  document.getElementById("form").addEventListener("submit", () => {
    window.submits += 1;
  });
});
await input().focus();
await input().press("Enter");
check((await spy(() => window.picked.length)) === 0, "Enter on an empty query should pick nothing");
check((await spy(() => window.submits)) === 0, "Enter must not submit the surrounding form");
check(page.url().endsWith("/"), "Enter must not navigate away from the page");

await input().fill("pizza");
await input().press("Enter");
check(
  (await spy(() => window.picked.at(-1)?.[0])) === "🍕",
  "Enter on a real query should still take the top match"
);

/* --------------------------------------------------------------------------
   Escape
   -------------------------------------------------------------------------- */

console.log("\nEscape");
await mount({});
await input().fill("cat");
await input().press("Escape");
check((await input().inputValue()) === "", "the first Escape should clear the search");
check((await spy(() => window.closeCalls)) === 0, "the first Escape should not close");

await input().press("Escape");
check((await spy(() => window.closeCalls)) === 1, "the second Escape should call onClose once");
check(
  (await spy(() => window.closeEvents)) === 1,
  "and should dispatch emoji-picker-close exactly once"
);
// The picker cannot close anything itself, so the event has to escape the
// container for whatever sheet owns it.
check(
  (await spy(() => {
    let seen = 0;
    document.addEventListener("emoji-picker-close", () => { seen += 1; }, { once: true });
    const box = document.querySelector(".emoji-picker__input");
    box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return seen;
  })) === 1,
  "the close event should bubble past the container"
);

/* --------------------------------------------------------------------------
   Pointer, surprise, and the selection surviving a repaint
   -------------------------------------------------------------------------- */

console.log("\nPointer and selection");
await mount({ value: "🦊" });
await page.locator("[role=option][data-char='🐼']").click();
check((await spy(() => window.picked.at(-1)?.[0])) === "🐼", "a click should pick");
check(
  (await spy(() => window.picked.at(-1)?.[1])) === "panda",
  "onPick should be handed the catalogue entry as well as the character"
);

// A tap arrives as a click with no coordinates; it must travel the same path.
await page.locator("[role=option][data-char='🚀']").dispatchEvent("click");
check((await spy(() => window.picked.at(-1)?.[0])) === "🚀", "a synthesised tap should pick");

// Picking inside a filtered view then clearing it repaints every option from
// scratch, which is where a selection held only in the DOM would be lost.
await input().fill("pizza");
await page.locator("[role=option][data-char='🍕']").click();
await input().fill("");
check(
  (await page.locator("[role=option][aria-selected=true]").count()) === 1,
  "one option should still be selected after the repaint"
);
check(
  (await page.locator("[role=option][aria-selected=true]").getAttribute("data-char")) === "🍕",
  "and it should be the one picked while the search was open"
);

await page.locator(".emoji-picker__surprise").click();
check(
  (await page.locator("[role=option][aria-selected=true]").count()) === 1,
  "surprise me should leave exactly one selection"
);
check(
  (await page.locator("[role=option][tabindex='0']").count()) === 1,
  "surprise me should leave exactly one tab stop"
);
check((await input().inputValue()) === "", "surprise me should clear any active search");

console.log("\nGroup shortcuts");
await mount({});
await input().fill("cat");
await page.locator(".emoji-picker__jump").nth(2).click();
check((await input().inputValue()) === "", "a group jump should clear an active search");
check((await options().count()) === catalogue.total, "and restore the full grid");
check(
  (await spy(async () => {
    const module = window.emoji;
    return document.activeElement.dataset.char === module.EMOJI_GROUPS[2].emoji[0].char;
  })) === true,
  "and move focus to the first badge of that group"
);

/* --------------------------------------------------------------------------
   Lifecycle
   -------------------------------------------------------------------------- */

console.log("\nLifecycle");
await mount({ value: "🦊" });
check(
  (await spy(() => {
    try {
      window.api.setValue("🦉");
      return document.querySelector("[role=option][aria-selected=true]").dataset.char;
    } catch (error) {
      return "threw: " + error.message;
    }
  })) === "🦉",
  "setValue should move the selection"
);
check(
  (await spy(() => {
    try {
      window.api.destroy();
      window.api.destroy();
      window.api.setValue("🐼");
      return document.querySelectorAll(".emoji-picker").length;
    } catch (error) {
      return "threw: " + error.message;
    }
  })) === 0,
  "destroy should be idempotent and survive a later setValue"
);

// A value that is not in the catalogue is what a stale record looks like after
// the catalogue is edited; it must not leave the grid untabbable.
await mount({ value: "not-a-badge" });
check(
  (await page.locator("[role=option][aria-selected=true]").count()) === 0,
  "an unknown value should select nothing"
);
check(
  (await page.locator("[role=option][tabindex='0']").count()) === 1,
  "but the grid should still have its one tab stop"
);

const subset = await spy(() => {
  const module = window.emoji;
  const host = document.getElementById("spare");
  const api = module.mountEmojiPicker(host, { groups: module.EMOJI_GROUPS.slice(1, 3) });
  const result = {
    options: host.querySelectorAll("[role=option]").length,
    expected: module.EMOJI_GROUPS.slice(1, 3).flatMap((group) => group.emoji).length,
    jumps: host.querySelectorAll(".emoji-picker__jump").length,
  };
  api.destroy();
  return result;
});
check(
  subset.options === subset.expected && subset.jumps === 2,
  `a groups subset rendered ${subset.options}/${subset.expected} options and ${subset.jumps} jumps`
);

check(
  (await spy(() => {
    try {
      window.emoji.mountEmojiPicker(null);
      return "no throw";
    } catch (error) {
      return error.message;
    }
  })) === "mountEmojiPicker needs a container element.",
  "mounting without a container should throw a legible error"
);

// Two live pickers share a page in the members panel; colliding ids would point
// every search label at the first one's grid.
const idCheck = await spy(() => {
  const module = window.emoji;
  document.getElementById("spare").replaceChildren();
  window.api?.destroy();
  module.mountEmojiPicker(document.getElementById("host"), {});
  module.mountEmojiPicker(document.getElementById("spare"), {});
  const all = [...document.querySelectorAll("[id]")].map((node) => node.id);
  return { total: all.length, unique: new Set(all).size };
});
check(
  idCheck.total === idCheck.unique,
  `two pickers produced ${idCheck.total} ids but only ${idCheck.unique} unique`
);

check(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);

/* -------------------------------------------------------------------------- */

await browser.close();
server.close();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("emoji picker: OK");
