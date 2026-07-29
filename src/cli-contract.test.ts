// End-to-end tests for what the CLI prints and what it exits with.
//
// These spawn the real `src/cli.ts` as a subprocess with HOME pointed at a temporary directory,
// so the records under test sit exactly where a caller's `~/.codex-agent/jobs` would hold them
// and the CLI reaches them through its own `listRuns`/`loadRun`. Nothing here spawns Codex: every
// launch uses --dry-run, and every observing command reads fixtures written by hand.
//
// The old version of this file tested the tmux-era `Job`: orchestration_state, turnState,
// index.json, session staleness. None of those concepts exist any more. What survived the
// transport change is the part that was never about tmux — a caller must be able to see what a
// run is doing, retrieve its answer, and tell a usable result from a failed one by exit code.
//
// FIXTURES ARE WRITTEN BY EXPLICIT PATH, NOT BY `saveRun`. `config.jobsDir` is computed from
// `process.env.HOME` when config.ts is first imported, which in THIS process is the developer's
// real home — so calling `saveRun` here would deposit test runs in it. `createRun` is pure, so
// the record is still built by the same constructor the CLI uses and type-checked against `Run`,
// which is what stops a hand-written fixture drifting from the real shape.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { emptyMetrics, type StreamMetrics } from "./event-stream.ts";
import { createRun, RUN_ARTIFACTS, RUN_SCHEMA_VERSION, type Run } from "./run-store.ts";

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-agent-cli-contract-"));
  mkdirSync(join(home, ".codex-agent", "jobs"), { recursive: true });
  return home;
}

function jobsDir(home: string): string {
  return join(home, ".codex-agent", "jobs");
}

function metricsFixture(overrides: Partial<StreamMetrics> = {}): StreamMetrics {
  return { ...emptyMetrics(), ...overrides };
}

/**
 * Write a run record into a temporary home and return it.
 *
 * Defaults describe the ordinary case this tool exists for: a scoped review at xhigh, read-only,
 * with a 10-minute bound the caller stated.
 */
function writeRun(home: string, overrides: Partial<Run> & Pick<Run, "id">): Run {
  const run: Run = {
    ...createRun({
      bypass: null,
      cwd: "/tmp/project",
      id: overrides.id,
      model: "gpt-5.6-sol",
      passKind: "review",
      prompt: "PROPERTY: no message is delivered twice",
      reasoningEffort: "xhigh",
      requiresVerdict: true,
      sandbox: "read-only",
      scoped: true,
      timeoutMinutes: 10,
    }),
    ...overrides,
  };

  writeFileSync(join(jobsDir(home), `${run.id}${RUN_ARTIFACTS.record}`), JSON.stringify(run, null, 2));
  return run;
}

function writeAnswer(home: string, runId: string, turnId: string, timestamp: string, text: string): void {
  writeFileSync(
    join(jobsDir(home), `${runId}${RUN_ARTIFACTS.answers}`),
    `=== codex-agent answer | turn ${turnId} | ${timestamp} ===\n${text}\n\n`,
  );
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(home: string, args: string[]): CliResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "src/cli.ts", ...args],
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  };
}

/** A finished review whose every displayed field is fixed, so its output can be asserted whole. */
function completedReview(home: string, id: string): Run {
  return writeRun(home, {
    completedAt: "2026-07-29T00:00:51.000Z",
    id,
    invocations: [
      { endedAt: "2026-07-29T00:00:51.000Z", exitCode: 0, index: 0, startedAt: "2026-07-29T00:00:00.000Z" },
    ],
    // Deliberately ungrouped numbers: `toLocaleString` would render 31,000 differently under a
    // different locale, and a test that fails on a French CI runner tests the runner, not the CLI.
    metrics: metricsFixture({ cumulativeInputTokens: 700, execCount: 4, tokensSpent: 900, turnsCompleted: 1 }),
    startedAt: "2026-07-29T00:00:00.000Z",
    status: "completed",
    threadId: "thread-abc",
    verdict: "CLEAN",
  });
}

