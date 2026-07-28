// The map lookup must give the same answer on a case-insensitive filesystem (macOS APFS)
// and a case-sensitive one (the Linux CI runner these tests also run on).
//
// That is the whole point: the old lookup used `readFileSync` on literal candidate paths, so
// `docs/ARCHITECTURE.md` opened `docs/architecture.md` on macOS and nothing on Linux — same
// command, different prompt, no warning. These tests therefore assert on the RESOLVED PATH,
// not merely on whether something was found, because "found something" was never the bug.

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { findCodebaseMap, loadCodebaseMap } from "./files.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-agent-map-"));
});

/**
 * Write a fixture and return its CANONICAL path.
 *
 * `mkdtemp` hands back `/var/folders/...` on macOS, which is a symlink to `/private/var/...`,
 * so the canonical form is what the lookup reports and what these tests must expect.
 */
function writeMap(relativePath: string, content: string): string {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return realpathSync.native(full);
}

/**
 * Whether this filesystem is case-insensitive, probed once at load.
 *
 * The ambiguity cases cannot be constructed on a case-insensitive filesystem — the second
 * write lands on the same inode — so they are skipped there via `test.skipIf`, which the
 * runner reports. An early `return` inside the test body would have made them silently pass,
 * which is the same "reports success, did nothing" failure this PR exists to remove.
 *
 * On Linux CI these run for real, which is precisely why they are worth having.
 */
const CASE_INSENSITIVE_FS = (() => {
  const probeRoot = mkdtempSync(join(tmpdir(), "codex-agent-case-probe-"));
  writeFileSync(join(probeRoot, "CaseProbe.md"), "probe");
  return existsSync(join(probeRoot, "caseprobe.md"));
})();

describe("findCodebaseMap — candidate priority", () => {
  test("prefers docs/CODEBASE_MAP.md", async () => {
    const expected = writeMap("docs/CODEBASE_MAP.md", "# canonical");
    writeMap("CODEBASE_MAP.md", "# root");
    writeMap("docs/ARCHITECTURE.md", "# fallback");

    expect((await findCodebaseMap(root))?.path).toBe(expected);
  });

  test("falls back to a root CODEBASE_MAP.md", async () => {
    const expected = writeMap("CODEBASE_MAP.md", "# root");
    writeMap("docs/ARCHITECTURE.md", "# fallback");

    expect((await findCodebaseMap(root))?.path).toBe(expected);
  });

  test("falls back to docs/ARCHITECTURE.md last", async () => {
    const expected = writeMap("docs/ARCHITECTURE.md", "# fallback");
    expect((await findCodebaseMap(root))?.path).toBe(expected);
  });

  test("returns null when nothing matches", async () => {
    writeMap("docs/DESIGN.md", "# unrelated");
    writeMap("readme.md", "# unrelated");

    expect(await findCodebaseMap(root)).toBeNull();
    expect(await loadCodebaseMap(root)).toBeNull();
  });

  test("returns null for a repo with no docs directory at all", async () => {
    expect(await findCodebaseMap(root)).toBeNull();
  });
});

