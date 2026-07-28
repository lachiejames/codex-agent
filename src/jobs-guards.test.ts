// Behavioural tests for the guards where they actually bite: on a persisted job, from a
// path that is not the `--wait` loop.
//
// The unit tests in guards.test.ts prove the decision. These prove the wiring — that a job
// started in the background is bounded at all, which is the defect this PR exists to fix.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "./config.ts";
import { DEFAULT_STALL_MINUTES } from "./guards.ts";
import { enforceRunGuards, loadJob, refreshJobStatus, saveJob, type Job } from "./jobs.ts";

const MINUTE = 60_000;
const originalJobsDir = config.jobsDir;
const originalJobsIndexFile = config.jobsIndexFile;
const createdSessions: string[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-guards-"));
  config.jobsDir = join(root, ".codex-agent", "jobs");
  config.jobsIndexFile = join(config.jobsDir, "index.json");
  mkdirSync(config.jobsDir, { recursive: true });
});

afterEach(() => {
  for (const session of createdSessions.splice(0)) {
    try {
      execSync(`tmux kill-session -t "${session}" 2>/dev/null`, { stdio: "pipe" });
    } catch {
      // Already gone — the guard under test may well have killed it, which is the point.
    }
  }
  config.jobsDir = originalJobsDir;
  config.jobsIndexFile = originalJobsIndexFile;
});

function agoIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function runningJob(overrides: Partial<Job> & Pick<Job, "id">): Job {
  const job: Job = {
    id: overrides.id,
    status: "running",
    prompt: "Design the retry strategy",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    sandbox: "read-only",
    cwd: "/tmp/project",
    createdAt: agoIso(MINUTE),
    startedAt: agoIso(MINUTE),
    turnState: "working",
    passKind: "plan",
    timeoutMinutes: 45,
    ...overrides,
  };
  saveJob(job);
  return job;
}

/** A real tmux session, so `refreshJobStatus` sees a live job rather than a vanished one. */
function createLiveSession(jobId: string): string {
  const session = `${config.tmuxPrefix}-${jobId}`;
  execSync(`tmux new-session -d -s "${session}" "sleep 600"`, { stdio: "pipe" });
  createdSessions.push(session);
  return session;
}

describe("enforceRunGuards — wall clock on the background path", () => {
  test("kills a job that is past its bound", () => {
    // No --wait anywhere in this test. Before this change nothing would have stopped it.
    runningJob({ id: "wall0001", startedAt: agoIso(46 * MINUTE), timeoutMinutes: 45 });

    const outcome = enforceRunGuards("wall0001");

    expect(outcome?.decision.action).toBe("kill");
    expect(outcome?.decision.reason).toBe("wall_clock");
    expect(loadJob("wall0001")?.status).toBe("failed");
  });

  test("leaves a job inside its bound alone", () => {
    runningJob({ id: "wall0002", startedAt: agoIso(10 * MINUTE), timeoutMinutes: 45 });

    const outcome = enforceRunGuards("wall0002");

    expect(outcome?.decision.action).toBe("continue");
    expect(loadJob("wall0002")?.status).toBe("running");
  });

  test("leaves a diagnosable artifact rather than a bare failure", () => {
    runningJob({ id: "wall0003", startedAt: agoIso(46 * MINUTE), timeoutMinutes: 45 });

    // Injected clock, so the recorded timestamps are asserted exactly rather than merely
    // being non-empty.
    const nowMs = Date.parse("2026-07-29T12:00:00.000Z");
    enforceRunGuards("wall0003", { nowMs });
    const job = loadJob("wall0003");

    expect(job?.breachReason).toBe("wall_clock");
    expect(job?.breachMessage).toContain("wall-clock bound of 45m");
    expect(job?.breachMessage).toContain("codex-agent report wall0003");
    expect(job?.breachAt).toBe("2026-07-29T12:00:00.000Z");
    expect(job?.completedAt).toBe("2026-07-29T12:00:00.000Z");
    expect(job?.timedOut).toBe(true);
    // The error a caller sees must be the breach explanation, not a generic failure.
    expect(job?.error).toBe(job?.breachMessage);
  });

  test("ignores a job that is not running", () => {
    const job = runningJob({ id: "wall0004", startedAt: agoIso(90 * MINUTE) });
    job.status = "completed";
    saveJob(job);

    expect(enforceRunGuards("wall0004")).toBeNull();
  });

  test("ignores an unbounded job rather than inventing a bound", () => {
    runningJob({ id: "wall0005", startedAt: agoIso(600 * MINUTE), timeoutMinutes: undefined });

    expect(enforceRunGuards("wall0005")?.decision.action).toBe("continue");
  });
});

