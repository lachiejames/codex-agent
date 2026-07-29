#!/usr/bin/env bun

/**
 * check-test-discipline/index.ts
 *
 * The effectful shell: walk the tree, read the files, print, exit. Every rule lives in core.ts
 * and is unit-tested there with direct calls. This file has no logic worth testing, which is the
 * point of the split.
 *
 *   bun run check:tests
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { formatViolations, isTestFile, scanTestFile, type Violation } from "./core.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;

    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

function main(): number {
  const violations: Violation[] = [];
  let scanned = 0;

  for (const path of walk(join(REPO_ROOT, "src"))) {
    const relativePath = relative(REPO_ROOT, path);
    if (!isTestFile(relativePath)) continue;

    scanned += 1;
    violations.push(...scanTestFile({ content: readFileSync(path, "utf-8"), relativePath }));
  }

  // A checker that finds no files is indistinguishable from a checker that passes, and this one
  // guards the test suite — so an empty scan is a failure, not a pass.
  if (scanned === 0) {
    process.stderr.write("check-test-discipline: found no test files to scan. That is a bug in the checker.\n");
    return 1;
  }

  if (violations.length === 0) {
    process.stdout.write(`check-test-discipline: ${scanned} test files clean.\n`);
    return 0;
  }

  process.stderr.write(formatViolations(violations));
  process.stderr.write(
    "\nThese rules are not style. A test that does not run reports as coverage while proving\n" +
      "nothing, and a weakened assertion turns a red test green without turning a bug into a fix.\n" +
      "If a rule is genuinely wrong for a case, the weak-assertion family takes a same-line\n" +
      "`// weak-ok: <reason>`. Disabled tests and mocks take no exception at all.\n",
  );
  return 1;
}

process.exit(main());
