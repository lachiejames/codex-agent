import { describe, expect, test } from "bun:test";
import type { RunLedger } from "./contract.ts";
import { formatRunReport, type JudgementInput, judgeRun, type RunReport } from "./report.ts";

function judgementInput(overrides: Partial<JudgementInput> = {}): JudgementInput {
  return {
    breachReason: null,
    hasAnswer: true,
    passKind: "review",
    requiresVerdict: true,
    status: "completed",
    verdict: "CLEAN",
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
    const judgement = judgeRun(judgementInput({ passKind: "plan", requiresVerdict: false, verdict: null }));
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
      judgementInput({ hasAnswer: false, passKind: "plan", requiresVerdict: false, verdict: null }),
    );
    expect(judgement.failed).toBe(true);
    expect(judgement.summary).toContain("No answer");
  });

  // Breach reasons must win over "no verdict", and must be distinguishable from each other —
  // a stalled run reported as non-convergence sends the reader to narrow a question that was
  // never the problem.
  //
  // There used to be a third case, `blocked`, plus two tests specifically about it. It is gone
  // with the tmux transport: `codex exec` exits non-zero in about a second with the reason on
  // stderr rather than sitting on an interactive prompt, so no run can be killed for being
  // blocked and `KillReason` no longer spells it.
  const breachCases: Array<{ reason: NonNullable<JudgementInput["breachReason"]>; expect: string }> = [
    { expect: "wall-clock bound", reason: "wall_clock" },
    { expect: "flat-lined", reason: "stalled" },
  ];

  for (const testCase of breachCases) {
    test(`reports a ${testCase.reason} breach specifically`, () => {
      const judgement = judgeRun(judgementInput({ breachReason: testCase.reason, verdict: null }));
      expect(judgement.failed).toBe(true);
      expect(judgement.summary).toContain(testCase.expect);
      expect(judgement.remedy.length).toBeGreaterThan(0);
    });
  }

  test("a breach outranks a produced verdict", () => {
    // A run killed at its bound cannot have concluded, so the breach explanation stands even
    // when a verdict token is somehow present on the record.
    const judgement = judgeRun(judgementInput({ breachReason: "wall_clock" }));
    expect(judgement.failed).toBe(true);
    expect(judgement.summary).toBe("Killed at its wall-clock bound without concluding.");
  });

  test("tells a stalled run to read its stream and its stderr, not to narrow the question", () => {
    const judgement = judgeRun(judgementInput({ breachReason: "stalled", verdict: null }));
    expect(judgement.remedy).toContain("codex-agent tail <id>");
    expect(judgement.remedy).toContain(".stderr");
    expect(judgement.remedy).not.toContain("Narrow");
  });
});

function ledgerFixture(overrides: Partial<RunLedger> = {}): RunLedger {
  return {
    breachReason: null,
    bypass: null,
    cumulativeInputTokens: 45_000,
    durationMs: 51_000,
    execCount: 0,
    jobId: "abc12345",
    model: "gpt-5.6-sol",
    passKind: "review",
    reasoning: "xhigh",
    scoped: true,
    timedOut: false,
    tokensSpent: 31_000,
    verdict: "BROKEN",
    verdictProduced: true,
    ...overrides,
  };
}

function reportFixture(overrides: Partial<RunReport> = {}): RunReport {
  return {
    answers: [{ text: "Found it.\n\nVERDICT: BROKEN", timestamp: "2026-07-29T00:00:00.000Z", turnId: "t1" }],
    answersTruncated: false,
    asked: "PROPERTY: no message is delivered twice",
    breachMessage: null,
    jobId: "abc12345",
    judgement: judgeRun(judgementInput({ verdict: "BROKEN" })),
    ledger: ledgerFixture(),
    passKind: "review",
    promptPath: "/tmp/jobs/abc12345.prompt",
    status: "completed",
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
    const text = formatRunReport(reportFixture({ answers: [{ text: long, timestamp: "now", turnId: "t1" }] }));
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
        judgement: judgeRun(judgementInput({ breachReason: "wall_clock", verdict: null })),
        ledger: ledgerFixture({ breachReason: "wall_clock", verdict: null, verdictProduced: false }),
      }),
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
          { text: "first", timestamp: "2026-07-29T00:00:00.000Z", turnId: "t1" },
          { text: "second", timestamp: "2026-07-29T00:05:00.000Z", turnId: "t2" },
        ],
      }),
    );
    expect(text).toContain("turn 1 of 2");
    expect(text).toContain("turn 2 of 2");
  });

  test("tolerates a job with no ledger and no prompt", () => {
    const text = formatRunReport(reportFixture({ asked: "", ledger: null, promptPath: null }));
    expect(text).toContain("the prompt was not recorded");
    expect(text).not.toContain("--- Ledger ---");
  });
});
