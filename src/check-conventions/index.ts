#!/usr/bin/env bun

/**
 * check-conventions/index.ts
 *
 * The effectful shell: walk the tree, read the files, print, exit. Every rule lives in core.ts
 * and is unit-tested there with direct calls. Deliberately shaped like
 * src/check-test-discipline/index.ts — two checkers with the same job should not have two
 * different skeletons.
 *
 *   bun run check:conventions
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { formatFindings, type SourceInput, scanConventions } from "./core.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;

    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * Production sources only.
 *
 * Tests are excluded from the length rule for the same reason the reference repo excludes them:
 * a table-driven test body is a list of cases, and splitting it to satisfy a line count makes it
 * harder to read, not easier. They are still covered by check-test-discipline, biome and oxlint.
 */
function isProductionSource(relativePath: string): boolean {
  return relativePath.endsWith(".ts") && !relativePath.endsWith(".test.ts");
}

function main(): number {
  const inputs: SourceInput[] = [];

  for (const path of walk(join(REPO_ROOT, "src"))) {
    const relativePath = relative(REPO_ROOT, path);
    if (!isProductionSource(relativePath)) continue;
    inputs.push({ path: relativePath, text: readFileSync(path, "utf-8") });
  }

  // Same reasoning as the sibling checker: a checker that finds no files looks exactly like a
  // checker that passes. An empty scan is a bug in the checker, not a clean tree.
  if (inputs.length === 0) {
    process.stderr.write("check-conventions: found no production sources to scan. That is a bug in the checker.\n");
    return 1;
  }

  const findings = scanConventions(inputs);
  if (findings.length === 0) {
    process.stdout.write(`${formatFindings(findings, inputs.length)}\n`);
    return 0;
  }

  process.stderr.write(`${formatFindings(findings, inputs.length)}\n`);
  process.stderr.write(
    "\nThese are conventions no linter here checks. The function-length rule takes an inline\n" +
      "`// max-lines-exempt: <reason>` above the function — a marker with no reason is not an\n" +
      "exemption. The other two take none: a bare builtin import has a one-word fix, and a\n" +
      "duplicated exported function means one of the two copies is about to drift.\n",
  );
  return 1;
}

process.exit(main());
