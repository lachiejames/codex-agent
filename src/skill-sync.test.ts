// Drift guard for the copied skill.
//
// The Claude-side skill cannot be delivered as a plugin: an enterprise
// strictKnownMarketplaces policy refuses every source, including a local directory, a
// private GitHub repo, and ~/.claude/skills. So it is COPIED into each consuming repo
// at .claude/skills/codex-agent/SKILL.md.
//
// Copies drift. That is precisely the failure this fork exists to end — the CLI and the
// plugin previously lived in two independent clones, and every edit landed in one and
// not the other, silently. The handover's requirement was: if copies, make drift
// impossible or loud. This makes it loud, on every `bun test`.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

interface SkillTargets {
  source: string;
  targets: string[];
}

const repoRoot = join(import.meta.dir, "..");
const config: SkillTargets = JSON.parse(
  readFileSync(join(repoRoot, "skill-targets.json"), "utf-8"),
);

const SKILL_RELATIVE_PATH = join(".claude", "skills", "codex-agent", "SKILL.md");

function copyPath(target: string): string {
  return join(homedir(), target, SKILL_RELATIVE_PATH);
}

describe("copied skill stays in sync with its source", () => {
  const sourcePath = join(repoRoot, config.source);

  test("the source skill exists where the config says it does", () => {
    expect(existsSync(sourcePath)).toBe(true);
  });

  test("the source names itself as the source of truth", () => {
    // Every copy inherits this header, so whoever opens a copy is told where to edit.
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).toContain("SOURCE OF TRUTH");
    expect(source).toContain("sync-skill.sh");
  });

  test("at least one target is configured", () => {
    expect(config.targets.length).toBeGreaterThan(0);
  });

  // One test per target, so a failure names the repo that drifted.
  for (const target of config.targets) {
    test(`${target} copy is byte-identical to the source`, () => {
      const repoPresent = existsSync(join(homedir(), target));
      if (!repoPresent) {
        // The same target list is used across machines; a repo that is not checked out
        // here is not a drift failure.
        return;
      }

      const path = copyPath(target);
      expect(
        existsSync(path),
        `${target} is checked out but has no skill copy. Run: bash scripts/sync-skill.sh`,
      ).toBe(true);

      const source = readFileSync(sourcePath, "utf-8");
      const copy = readFileSync(path, "utf-8");

      expect(
        copy === source,
        `${target} copy has drifted from the source. Do not edit copies — edit ` +
          `${config.source} and run: bash scripts/sync-skill.sh`,
      ).toBe(true);
    });
  }
});
