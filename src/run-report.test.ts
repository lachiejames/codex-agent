import { describe, expect, it } from "bun:test";
import { emptyMetrics } from "./event-stream.ts";
import { computeDurationMs, formatProgressLine, mapRunLedger, mapRunReport } from "./run-report.ts";
import { RUN_SCHEMA_VERSION, type Run } from "./run-store.ts";

// A fixed clock. The whole reason the mapping functions take `nowMs` is that a duration derived
// from a live clock cannot be asserted exactly — so before this split the ledger's DURATION
// column, which exists to measure runs against their bound, had no exact test anywhere.
const NOW = Date.parse("2026-07-29T12:10:00.000Z");

const BASE: Run = {
  boundRearmedCount: 0,
  breachMessage: null,
  breachReason: null,
  bypass: null,
  createdAt: "2026-07-29T12:00:00.000Z",
  cwd: "/repo",
  error: null,
  id: "abc12345",
  invocations: [{ index: 0, startedAt: "2026-07-29T12:00:00.000Z" }],
  metrics: emptyMetrics(),
  model: "gpt-5.6-sol",
  passKind: "review",
  prompt: "check one thing",
  reasoningEffort: "xhigh",
  requiresVerdict: true,
  sandbox: "read-only",
  schemaVersion: RUN_SCHEMA_VERSION,
  scoped: true,
  startedAt: "2026-07-29T12:00:00.000Z",
  status: "running",
  streamOffset: 0,
  timeoutMinutes: 10,
  verdict: null,
  warned: false,
};

function run(overrides: Partial<Run> = {}): Run {
  return { ...BASE, ...overrides };
}

describe("computeDurationMs", () => {
  it("measures an in-flight run against the supplied clock, exactly", () => {
    expect(computeDurationMs(run(), NOW)).toBe(600_000);
  });

  it("measures a finished run between its own timestamps, ignoring the clock", () => {
    expect(computeDurationMs(run({ completedAt: "2026-07-29T12:04:00.000Z" }), NOW)).toBe(240_000);
  });

  it("prefers startedAt over createdAt", () => {
    expect(computeDurationMs(run({ startedAt: "2026-07-29T12:06:00.000Z" }), NOW)).toBe(240_000);
  });

  it("falls back to createdAt when the run never started", () => {
    // `startedAt` is optional rather than nullable, so the absent case is genuinely absent.
    const { startedAt, ...unstarted } = BASE;
    expect(computeDurationMs(unstarted, NOW)).toBe(600_000);
  });

  it("never reports a negative duration when the clock is behind the start", () => {
    expect(computeDurationMs(run(), Date.parse("2026-07-29T11:00:00.000Z"))).toBe(0);
  });

  it("returns null for an unparseable timestamp rather than a wrong number", () => {
    expect(computeDurationMs(run({ startedAt: "not a date" }), NOW)).toBe(null);
    expect(computeDurationMs(run({ completedAt: "not a date" }), NOW)).toBe(null);
  });
});

describe("mapRunLedger", () => {
  it("reports the two token quantities separately, never substituting one for the other", () => {
    const measured = run({
      metrics: { ...emptyMetrics(), cumulativeInputTokens: 4_201_735, tokensSpent: 4_229_913 },
    });
    const ledger = mapRunLedger(measured, NOW);
    expect(ledger.tokensSpent).toBe(4_229_913);
    expect(ledger.cumulativeInputTokens).toBe(4_201_735);
  });

  // A null here means NOT MEASURED. It must stay null rather than becoming a zero, because the
  // ledger prints `-` for it and a zero would read as a free run.
  it("keeps an unmeasured spend null", () => {
    const ledger = mapRunLedger(run(), NOW);
    expect(ledger.tokensSpent).toBe(null);
    expect(ledger.cumulativeInputTokens).toBe(null);
  });

  it("sets timedOut only for a wall_clock breach, not for a stall", () => {
    expect(mapRunLedger(run({ breachReason: "wall_clock" }), NOW).timedOut).toBe(true);
    expect(mapRunLedger(run({ breachReason: "stalled" }), NOW).timedOut).toBe(false);
    expect(mapRunLedger(run(), NOW).timedOut).toBe(false);
  });

  it("reports verdictProduced from the verdict's presence", () => {
    expect(mapRunLedger(run(), NOW).verdictProduced).toBe(false);
    expect(mapRunLedger(run({ verdict: "CLEAN" }), NOW).verdictProduced).toBe(true);
  });

  it("carries the run id through as the ledger's job id", () => {
    expect(mapRunLedger(run(), NOW).jobId).toBe("abc12345");
  });
});

