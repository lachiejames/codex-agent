// The archive must expire, or `clean` frees nothing.
//
// deleteJob does not delete — it moves artifacts into jobs/.trash/<stamp>-<pid>-<id>/ so a
// mistaken delete stays recoverable. Nothing ever emptied that directory, so it grew
// without bound: 699 MB across 964 files, while `codex-agent clean` reported jobs
// "cleaned" and freed no disk at all. Recoverability is worth keeping, so the archive
// expires rather than disappearing.

import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "./config.ts";
import { purgeArchivedJobs } from "./jobs.ts";

const originalJobsDir = config.jobsDir;
const originalIndex = config.jobsIndexFile;

let root: string;
let trashRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-agent-purge-"));
  config.jobsDir = join(root, "jobs");
  config.jobsIndexFile = join(config.jobsDir, "index.json");
  trashRoot = join(config.jobsDir, ".trash");
  mkdirSync(trashRoot, { recursive: true });
});

afterEach(() => {
  config.jobsDir = originalJobsDir;
  config.jobsIndexFile = originalIndex;
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** An archived job entry whose mtime is `daysAgo` in the past. */
function archiveEntry({ name, daysAgo, bytes }: { name: string; daysAgo: number; bytes: number }): string {
  const dir = join(trashRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job.log"), "x".repeat(bytes));

  const when = new Date(Date.now() - daysAgo * DAY_MS);
  utimesSync(dir, when, when);
  return dir;
}

describe("expiring archived jobs", () => {
  test("removes entries older than the retention window", () => {
    const old = archiveEntry({ name: "2026-01-01-old", daysAgo: 30, bytes: 1024 });

    const result = purgeArchivedJobs(7);

    expect(result.entriesPurged).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  test("keeps entries inside the window, so a mistaken delete stays recoverable", () => {
    const recent = archiveEntry({ name: "2026-07-27-recent", daysAgo: 1, bytes: 1024 });

    const result = purgeArchivedJobs(7);

    expect(result.entriesPurged).toBe(0);
    expect(existsSync(recent)).toBe(true);
  });

  test("reports the bytes freed, which is what was silently zero before", () => {
    archiveEntry({ name: "a", daysAgo: 30, bytes: 4096 });
    archiveEntry({ name: "b", daysAgo: 30, bytes: 2048 });

    const result = purgeArchivedJobs(7);

    expect(result.entriesPurged).toBe(2);
    expect(result.bytesFreed).toBe(6144);
  });

  test("purges only the old entries when the archive is mixed", () => {
    const old = archiveEntry({ name: "old", daysAgo: 14, bytes: 512 });
    const fresh = archiveEntry({ name: "fresh", daysAgo: 2, bytes: 512 });

    const result = purgeArchivedJobs(7);

    expect(result.entriesPurged).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("an absent archive is not an error", () => {
    config.jobsDir = join(root, "nonexistent");

    const result = purgeArchivedJobs(7);

    expect(result.entriesPurged).toBe(0);
    expect(result.bytesFreed).toBe(0);
  });

  test("an empty archive purges nothing", () => {
    const result = purgeArchivedJobs(7);

    expect(result.entriesPurged).toBe(0);
    expect(result.bytesFreed).toBe(0);
  });

  test("a longer window keeps entries a shorter one would expire", () => {
    archiveEntry({ name: "tenDaysOld", daysAgo: 10, bytes: 128 });

    expect(purgeArchivedJobs(30).entriesPurged).toBe(0);
    expect(purgeArchivedJobs(7).entriesPurged).toBe(1);
  });
});
