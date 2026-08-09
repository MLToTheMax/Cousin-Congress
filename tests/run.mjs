#!/usr/bin/env node
/**
 * tests/run.mjs — the whole suite in one command: `node tests/run.mjs`.
 *
 * Runs every unit/conformance suite (tests/*.test.mjs) and every adversarial
 * suite (tests/attacks/*.attack.mjs), reports a tally, and exits non-zero if
 * anything failed. Pure Node, no test framework — the same no-dependencies
 * rule the app itself follows.
 */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const unit = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => join(here, f));

const attacksDir = join(here, "attacks");
let attacks = [];
try {
  attacks = readdirSync(attacksDir)
    .filter((f) => f.endsWith(".attack.mjs"))
    .map((f) => join(attacksDir, f));
} catch {
  /* no attacks directory — fine */
}

const all = [...unit, ...attacks];
let passed = 0;
const failed = [];

for (const file of all) {
  const rel = file.slice(here.length + 1);
  const res = spawnSync(process.execPath, [file], { encoding: "utf8" });
  if (res.status === 0) {
    passed += 1;
    console.log(`\x1b[32mPASS\x1b[0m ${rel}`);
  } else {
    failed.push(rel);
    console.log(`\x1b[31mFAIL\x1b[0m ${rel}`);
    process.stdout.write(
      (res.stdout || "").split("\n").slice(-6).join("\n") + "\n" + (res.stderr || "").split("\n").slice(-6).join("\n") + "\n"
    );
  }
}

console.log(`\n${passed}/${all.length} suites passed` + (failed.length ? ` — failed: ${failed.join(", ")}` : " ✓"));
process.exit(failed.length ? 1 : 0);