describe("enforceRunGuards — the stall window survives separate processes", () => {
  test("accumulates flat time across calls and then stops the run", () => {
    // Each observation on the background path happens in a different short-lived CLI
    // process, so the stall window has to be persisted or it would restart every time.
    const startedAt = Date.now() - 5 * MINUTE;
    runningJob({
      id: "stall001",
      startedAt: new Date(startedAt).toISOString(),
      timeoutMinutes: 600,
    });
    // A log that exists and never changes is what a hung session looks like. Without a log
    // at all there is no liveness evidence, and the backstop deliberately does not fire on
    // absent evidence.
    writeFileSync(join(config.jobsDir, "stall001.log"), "opened, then nothing");

    const first = enforceRunGuards("stall001", { nowMs: startedAt });
    expect(first?.decision.action).toBe("continue");
    expect(loadJob("stall001")?.progress?.lastProgressAtMs).toBe(startedAt);

    // Still inside the window.
    const second = enforceRunGuards("stall001", {
      nowMs: startedAt + (DEFAULT_STALL_MINUTES - 1) * MINUTE,
    });
    expect(second?.decision.action).toBe("continue");

    // Past it, with nothing having moved.
    const third = enforceRunGuards("stall001", {
      nowMs: startedAt + DEFAULT_STALL_MINUTES * MINUTE,
    });
    expect(third?.decision.action).toBe("kill");
    expect(third?.decision.reason).toBe("stalled");
    expect(loadJob("stall001")?.breachReason).toBe("stalled");
  });

  test("does not accumulate stall time when the log does not resolve at all", () => {
    // Regression on an adversarial finding: if the log is unlinked or rotated after Codex
    // opens it, Codex keeps appending to the nameless inode while stat on the path returns
    // nothing forever. Reading that as "flat" would kill a working run, so a missing log
    // contributes no stall time — the wall clock still bounds the job.
    const startedAt = Date.now() - 5 * MINUTE;
    runningJob({
      id: "stall003",
      startedAt: new Date(startedAt).toISOString(),
      timeoutMinutes: 600,
    });

    enforceRunGuards("stall003", { nowMs: startedAt });
    const later = enforceRunGuards("stall003", {
      nowMs: startedAt + 10 * DEFAULT_STALL_MINUTES * MINUTE,
    });

    expect(later?.decision.action).toBe("continue");
  });

  test("a growing log resets the window", () => {
    const startedAt = Date.now() - 5 * MINUTE;
    runningJob({
      id: "stall002",
      startedAt: new Date(startedAt).toISOString(),
      timeoutMinutes: 600,
    });
    const logPath = join(config.jobsDir, "stall002.log");
    writeFileSync(logPath, "thinking...");

    enforceRunGuards("stall002", { nowMs: startedAt });

    // Output arrived, so the run is working however long it takes.
    writeFileSync(logPath, "thinking... and more output arrived");
    const later = enforceRunGuards("stall002", {
      nowMs: startedAt + (DEFAULT_STALL_MINUTES - 1) * MINUTE,
    });
    expect(later?.decision.action).toBe("continue");

    const evenLater = enforceRunGuards("stall002", {
      nowMs: startedAt + (2 * DEFAULT_STALL_MINUTES - 2) * MINUTE,
    });
    expect(evenLater?.decision.action).toBe("continue");
  });
});

describe("enforceRunGuards — reaping is opt-in", () => {
  test("does not close an idle background job, which may be a conversation", () => {
    runningJob({ id: "reap0001", turnState: "idle", passKind: "plan", timeoutMinutes: 45 });

    const outcome = enforceRunGuards("reap0001");

    expect(outcome?.decision.action).toBe("continue");
    expect(loadJob("reap0001")?.status).toBe("running");
  });

  test("closes an idle job when the caller asked it to conclude", () => {
    runningJob({ id: "reap0002", turnState: "idle", passKind: "plan", timeoutMinutes: 45 });

    const outcome = enforceRunGuards("reap0002", { reapWhenAnswered: true });

    expect(outcome?.decision.action).toBe("reap");
  });

  test("reaps a verification pass only once a verdict exists", () => {
    runningJob({
      id: "reap0003",
      turnState: "idle",
      passKind: "review",
      timeoutMinutes: 10,
      lastAgentMessage: "I looked but found nothing conclusive.",
    });

    expect(enforceRunGuards("reap0003", { reapWhenAnswered: true })?.decision.action).toBe(
      "continue"
    );

    // Now the verdict lands, in the durable answer file rather than the truncated preview.
    writeFileSync(
      join(config.jobsDir, "reap0003.answer.md"),
      "=== codex-agent answer | turn t1 | 2026-07-29T00:00:00.000Z ===\nIt double-posts.\n\nVERDICT: BROKEN\n"
    );

    const outcome = enforceRunGuards("reap0003", { reapWhenAnswered: true });
    expect(outcome?.decision.action).toBe("reap");
    expect(loadJob("reap0003")?.verdict).toBe("BROKEN");
  });
});

