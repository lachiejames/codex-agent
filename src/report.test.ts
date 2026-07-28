import { describe, expect, test } from "bun:test";
import { formatRunReport, judgeRun, type JudgementInput, type RunReport } from "./report.ts";
import type { RunLedger } from "./contract.ts";

function judgementInput(overrides: Partial<JudgementInput> = {}): JudgementInput {
  return {
    passKind: "review",
    requiresVerdict: true,
    status: "completed",
    verdict: "CLEAN",
    breachReason: null,
    hasAnswer: true,
    ...overrides,
  };
}

describe("judgeRun", () => {
  test("a verdict is a usable result", () => {
    const judgement = judgeRun(judgementInput());
    expect(judgement.failed).toBe(false);
    expect(judgement.summary).toContain("CLEAN");
    expect(judgement.remedy).toBe("");
  });

  test("a plan with an answer is a usable result even with no verdict", () => {
    // Job f343761d: this is the run written off as a total loss. It answered, and a plan
    // pass requires no verdict, so it must not be graded as a failure.
    const judgement = judgeRun(
      judgementInput({ passKind: "plan", requiresVerdict: false, verdict: null })
    );
    expect(judgement.failed).toBe(false);
    expect(judgement.summary).toContain("requires no verdict");
  });

  test("a verdict pass with no verdict is a failed run", () => {
    const judgement = judgeRun(judgementInput({ verdict: null }));
    expect(judgement.failed).toBe(true);
    expect(judgement.summary).toContain("VERDICT");
    expect(judgement.remedy).toContain("Do not raise the timeout first");
  });

  test("a run with nothing persisted is a failed run", () => {
    const judgement = judgeRun(
      judgementInput({ passKind: "plan", requiresVerdict: false, verdict: null, hasAnswer: false })
    );
    expect(judgement.failed).toBe(true);
    expect(judgement.summary).toContain("No answer");
  });

  // Breach reasons must win over "no verdict", and must be distinguishable from each
  // other — reporting a blocked run as non-convergence sends the reader to narrow a
  // question that was never reached.
  const breachCases: Array<{ reason: NonNullable<JudgementInput["breachReason"]>; expect: string }> = [
    { reason: "blocked", expect: "never started work" },
    { reason: "wall_clock", expect: "wall-clock bound" },
    { reason: "stalled", expect: "flat-lined" },
  ];

  for (const testCase of breachCases) {
    test(`reports a ${testCase.reason} breach specifically`, () => {
      const judgement = judgeRun(judgementInput({ verdict: null, breachReason: testCase.reason }));
      expect(judgement.failed).toBe(true);
      expect(judgement.summary).toContain(testCase.expect);
      expect(judgement.remedy.length).toBeGreaterThan(0);
    });
  }

  test("a breach outranks a produced verdict's remedy advice", () => {
    // A run killed while blocked cannot have concluded, so the blocked explanation stands.
    const judgement = judgeRun(judgementInput({ breachReason: "blocked" }));
    expect(judgement.summary).toContain("blocked");
  });

  test("does not tell a blocked run to narrow its question", () => {
    const judgement = judgeRun(judgementInput({ verdict: null, breachReason: "blocked" }));
    expect(judgement.remedy).toContain("Do not narrow the question");
  });
});

function ledgerFixture(overrides: Partial<RunLedger> = {}): RunLedger {
  return {
    jobId: "abc12345",
    passKind: "review",
    reasoning: "xhigh",
    model: "gpt-5.6-sol",
    durationMs: 51_000,
    tokensSpent: 31_000,
    cumulativeInputTokens: 45_000,
    execCount: 0,
    verdict: "BROKEN",
    verdictProduced: true,
    scoped: true,
    bypass: null,
    timedOut: false,
    breachReason: null,
    ...overrides,
  };
}

function reportFixture(overrides: Partial<RunReport> = {}): RunReport {
  return {
    jobId: "abc12345",
    passKind: "review",
    status: "completed",
    asked: "PROPERTY: no message is delivered twice",
    answers: [{ turnId: "t1", timestamp: "2026-07-29T00:00:00.000Z", text: "Found it.\n\nVERDICT: BROKEN" }],
    answersTruncated: false,
    ledger: ledgerFixture(),
    judgement: judgeRun(judgementInput({ verdict: "BROKEN" })),
    breachMessage: null,
    promptPath: "/tmp/jobs/abc12345.prompt",
    ...overrides,
  };
}

describe("formatRunReport", () => {
  test("answers the three questions: asked, came back, judgement", () => {
    const text = formatRunReport(reportFixture());
    expect(text).toContain("--- Asked ---");
    expect(text).toContain("no message is delivered twice");
    expect(text).toContain("--- Answer ---");
    expect(text).toContain("VERDICT: BROKEN");
    expect(text).toContain("Judgement: usable result");
    expect(text).toContain("--- Ledger ---");
  });

  test("shows the answer untruncated", () => {
    const long = "y".repeat(9_000);
    const text = formatRunReport(
      reportFixture({ answers: [{ turnId: "t1", timestamp: "now", text: long }] })
    );
    expect(text).toContain(long);
  });

  test("truncates the prompt and says where the rest is", () => {
    // A review prompt carries the whole diff; the recorded ones run to 84KB.
    const text = formatRunReport(reportFixture({ asked: "d".repeat(50_000) }));
    expect(text).toContain("more characters");
    expect(text).toContain("/tmp/jobs/abc12345.prompt");
    expect(text.length).toBeLessThan(20_000);
  });

  test("labels a legacy truncated preview as such", () => {
    const text = formatRunReport(reportFixture({ answersTruncated: true }));
    expect(text).toContain("truncated preview only");
    expect(text).toContain("not recoverable");
  });

  test("explains an empty answer rather than leaving a blank section", () => {
    const text = formatRunReport(reportFixture({ answers: [], answersTruncated: false }));
    expect(text).toContain("nothing persisted");
    expect(text).toContain("never finished a turn");
  });

  test("surfaces why a run was stopped", () => {
    const text = formatRunReport(
      reportFixture({
        breachMessage: "wall-clock bound of 45m reached after 45m",
        ledger: ledgerFixture({ verdict: null, verdictProduced: false, breachReason: "wall_clock" }),
        judgement: judgeRun(judgementInput({ verdict: null, breachReason: "wall_clock" })),
      })
    );
    expect(text).toContain("--- Why it was stopped ---");
    expect(text).toContain("wall-clock bound of 45m");
    expect(text).toContain("killed:wall_clock");
    expect(text).toContain("FAILED RUN");
  });

  test("numbers the turns of a conversation", () => {
    const text = formatRunReport(
      reportFixture({
        answers: [
          { turnId: "t1", timestamp: "2026-07-29T00:00:00.000Z", text: "first" },
          { turnId: "t2", timestamp: "2026-07-29T00:05:00.000Z", text: "second" },
        ],
      })
    );
    expect(text).toContain("turn 1 of 2");
    expect(text).toContain("turn 2 of 2");
  });

  test("tolerates a job with no ledger and no prompt", () => {
    const text = formatRunReport(reportFixture({ ledger: null, asked: "", promptPath: null }));
    expect(text).toContain("the prompt was not recorded");
    expect(text).not.toContain("--- Ledger ---");
  });
});
