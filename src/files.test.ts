// The map lookup must give the same answer on a case-insensitive filesystem (macOS APFS)
// and a case-sensitive one (the Linux CI runner these tests also run on).
//
// That is the whole point: the old lookup used `readFileSync` on literal candidate paths, so
// `docs/ARCHITECTURE.md` opened `docs/architecture.md` on macOS and nothing on Linux — same
// command, different prompt, no warning. These tests therefore assert on the RESOLVED PATH,
// not merely on whether something was found, because "found something" was never the bug.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseEntry, findCodebaseMap, loadCodebaseMap } from "./files.ts";

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

// No filesystem probing, no skips, no deferring anything to CI. The behaviour that differs
// between case-sensitive and case-insensitive filesystems is `chooseEntry`, which takes a
// directory listing as data — so it is tested directly, and every test in this file runs on
// every machine.

describe("findCodebaseMap — candidate priority", () => {
  test("prefers docs/CODEBASE_MAP.md", async () => {
    const expected = writeMap("docs/CODEBASE_MAP.md", "# canonical");
    writeMap("CODEBASE_MAP.md", "# root");

    expect((await findCodebaseMap(root))?.path).toBe(expected);
  });

  test("falls back to a root CODEBASE_MAP.md", async () => {
    const expected = writeMap("CODEBASE_MAP.md", "# root");

    expect((await findCodebaseMap(root))?.path).toBe(expected);
  });

  // `docs/ARCHITECTURE.md` was an inherited third candidate and is deliberately gone. A repo
  // with no codebase map but any architecture document would otherwise have that document —
  // a different artifact, for a different audience — silently injected into a planning prompt.
  test("does NOT fall back to an architecture document", async () => {
    writeMap("docs/ARCHITECTURE.md", "# fallback");

    expect(await findCodebaseMap(root)).toBeNull();
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
  // The measured defect. A repo carrying a lowercase filename and none of the exact canonical
  // candidates silently matched the uppercase candidate on macOS's case-insensitive APFS and
  // injected content nobody chose, while reporting a path that did not exist on disk.
  const lowercaseCases: Array<{ name: string; file: string }> = [
    { file: "docs/codebase_map.md", name: "lowercase docs/codebase_map.md" },
    { file: "codebase_map.md", name: "lowercase root codebase_map.md" },
    { file: "docs/Codebase_Map.md", name: "mixed-case docs/Codebase_Map.md" },
    { file: "docs/CODEBASE_MAP.MD", name: "shouty docs/CODEBASE_MAP.MD" },
    { file: "CODEBASE_map.md", name: "mixed-case root CODEBASE_map.md" },
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
    { file: "Docs/CODEBASE_MAP.md", name: "Docs/CODEBASE_MAP.md" },
    { file: "DOCS/codebase_map.md", name: "DOCS/codebase_map.md" },
    { file: "codebase_map.md", name: "Doc-less root codebase_map.md" },
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
    const expected = writeMap("CODEBASE_MAP.md", "# real map");

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
    "docs/codebase_map.md",
    "Docs/CODEBASE_MAP.md",
    "DOCS/Codebase_Map.MD",
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
    // The third adversarial finding: real directory `Repo`, called as `repo`. A mis-cased cwd
    // opens on a case-insensitive filesystem and does not on a case-sensitive one, so the
    // requirement is stated as one unconditional assertion that holds on both: whatever comes
    // back is either nothing or canonical. Never a path carrying the casing that was asked
    // for. No branch on the platform, so nothing silently does nothing.
    writeMap("docs/CODEBASE_MAP.md", "# map");
    const found = await findCodebaseMap(root.toUpperCase());

    expect(found === null || found.path === realpathSync.native(found.path)).toBe(true);
  });
});

describe("chooseEntry", () => {
  // Two entries differing only by case cannot coexist on a case-insensitive filesystem, so
  // these used to be filesystem tests that skipped on macOS and only really ran in CI. The
  // decision is data in, decision out — so it is tested as such, everywhere.

  test("matches ignoring case", () => {
    expect(chooseEntry({ entries: ["architecture.md"], wantedName: "ARCHITECTURE.md" })).toEqual({
      chosen: "architecture.md",
      others: [],
    });
  });

  test("returns null when nothing matches", () => {
    expect(chooseEntry({ entries: ["README.md", "docs"], wantedName: "CODEBASE_MAP.md" })).toBeNull();
  });

  test("returns null for an empty listing", () => {
    expect(chooseEntry({ entries: [], wantedName: "CODEBASE_MAP.md" })).toBeNull();
  });

  test("prefers the exact-case entry and names the variants it ignored", () => {
    expect(
      chooseEntry({
        entries: ["architecture.md", "ARCHITECTURE.md", "Architecture.md"],
        wantedName: "ARCHITECTURE.md",
      }),
    ).toEqual({ chosen: "ARCHITECTURE.md", others: ["Architecture.md", "architecture.md"] });
  });

  test("picks lexicographically when no variant matches exactly", () => {
    // Deterministic rather than dependent on directory iteration order, which is why the
    // listing below is deliberately not sorted.
    expect(
      chooseEntry({
        entries: ["architecture.md", "Architecture.md"],
        wantedName: "ARCHITECTURE.md",
      }),
    ).toEqual({ chosen: "Architecture.md", others: ["architecture.md"] });
  });

  test("is not affected by the order entries arrive in", () => {
    const forwards = chooseEntry({
      entries: ["Architecture.md", "architecture.md"],
      wantedName: "ARCHITECTURE.md",
    });
    const backwards = chooseEntry({
      entries: ["architecture.md", "Architecture.md"],
      wantedName: "ARCHITECTURE.md",
    });
    expect(forwards).toEqual(backwards);
  });

  test("ignores entries that merely contain the wanted name", () => {
    expect(
      chooseEntry({ entries: ["CODEBASE_MAP.md.bak", "old-CODEBASE_MAP.md"], wantedName: "CODEBASE_MAP.md" }),
    ).toBeNull();
  });

  test("reports no ambiguity for a single match", () => {
    expect(chooseEntry({ entries: ["docs", "CODEBASE_MAP.md"], wantedName: "CODEBASE_MAP.md" })?.others).toEqual([]);
  });
});

describe("findCodebaseMap — ambiguity", () => {
  test("reports no ambiguity in the ordinary single-file case", async () => {
    writeMap("docs/CODEBASE_MAP.md", "# canonical");
    expect((await findCodebaseMap(root))?.ambiguousWith).toEqual([]);
  });
});