describe("findCodebaseMap — case independence", () => {
  // The measured defect. Slopweaver has `docs/architecture.md` and none of the three
  // canonical candidates; on macOS it silently matched the uppercase candidate and injected
  // ~6KB nobody chose, while reporting a path that did not exist.
  const lowercaseCases: Array<{ name: string; file: string }> = [
    { name: "lowercase docs/architecture.md", file: "docs/architecture.md" },
    { name: "lowercase docs/codebase_map.md", file: "docs/codebase_map.md" },
    { name: "lowercase root codebase_map.md", file: "codebase_map.md" },
    { name: "mixed-case docs/Architecture.md", file: "docs/Architecture.md" },
    { name: "shouty docs/ARCHITECTURE.MD", file: "docs/ARCHITECTURE.MD" },
  ];

  for (const testCase of lowercaseCases) {
    test(`finds ${testCase.name} and reports the real path`, async () => {
      const expected = writeMap(testCase.file, "# map");
      const found = await findCodebaseMap(root);

      expect(found).not.toBeNull();
      // The path must be the entry that is actually on disk, not the casing that was asked
      // for. Reporting a fabricated path is what made the accounting line a lie.
      expect(found?.path).toBe(expected);
      expect(found?.content).toBe("# map");
    });
  }

  // The DIRECTORY component counts too. An adversarial pass caught the first fix doing only
  // the basename: `Docs/CODEBASE_MAP.md` resolved through the requested `docs` on macOS,
  // reported a fabricated directory casing, and found nothing on Linux.
  const directoryCases: Array<{ name: string; file: string }> = [
    { name: "Docs/CODEBASE_MAP.md", file: "Docs/CODEBASE_MAP.md" },
    { name: "DOCS/architecture.md", file: "DOCS/architecture.md" },
    { name: "Doc-less root codebase_map.md", file: "codebase_map.md" },
  ];

  for (const testCase of directoryCases) {
    test(`resolves the directory casing too: ${testCase.name}`, async () => {
      const expected = writeMap(testCase.file, "# map");
      const found = await findCodebaseMap(root);

      expect(found).not.toBeNull();
      expect(found?.path).toBe(expected);
    });
  }

  test("a file where a directory is expected does not match", async () => {
    // `docs` as a regular file must not satisfy the `docs/` segment.
    writeMap("docs", "not a directory");
    expect(await findCodebaseMap(root)).toBeNull();
  });

  test("a directory named like a map is not a map", async () => {
    mkdirSync(join(root, "docs", "CODEBASE_MAP.md"), { recursive: true });
    const expected = writeMap("docs/architecture.md", "# real map");

    expect((await findCodebaseMap(root))?.path).toBe(expected);
  });
});

describe("INVARIANT: the reported path is the one the filesystem reports", () => {
  // Holds on both platforms and covers the class rather than one casing at a time: whatever
  // `findCodebaseMap` returns must equal its own canonical form. A fabricated casing —
  // in the filename, an intermediate directory, or the caller-supplied cwd prefix — fails
  // this, and all three were real defects found by successive adversarial passes.
  const layouts = [
    "docs/CODEBASE_MAP.md",
    "CODEBASE_MAP.md",
    "docs/architecture.md",
    "Docs/CODEBASE_MAP.md",
    "DOCS/Architecture.MD",
  ];

  for (const layout of layouts) {
    test(`canonical for ${layout}`, async () => {
      writeMap(layout, "# map");
      const found = await findCodebaseMap(root);

      expect(found).not.toBeNull();
      expect(found!.path).toBe(realpathSync.native(found!.path));
    });
  }

  test("canonical even when the caller supplies a mis-cased cwd", async () => {
    // The third adversarial finding: real directory `Repo`, called as `repo`. Only
    // constructible on a case-insensitive filesystem, where the mis-cased cwd still opens.
    if (!CASE_INSENSITIVE_FS) return;

    const expected = writeMap("docs/CODEBASE_MAP.md", "# map");
    const found = await findCodebaseMap(root.toUpperCase());

    // Either it does not resolve at all, or it resolves to the real path — never to a path
    // carrying the casing that was asked for.
    if (found) expect(found.path).toBe(expected);
  });
});

describe("findCodebaseMap — ambiguity is deterministic and reported", () => {
  test.skipIf(CASE_INSENSITIVE_FS)("prefers the exact-case candidate and names the variant it ignored", async () => {
    const exact = writeMap("docs/ARCHITECTURE.md", "# shouty");
    const variant = writeMap("docs/architecture.md", "# quiet");

    const found = await findCodebaseMap(root);
    expect(found?.path).toBe(exact);
    expect(found?.content).toBe("# shouty");
    expect(found?.ambiguousWith).toEqual([variant]);
  });

  test.skipIf(CASE_INSENSITIVE_FS)("picks lexicographically when no variant matches the candidate exactly", async () => {
    writeMap("docs/Architecture.md", "# title case");
    writeMap("docs/architecture.md", "# quiet");

    const found = await findCodebaseMap(root);
    // Deterministic rather than dependent on directory iteration order.
    expect(found?.path).toBe(join(root, "docs", "Architecture.md"));
    expect(found?.ambiguousWith).toEqual([join(root, "docs", "architecture.md")]);
  });

  test("reports no ambiguity in the ordinary single-file case", async () => {
    writeMap("docs/CODEBASE_MAP.md", "# canonical");
    expect((await findCodebaseMap(root))?.ambiguousWith).toEqual([]);
  });
});