describe("a verdict is never lost by a later turn", () => {
  // Regression on a defect an adversarial pass found: resolving the verdict from only the
  // LATEST persisted answer meant a verdict reached on turn 1 went invisible once a turn 2
  // without one arrived. The run then read as unanswered, ran to its bound, and was
  // recorded as a wall-clock breach — a concluded run scored as a failure.
  function writeTurns(jobId: string, texts: string[]): void {
    writeFileSync(
      join(config.jobsDir, `${jobId}.answer.md`),
      texts
        .map(
          (text, index) =>
            `=== codex-agent answer | turn t${index + 1} | 2026-07-29T00:0${index}:00.000Z ===\n${text}\n`
        )
        .join("\n")
    );
  }

  test("finds a verdict from an earlier turn and reaps instead of breaching", () => {
    writeTurns("verdict01", ["It double-posts.\n\nVERDICT: BROKEN", "Some follow-up prose, no verdict."]);
    runningJob({
      id: "verdict01",
      passKind: "review",
      turnState: "idle",
      startedAt: agoIso(46 * MINUTE),
      timeoutMinutes: 45,
    });

    const outcome = enforceRunGuards("verdict01", { reapWhenAnswered: true });

    expect(outcome?.decision.action).toBe("reap");
    expect(outcome?.decision.reason).toBeNull();
    expect(loadJob("verdict01")?.breachReason ?? null).toBeNull();
  });

  test("promotes a discovered verdict onto the job on a plain observation", () => {
    // Without this, the verdict was only copied onto the job when the run was reaped, so a
    // background job's verdict stayed dependent on the answer file being re-parsed.
    writeTurns("verdict02", ["Looks fine.\n\nVERDICT: CLEAN"]);
    runningJob({ id: "verdict02", passKind: "review", timeoutMinutes: 45 });

    enforceRunGuards("verdict02");

    expect(loadJob("verdict02")?.verdict).toBe("CLEAN");
  });

  test("prefers the most recent verdict when several turns have one", () => {
    writeTurns("verdict03", ["VERDICT: CLEAN", "On a second look.\n\nVERDICT: BROKEN"]);
    runningJob({ id: "verdict03", passKind: "review", timeoutMinutes: 45 });

    enforceRunGuards("verdict03");

    expect(loadJob("verdict03")?.verdict).toBe("BROKEN");
  });
});

describe("refreshJobStatus applies the guards", () => {
  // The load-bearing claim of this PR: `status`, `jobs` and `await-turn` all route through
  // refreshJobStatus, so simply observing an over-budget job stops it. Uses a real tmux
  // session, because the guard is only reached when the session is genuinely alive.
  test("stops an over-budget job with a live session", () => {
    const jobId = "refresh01";
    createLiveSession(jobId);
    runningJob({
      id: jobId,
      startedAt: agoIso(46 * MINUTE),
      timeoutMinutes: 45,
      tmuxSession: `${config.tmuxPrefix}-${jobId}`,
    });

    const job = refreshJobStatus(jobId);

    expect(job?.status).toBe("failed");
    expect(job?.breachReason).toBe("wall_clock");
  });

  test("leaves an in-budget job with a live session running", () => {
    const jobId = "refresh02";
    createLiveSession(jobId);
    runningJob({
      id: jobId,
      startedAt: agoIso(2 * MINUTE),
      timeoutMinutes: 45,
      tmuxSession: `${config.tmuxPrefix}-${jobId}`,
    });

    const job = refreshJobStatus(jobId);

    expect(job?.status).toBe("running");
    expect(job?.breachReason ?? null).toBeNull();
  });
});