describe("status", () => {
  test("reports the run, its bound, its thread, its supervisor and its progress", () => {
    const home = makeHome();
    completedReview(home, "statusrun");

    const result = runCli(home, ["status", "statusrun"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "Run:        statusrun",
      "Status:     completed",
      "Progress:   completed · 51s · 4 execs · 900 spent · VERDICT: CLEAN",
      "Bound:      10m per turn",
      "Thread:     thread-abc",
      // The supervisor is a process, and a finished run's is gone. Saying so is the point: a
      // run held open by a dead supervisor is the failure mode `refreshRun` exists to catch.
      "Supervisor: - (gone)",
      "Turns:      1 completed, 1 invocations",
    ]);
  });

  test("names the bound that stopped a run, and the reason", () => {
    const home = makeHome();
    writeRun(home, {
      breachMessage: "bound of 10m reached after 10m — stopping.",
      breachReason: "wall_clock",
      completedAt: "2026-07-29T00:10:00.000Z",
      error: "bound of 10m reached after 10m — stopping.",
      id: "breached",
      startedAt: "2026-07-29T00:00:00.000Z",
      status: "failed",
    });

    const result = runCli(home, ["status", "breached"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status:     failed");
    expect(result.stdout).toContain("Stopped:    bound of 10m reached after 10m — stopping.");
  });

  test("--json emits the versioned wrapper and the whole run record", () => {
    const home = makeHome();
    const written = completedReview(home, "statusjson");

    const result = runCli(home, ["status", "--json", "statusjson"]);
    const payload: unknown = JSON.parse(result.stdout);
    if (typeof payload !== "object" || payload === null) throw new Error("status --json did not emit an object");
    const body = payload as { schema_version: unknown; run: Run };

    expect(result.exitCode).toBe(0);
    expect(body.schema_version).toBe(RUN_SCHEMA_VERSION);
    expect(body.run).toEqual(written);
  });

  test("an unknown id is an operational failure, not an empty success", () => {
    const home = makeHome();

    const result = runCli(home, ["status", "nosuchrun"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Run nosuchrun not found");
  });
});

describe("await", () => {
  test("returns immediately for a run whose turn has concluded", () => {
    const home = makeHome();
    completedReview(home, "settled");

    const result = runCli(home, ["await", "settled"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("completed · 51s · 4 execs · 900 spent · VERDICT: CLEAN");
  });

  test("exits 4 for a failed run, so a caller cannot mistake it for a result", () => {
    const home = makeHome();
    writeRun(home, {
      breachMessage: "bound of 10m reached after 10m — stopping.",
      breachReason: "wall_clock",
      completedAt: "2026-07-29T00:10:00.000Z",
      id: "died",
      startedAt: "2026-07-29T00:00:00.000Z",
      status: "failed",
      verdict: null,
    });

    const result = runCli(home, ["await", "died"]);

    expect(result.exitCode).toBe(4);
  });

  test("keeps polling a running run until its record says the turn concluded", async () => {
    const home = makeHome();
    // A generous bound and a turn that has only just started, so no observer-enforced kill can
    // fire while the test is waiting. The supervisor pid is absent on purpose: that is the
    // unowned-run path, and inside the bound it must be left alone rather than shot.
    writeRun(home, {
      id: "inflight",
      startedAt: new Date().toISOString(),
      status: "running",
      timeoutMinutes: 60,
      turnStartedAt: new Date().toISOString(),
    });

    const proc = Bun.spawn({
      cmd: [process.execPath, "src/cli.ts", "await", "inflight"],
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });

    setTimeout(() => {
      writeRun(home, {
        id: "inflight",
        startedAt: new Date().toISOString(),
        status: "waiting",
        timeoutMinutes: 60,
      });
    }, 100);

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(exitCode).toBe(0);
    // The elapsed segment of a run that has not completed is measured against the wall clock, so
    // the assertions bracket it rather than pretending it is fixed.
    expect(stdout.trim().startsWith("waiting · ")).toBe(true);
    expect(stdout).toContain("0 execs");
    expect(stdout).toContain("spend not reported yet");
  });
});

describe("report", () => {
  test("prints what was asked, what came back, and the verdict — and exits 0", () => {
    const home = makeHome();
    completedReview(home, "goodrun");
    writeAnswer(home, "goodrun", "t1", "2026-07-29T00:00:51.000Z", "Found a double-post.\n\nVERDICT: CLEAN");

    const result = runCli(home, ["report", "goodrun"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Report for job goodrun");
    expect(result.stdout).toContain("--- Asked ---");
    expect(result.stdout).toContain("PROPERTY: no message is delivered twice");
    expect(result.stdout).toContain("--- Answer ---");
    expect(result.stdout).toContain("Found a double-post.");
    expect(result.stdout).toContain("Judgement: usable result — Concluded with VERDICT: CLEAN.");
  });

  test("a run stopped at its bound exits 4 and says so, rather than looking empty", () => {
    const home = makeHome();
    writeRun(home, {
      breachMessage: "bound of 10m reached after 10m — stopping.",
      breachReason: "wall_clock",
      completedAt: "2026-07-29T00:10:00.000Z",
      id: "burned",
      startedAt: "2026-07-29T00:00:00.000Z",
      status: "failed",
      verdict: null,
    });

    const result = runCli(home, ["report", "burned"]);

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toContain("Judgement: FAILED RUN — Killed at its wall-clock bound without concluding.");
    expect(result.stdout).toContain("--- Why it was stopped ---");
    expect(result.stdout).toContain("bound of 10m reached after 10m");
    expect(result.stdout).toContain("killed:wall_clock");
  });

  test("a verification pass that answered without a verdict is a failed run", () => {
    const home = makeHome();
    writeRun(home, {
      completedAt: "2026-07-29T00:05:00.000Z",
      id: "noverdict",
      startedAt: "2026-07-29T00:00:00.000Z",
      status: "completed",
      verdict: null,
    });
    writeAnswer(home, "noverdict", "t1", "2026-07-29T00:05:00.000Z", "I looked at a lot of things and I am unsure.");

    const result = runCli(home, ["report", "noverdict"]);

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toContain("No VERDICT line.");
  });

  test("--json emits a versioned envelope around the report", () => {
    const home = makeHome();
    completedReview(home, "reportjson");
    writeAnswer(home, "reportjson", "t1", "2026-07-29T00:00:51.000Z", "Fine.\n\nVERDICT: CLEAN");

    const result = runCli(home, ["report", "--json", "reportjson"]);
    const payload: unknown = JSON.parse(result.stdout);
    if (typeof payload !== "object" || payload === null) throw new Error("report --json did not emit an object");
    const body = payload as { schema_version: unknown; report: { jobId: unknown; judgement: { failed: unknown } } };

    expect(result.exitCode).toBe(0);
    expect(body.schema_version).toBe("codex-agent.report.v2");
    expect(body.report.jobId).toBe("reportjson");
    expect(body.report.judgement.failed).toBe(false);
  });
});

describe("runs", () => {
  test("lists newest first with status, pass, execs and verdict", () => {
    const home = makeHome();
    writeRun(home, { createdAt: "2026-07-29T00:00:00.000Z", id: "older", status: "completed", verdict: "CLEAN" });
    writeRun(home, { createdAt: "2026-07-29T01:00:00.000Z", id: "newer", status: "waiting" });

    const result = runCli(home, ["runs"]);
    const rows = result.stdout.trim().split("\n").slice(2);

    expect(result.exitCode).toBe(0);
    expect(rows).toEqual([
      "newer     waiting    review            0 -         PROPERTY: no message is delivered twice",
      "older     completed  review            0 CLEAN     PROPERTY: no message is delivered twice",
    ]);
  });

  test("says so plainly when there are none", () => {
    const result = runCli(makeHome(), ["runs"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("No runs");
  });

  test("--json emits a versioned envelope", () => {
    const home = makeHome();
    writeRun(home, { id: "onlyrun" });

    const result = runCli(home, ["runs", "--json"]);
    const payload: unknown = JSON.parse(result.stdout);
    if (typeof payload !== "object" || payload === null) throw new Error("runs --json did not emit an object");
    const body = payload as { schema_version: unknown; runs: Run[] };

    expect(result.exitCode).toBe(0);
    expect(body.schema_version).toBe("codex-agent.runs.v1");
    expect(body.runs.map((run) => run.id)).toEqual(["onlyrun"]);
  });
});

describe("ledger", () => {
  test("shows spend and cumulative input as two columns, never one blurred total", () => {
    const home = makeHome();
    completedReview(home, "ledgerrun");

    const result = runCli(home, ["ledger"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SPENT");
    expect(result.stdout).toContain("CUM-IN");
    // The single "TOKENS" column is what let true spend and cumulative input blur together and
    // report 4.4x apart on near-identical jobs.
    expect(result.stdout).not.toContain("TOKENS");
    expect(result.stdout).toContain("ledgerrun");
    expect(result.stdout).toContain("CLEAN");
  });

  test("--json carries spend and cumulative input as distinct fields on every row", () => {
    const home = makeHome();
    completedReview(home, "ledgerjson");

    const result = runCli(home, ["ledger", "--json"]);
    const payload: unknown = JSON.parse(result.stdout);
    if (typeof payload !== "object" || payload === null) throw new Error("ledger --json did not emit an object");
    const body = payload as { schema_version: unknown; runs: Array<Record<string, unknown>> };

    expect(result.exitCode).toBe(0);
    expect(body.schema_version).toBe("codex-agent.ledger.v3");
    expect(body.runs).toHaveLength(1);
    for (const row of body.runs) {
      expect(row).not.toHaveProperty("totalTokens");
      expect(row["tokensSpent"]).toBe(900);
      expect(row["cumulativeInputTokens"]).toBe(700);
    }
  });

  test("counts the verification runs that produced no verdict", () => {
    const home = makeHome();
    completedReview(home, "concluded");
    writeRun(home, {
      completedAt: "2026-07-29T00:10:00.000Z",
      id: "unconcluded",
      startedAt: "2026-07-29T00:00:00.000Z",
      status: "failed",
      verdict: null,
    });

    const result = runCli(home, ["ledger"]);

    expect(result.stdout).toContain("1/2 verification runs produced no verdict.");
  });
});

describe("clean", () => {
  test("expires runs past the retention window and leaves the fresh ones", () => {
    const home = makeHome();
    writeRun(home, {
      completedAt: "2020-01-01T00:00:00.000Z",
      createdAt: "2020-01-01T00:00:00.000Z",
      id: "ancient",
      status: "completed",
    });
    writeRun(home, { id: "current", status: "waiting" });

    const cleaned = runCli(home, ["clean"]);
    const remaining = runCli(home, ["runs", "--json"]);
    const payload: unknown = JSON.parse(remaining.stdout);
    if (typeof payload !== "object" || payload === null) throw new Error("runs --json did not emit an object");
    const body = payload as { runs: Run[] };

    expect(cleaned.exitCode).toBe(0);
    expect(cleaned.stdout.trim()).toBe("Removed 1 runs older than 7 days, freeing 0 MB");
    expect(body.runs.map((run) => run.id)).toEqual(["current"]);
  });
});

describe("start --dry-run", () => {
  test("prints the prompt accounting and the resolved profile without spawning anything", () => {
    const home = makeHome();
    const cwd = mkdtempSync(join(tmpdir(), "codex-agent-dry-run-"));
    mkdirSync(join(cwd, "docs"));
    writeFileSync(
      join(cwd, "docs", "CODEBASE_MAP.md"),
      ["---", "total_tokens: 9,094", "---", "", "# Map", "Small body."].join("\n"),
    );

    const result = runCli(home, ["start", "Build it", "--map", "--timeout", "7", "--dry-run", "-d", cwd]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Model: gpt-5.6-sol");
    expect(result.stdout).toContain("Reasoning: xhigh");
    expect(result.stdout).toContain("Sandbox: read-only");
    expect(result.stdout).toContain("Pass: plan (");
    expect(result.stdout).toContain("Scoped by stdin: no");
    expect(result.stdout).toContain("Bypass: none");
    expect(result.stdout).toContain("Bound: 7m per turn");
    expect(result.stdout).toContain("--- Prompt Preview ---");
    // The map is injected, and which file was injected is reported — the whole point of `--map`
    // after the lookup was found to be able to report a path that did not exist on disk.
    expect(result.stdout).toContain("## Codebase Map");
    expect(result.stderr).toContain(`docs${sep}CODEBASE_MAP.md (~`);

    // Nothing was launched, so nothing is listed.
    expect(runCli(home, ["runs"]).stdout.trim()).toBe("No runs");
  });

  test("says which directory it searched when there is no map", () => {
    const home = makeHome();
    const cwd = mkdtempSync(join(tmpdir(), "codex-agent-no-map-"));

    const result = runCli(home, ["start", "Build it", "--map", "--timeout", "7", "--dry-run", "-d", cwd]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`No codebase map found under ${cwd}`);
    expect(result.stdout).not.toContain("## Codebase Map");
  });
});

describe("unknown commands", () => {
  test("a typo is a message, not a bounded-but-real spend", () => {
    // `codex-agent repot abc123` used to fall through and launch the typo as a prompt.
    const result = runCli(makeHome(), ["repot", "abc123"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: repot");
  });
});