describe("mapRunReport", () => {
  const answered = [{ text: "VERDICT: CLEAN", timestamp: "2026-07-29T12:04:00.000Z", turnId: "t1" }];

  it("maps a concluded run with a verdict onto a usable report", () => {
    const concluded = run({ completedAt: "2026-07-29T12:04:00.000Z", status: "waiting", verdict: "CLEAN" });
    const report = mapRunReport(concluded, answered, NOW);

    expect(report.jobId).toBe("abc12345");
    expect(report.asked).toBe("check one thing");
    expect(report.answers).toEqual(answered);
    expect(report.answersTruncated).toBe(false);
    expect(report.judgement.failed).toBe(false);
    // `RunReport.ledger` is nullable on the shape; a null would make this undefined and fail.
    expect(report.ledger?.durationMs).toBe(240_000);
  });

  // The exit-4 case: a verdict-requiring pass that concluded without one is not a usable result.
  it("judges a verdict-requiring run that produced no verdict as failed", () => {
    const concluded = run({ completedAt: "2026-07-29T12:04:00.000Z", status: "waiting" });
    const plain = [{ text: "I looked at some things", timestamp: "2026-07-29T12:04:00.000Z", turnId: "t1" }];
    expect(mapRunReport(concluded, plain, NOW).judgement.failed).toBe(true);
  });

  it("reports no answers when none were stored", () => {
    const report = mapRunReport(run({ status: "waiting" }), [], NOW);
    expect(report.answers).toEqual([]);
    expect(report.judgement.failed).toBe(true);
  });

  it("maps every run status onto the report vocabulary", () => {
    expect(mapRunReport(run({ status: "starting" }), [], NOW).status).toBe("pending");
    expect(mapRunReport(run({ status: "running" }), [], NOW).status).toBe("running");
    expect(mapRunReport(run({ status: "failed" }), [], NOW).status).toBe("failed");
    expect(mapRunReport(run({ status: "waiting" }), [], NOW).status).toBe("completed");
    expect(mapRunReport(run({ status: "completed" }), [], NOW).status).toBe("completed");
  });

  it("embeds exactly the ledger row it would have built on its own", () => {
    const concluded = run({ completedAt: "2026-07-29T12:04:00.000Z", status: "waiting", verdict: "CLEAN" });
    expect(mapRunReport(concluded, answered, NOW).ledger).toEqual(mapRunLedger(concluded, NOW));
  });
});

describe("formatProgressLine", () => {
  it("renders status, exact elapsed, execs and the unmeasured-spend wording", () => {
    expect(formatProgressLine(run(), NOW)).toBe("running · 10m · 0 execs · spend not reported yet");
  });

  it("renders a measured spend with thousands separators", () => {
    const measured = run({ metrics: { ...emptyMetrics(), execCount: 34, tokensSpent: 4_229_913 } });
    expect(formatProgressLine(measured, NOW)).toBe("running · 10m · 34 execs · 4,229,913 spent");
  });

  it("appends the last command, truncated to 60 characters", () => {
    const busy = run({ metrics: { ...emptyMetrics(), lastCommand: "x".repeat(80) } });
    expect(formatProgressLine(busy, NOW)).toBe(
      `running · 10m · 0 execs · spend not reported yet · last: ${"x".repeat(60)}`,
    );
  });

  it("appends the verdict once one exists", () => {
    const done = run({ status: "waiting", verdict: "BROKEN" });
    expect(formatProgressLine(done, NOW)).toBe("waiting · 10m · 0 execs · spend not reported yet · VERDICT: BROKEN");
  });
});
