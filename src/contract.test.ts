import { describe, expect, test } from "bun:test";
import { config } from "./config.ts";
import {
  countEnumeratedChecks,
  DEFAULT_HEARTBEAT_EXECS,
  DEFAULT_HEARTBEAT_MINUTES,
  evaluateContract,
  evaluateHeartbeat,
  extractVerdict,
  formatLedgerRow,
  formatOutcome,
  isPassKind,
  LEDGER_HEADER,
  looksLikeVerification,
  PASS_PROFILES,
  type RunLedger,
  resolvePassKind,
  shapeVerificationPrompt,
} from "./contract.ts";

const MINUTE = 60_000;

describe("verification classification", () => {
  test("recognises the words that describe a verification pass", () => {
    for (const prompt of [
      "Review the auth changes",
      "Please verify this migration is safe",
      "Security audit of the new endpoint",
      "Critique this approach",
      "Sanity check the retry logic",
      "double-check the token refresh",
    ]) {
      expect(looksLikeVerification(prompt)).toBe(true);
    }
  });

  test("does not fire on words that merely contain a trigger substring", () => {
    // Substring matching would classify these as reviews and demand a diff for work
    // that is not verification at all.
    for (const prompt of [
      "Add a preview pane to the dashboard",
      "Wire up the auditorium booking form",
      "Implement revietnamese localisation",
    ]) {
      expect(looksLikeVerification(prompt)).toBe(false);
    }
  });

  test("an explicit --pass always beats inference", () => {
    expect(resolvePassKind("Review this", null)).toBe("review");
    expect(resolvePassKind("Review this", "plan")).toBe("plan");
    expect(resolvePassKind("Build a cache", null)).toBe("plan");
    expect(resolvePassKind("Build a cache", "adversarial")).toBe("adversarial");
  });

  test("isPassKind rejects unknown kinds", () => {
    expect(isPassKind("review")).toBe(true);
    expect(isPassKind("nonsense")).toBe(false);
  });
});

describe("counting enumerated checks", () => {
  test("counts dash, star, and numbered list items", () => {
    const prompt = [
      "Security review. Check:",
      "- OWASP top 10",
      "* Auth bypass",
      "+ Data exposure",
      "1. Input validation",
      "2) SQL injection",
    ].join("\n");

    expect(countEnumeratedChecks(prompt)).toBe(5);
  });

  test("ignores list-looking lines inside fenced blocks", () => {
    // The supplied diff is full of lines starting with "-" and "+". Counting those
    // would make every scoped review trip the breadth guard.
    const prompt = [
      "Check this one property.",
      "```diff",
      "- const a = 1;",
      "+ const a = 2;",
      "- const b = 3;",
      "```",
      "- the single real check",
    ].join("\n");

    expect(countEnumeratedChecks(prompt)).toBe(1);
  });

  test("a prose prompt enumerates nothing", () => {
    expect(countEnumeratedChecks("Verify that the retry wrapper cannot double-post.")).toBe(0);
  });
});

describe("contract enforcement", () => {
  test("refuses a verification pass with nothing on stdin", () => {
    // The rule that deletes the 114 whole-file reads.
    const decision = evaluateContract({
      passKind: null,
      prompt: "Review the auth changes for security issues",
      scopeText: null,
    });

    expect(decision.ok).toBe(false);
    expect(decision.passKind).toBe("review");
    expect(decision.violations.map((v) => v.code)).toContain("unscoped_verification");
    expect(decision.violations[0]?.remedy).toContain("git diff");
  });

  test("allows a verification pass once scope is supplied", () => {
    const decision = evaluateContract({
      passKind: null,
      prompt: "Review the auth changes",
      scopeText: "diff --git a/src/auth.ts b/src/auth.ts\n+const x = 1;",
    });

    expect(decision.ok).toBe(true);
    expect(decision.violations).toHaveLength(0);
  });

  test("treats whitespace-only stdin as no scope", () => {
    const decision = evaluateContract({
      passKind: null,
      prompt: "Review the auth changes",
      scopeText: "   \n\t\n  ",
    });

    expect(decision.ok).toBe(false);
    expect(decision.violations.map((v) => v.code)).toContain("unscoped_verification");
  });

  describe("--allow-unscoped is ratcheted", () => {
    // The flag means "the scope is not a diff", never "there is no scope". Before the
    // ratchet, `--allow-unscoped` on a one-line prompt with an inferred pass was honoured,
    // which made it a generic way around the scope rule rather than a narrow exception.
    const wholePlan =
      "This plan survives contact with production: " +
      "step one migrates the outbound queue behind a feature flag; step two backfills the " +
      "existing rows in batches of 500 with a resumable cursor; step three flips the flag " +
      "and retires the old path once the backlog is drained and the error rate holds.";

    test("refuses a bypass on an inferred pass", () => {
      const decision = evaluateContract({
        allowUnscoped: true,
        passKind: null,
        prompt: `Review this: ${wholePlan}`,
        scopeText: null,
      });

      expect(decision.ok).toBe(false);
      expect(decision.violations.map((v) => v.code)).toContain("unratcheted_bypass");
      expect(decision.violations[0]?.message).toContain("inferred rather than named");
    });

    test("refuses a bypass with no real subject supplied inline", () => {
      const decision = evaluateContract({
        allowUnscoped: true,
        passKind: "review",
        prompt: "Review the whole tree",
        scopeText: null,
      });

      expect(decision.ok).toBe(false);
      expect(decision.violations.map((v) => v.code)).toContain("unratcheted_bypass");
      expect(decision.violations[0]?.message).toContain("characters");
    });

    test("honours the documented P3 stress-test, which is the one legitimate use", () => {
      // SKILL.md teaches exactly this shape: an adversarial pass over a plan supplied
      // inline. Breaking it would break the documented three-phase planning pipeline.
      const decision = evaluateContract({
        allowUnscoped: true,
        passKind: "adversarial",
        prompt: wholePlan,
        scopeText: null,
      });

      expect(decision.ok).toBe(true);
      expect(decision.bypass).toBe("unscoped");
    });

    test("records nothing when the bypass did no work", () => {
      // --allow-unscoped alongside a piped diff bypasses nothing, so it is not a bypass.
      const decision = evaluateContract({
        allowUnscoped: true,
        passKind: "review",
        prompt: "one property",
        scopeText: "diff --git a/x b/x",
      });

      expect(decision.ok).toBe(true);
      expect(decision.bypass).toBeNull();
    });

    test("does not apply to a plan pass, which never required scope", () => {
      const decision = evaluateContract({
        allowUnscoped: true,
        passKind: "plan",
        prompt: "Design a cache",
        scopeText: null,
      });

      expect(decision.ok).toBe(true);
      expect(decision.bypass).toBeNull();
    });
  });

  test("a plan pass needs no scope, because planning converged", () => {
    const decision = evaluateContract({
      passKind: null,
      prompt: "Design a caching layer for the API",
      scopeText: null,
    });

    expect(decision.passKind).toBe("plan");
    expect(decision.ok).toBe(true);
  });

  test("refuses the breadth that caused the 1h50m run", () => {
    // This is the Stage-6 review prompt the old skill actually recommended.
    const decision = evaluateContract({
      passKind: null,
      prompt: [
        "Security review the changes. Check:",
        "- OWASP top 10 vulnerabilities",
        "- Auth bypass possibilities",
        "- Data exposure risks",
        "- Input validation",
        "- SQL/command injection",
      ].join("\n"),
      scopeText: "diff --git a/src/auth.ts b/src/auth.ts",
    });

    expect(decision.ok).toBe(false);
    // The diff is supplied, so breadth is the ONLY thing wrong with this call. Asserting the
    // whole list rather than probing for one entry says that too.
    expect(decision.violations.map((violation) => violation.code)).toEqual(["excessive_breadth"]);
    const [breadth] = decision.violations;
    expect(breadth?.message).toContain("5 independent checks");
    expect(breadth?.remedy).toContain("one property per call");
  });

  test("--max-checks raises the breadth limit for a single call", () => {
    const prompt = ["Review:", "- a", "- b", "- c", "- d", "- e"].join("\n");
    const scopeText = "diff --git a/x b/x";

    expect(evaluateContract({ passKind: null, prompt, scopeText }).ok).toBe(false);
    expect(evaluateContract({ maxChecks: 10, passKind: null, prompt, scopeText }).ok).toBe(true);
  });

  test("a plan pass has no breadth limit", () => {
    const prompt = ["Design this. Consider:", ...Array.from({ length: 40 }, (_, i) => `- point ${i}`)].join("\n");
    const decision = evaluateContract({ passKind: "plan", prompt, scopeText: null });

    expect(decision.ok).toBe(true);
  });

  test("reports both violations at once rather than one at a time", () => {
    const decision = evaluateContract({
      passKind: null,
      prompt: ["Review:", "- a", "- b", "- c", "- d"].join("\n"),
      scopeText: null,
    });

    expect(decision.violations.map((v) => v.code).toSorted()).toEqual(["excessive_breadth", "unscoped_verification"]);
  });
});

describe("Codex is the brain, not the hands", () => {
  test("no pass profile grants write access", () => {
    // Codex plans and reviews; Claude makes the edits. A planner and a reviewer never
    // need to write, and upstream's workspace-write default let every spawned agent
    // modify the tree — including review passes whose entire job is to look.
    for (const profile of Object.values(PASS_PROFILES)) {
      expect(profile.sandbox).toBe("read-only");
    }
  });

  test("the CLI default sandbox is read-only, so write is opt-in", () => {
    expect(config.defaultSandbox).toBe("read-only");
  });
});

describe("effort tiering per pass", () => {
  test("EVERY pass runs gpt-5.6-sol at xhigh — no exceptions", () => {
    // This tool exists to think, so it always gets the strongest thinker. That used to be a
    // per-profile field plus a `-r` override; both are gone. Four identical values were
    // variation that never varied, and the override existed only to do the one thing the
    // spec forbids.
    //
    // `runner.ts` passes `-c model=` and `-c model_reasoning_effort=` explicitly, which
    // OVERRIDE ~/.codex/config.toml — so these two values, not that file, are what every
    // launched agent actually runs with. There is exactly one place to change them.
    expect(config.model).toBe("gpt-5.6-sol");
    expect(config.reasoningEffort).toBe("xhigh");

    // The profiles still differ, just never in effort. Asserted so the table stays meaningful.
    for (const [kind, profile] of Object.entries(PASS_PROFILES)) {
      expect(profile.sandbox, `pass "${kind}" must be read-only`).toBe("read-only");
    }
  });

  test("every verification pass requires scope, a verdict, and a word cap", () => {
    for (const kind of ["review", "mechanical", "adversarial"] as const) {
      expect(PASS_PROFILES[kind].requiresScope).toBe(true);
      expect(PASS_PROFILES[kind].requiresVerdict).toBe(true);
      expect(PASS_PROFILES[kind].wordCap).toBeGreaterThan(0);
    }
  });

  test("the adversarial pass is narrowed to exactly one property", () => {
    expect(PASS_PROFILES.adversarial.maxChecks).toBe(1);
  });
});

describe("prompt shaping", () => {
  test("reproduces the shape that answered in 51 seconds", () => {
    const prompt = shapeVerificationPrompt({
      profile: PASS_PROFILES.review,
      property: "the retry wrapper cannot double-post",
      scopeText: "diff --git a/src/slack.ts b/src/slack.ts\n+await client.postMessage(x);",
    });

    expect(prompt).toContain("Attack ONE property. Ignore everything else.");
    expect(prompt).toContain("PROPERTY: the retry wrapper cannot double-post");
    expect(prompt).toContain("Answer in under 300 words.");
    expect(prompt).toContain("Do not read other files.");
    expect(prompt).toContain("=== DIFF ===");
    expect(prompt).toContain("+await client.postMessage(x);");
  });

  test("demands a machine-checkable verdict line", () => {
    const prompt = shapeVerificationPrompt({
      profile: PASS_PROFILES.review,
      property: "x holds",
      scopeText: "diff",
    });

    expect(prompt).toContain('"VERDICT: BROKEN"');
    expect(prompt).toContain('"VERDICT: CLEAN"');
  });

  test("omits the diff section when there is no scope", () => {
    const prompt = shapeVerificationPrompt({
      profile: PASS_PROFILES.review,
      property: "x holds",
      scopeText: null,
    });

    expect(prompt).not.toContain("=== DIFF ===");
    expect(prompt).not.toContain("Do not read other files.");
  });

  test("an explicit word cap overrides the profile default", () => {
    const prompt = shapeVerificationPrompt({
      profile: PASS_PROFILES.review,
      property: "x holds",
      scopeText: "diff",
      wordCap: 50,
    });

    expect(prompt).toContain("Answer in under 50 words.");
    expect(prompt).not.toContain("300 words");
  });
});

describe("verdict extraction", () => {
  test("finds a verdict on its own line, case-insensitively", () => {
    expect(extractVerdict("Some analysis.\n\nVERDICT: CLEAN")).toBe("CLEAN");
    expect(extractVerdict("Found it.\nverdict: broken")).toBe("BROKEN");
  });

  test("returns null when the run never concluded", () => {
    // This is the "verdict produced: no" case — the whole point of the metric.
    expect(extractVerdict("I read 40 files and here is what I noticed...")).toBeNull();
    expect(extractVerdict("")).toBeNull();
    expect(extractVerdict(null)).toBeNull();
    expect(extractVerdict(undefined)).toBeNull();
  });

  test("does not match a verdict mentioned mid-sentence", () => {
    // Line-anchored on purpose. "I will give a VERDICT: CLEAN once I finish reading"
    // is an agent narrating its intent, not concluding — counting it would let the
    // exact non-convergence this metric exists to catch report as a success.
    expect(extractVerdict("I will give a VERDICT: CLEAN once I finish reading")).toBeNull();
    expect(extractVerdict("The word verdict appears here but no colon form")).toBeNull();
    // Still found when it is the final line, with or without trailing whitespace.
    expect(extractVerdict("Analysis.\n  VERDICT: CLEAN  \n")).toBe("CLEAN");
  });
});

describe("convergence heartbeat", () => {
  test("stays quiet once a verdict exists", () => {
    const report = evaluateHeartbeat({
      elapsedMs: 90 * MINUTE,
      execCount: 500,
      verdict: "CLEAN",
    });

    expect(report.shouldReport).toBe(false);
  });

  test("stays quiet early in a run", () => {
    const report = evaluateHeartbeat({ elapsedMs: 30_000, execCount: 3, verdict: null });
    expect(report.shouldReport).toBe(false);
  });

  test("reports on exec count with the numbers that make the case", () => {
    const report = evaluateHeartbeat({
      elapsedMs: 2 * MINUTE,
      execCount: DEFAULT_HEARTBEAT_EXECS,
      verdict: null,
    });

    expect(report.shouldReport).toBe(true);
    expect(report.triggeredBy).toBe("execs");
    expect(report.message).toContain(`${DEFAULT_HEARTBEAT_EXECS} exec calls`);
    expect(report.message).toContain("no verdict");
  });

  test("reports on elapsed time even when exec count is low", () => {
    const report = evaluateHeartbeat({
      elapsedMs: DEFAULT_HEARTBEAT_MINUTES * MINUTE,
      execCount: 1,
      verdict: null,
    });

    expect(report.shouldReport).toBe(true);
    expect(report.triggeredBy).toBe("minutes");
  });

  test("reproduces the 2026-07-26 signal that was never emitted", () => {
    const report = evaluateHeartbeat({
      elapsedMs: 110 * MINUTE,
      execCount: 115,
      verdict: null,
    });

    expect(report.shouldReport).toBe(true);
    expect(report.message).toContain("115 exec calls");
    expect(report.message).toContain("1h50m elapsed");
  });

  test("thresholds are configurable so callers can back off after reporting", () => {
    const quiet = evaluateHeartbeat({
      afterExecs: 80,
      afterMinutes: 10,
      elapsedMs: 6 * MINUTE,
      execCount: 45,
      verdict: null,
    });

    expect(quiet.shouldReport).toBe(false);
  });
});

describe("telling blocked apart from not converging", () => {
  // Found by running the contract for real: the first live adversarial pass sat on a
  // directory-trust prompt for its whole 7m bound and reported "no verdict". Zero
  // execs is a different failure from 115 execs, and conflating them sends you off
  // narrowing a property that was never the problem.
  test("0 exec calls after minutes reads as BLOCKED, not as non-convergence", () => {
    const report = evaluateHeartbeat({ elapsedMs: 5 * MINUTE, execCount: 0, verdict: null });

    expect(report.shouldReport).toBe(true);
    expect(report.looksBlocked).toBe(true);
    expect(report.message).toContain("BLOCKED");
    expect(report.message).not.toContain("not converging");
  });

  test("many exec calls with no verdict still reads as non-convergence", () => {
    const report = evaluateHeartbeat({ elapsedMs: 110 * MINUTE, execCount: 115, verdict: null });

    expect(report.looksBlocked).toBe(false);
    expect(report.message).toContain("not converging");
  });

  // `detectBlockingPrompt` and its four tests are gone with the tmux transport. It scraped pane
  // text for "Do you trust the contents of this directory?" because under a TUI an agent could
  // sit on that prompt for its whole bound in silence. `codex exec` exits non-zero in about a
  // second with the reason on stderr, so there is no interactive prompt left to detect and
  // nothing for a scraper to guard.
});

describe("run ledger formatting", () => {
  function ledgerFixture(overrides: Partial<RunLedger> = {}): RunLedger {
    return {
      breachReason: null,
      bypass: null,
      cumulativeInputTokens: null,
      durationMs: 51_000,
      execCount: 4,
      jobId: "abc123",
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

  test("renders a non-converging run as NONE rather than blank", () => {
    const row = formatLedgerRow(
      ledgerFixture({
        durationMs: 110 * MINUTE,
        execCount: 115,
        scoped: false,
        tokensSpent: 412_000,
        verdict: null,
        verdictProduced: false,
      }),
    );

    expect(row).toContain("abc123");
    expect(row).toContain("review");
    expect(row).toContain("1h50m");
    expect(row).toContain("115");
    expect(row).toContain("NONE");
  });

  test("renders the scoped run that worked", () => {
    const row = formatLedgerRow(ledgerFixture({ jobId: "def456", passKind: "adversarial" }));

    expect(row).toContain("51s");
    expect(row).toContain("BROKEN");
    expect(row).toContain("yes");
  });

  test("tolerates missing metrics", () => {
    const row = formatLedgerRow(
      ledgerFixture({
        durationMs: null,
        execCount: null,
        jobId: "ghi789",
        passKind: null,
        scoped: false,
        tokensSpent: null,
        verdict: null,
        verdictProduced: false,
      }),
    );

    expect(row).toContain("ghi789");
    expect(row).toContain("-");
  });

  test("shows spend and cumulative input as separate columns", () => {
    // The whole point of the split: these are different quantities and a reader must be
    // able to tell which one is missing.
    const row = formatLedgerRow(ledgerFixture({ cumulativeInputTokens: 1_109_604, tokensSpent: 253_275 }));
    expect(row).toContain("253,275");
    expect(row).toContain("1,109,604");
    expect(LEDGER_HEADER).toContain("SPENT");
    expect(LEDGER_HEADER).toContain("CUM-IN");
  });

  test("never substitutes cumulative input for unmeasured spend", () => {
    // Regression on the defect this PR exists to fix. A run whose spend was never
    // reported must read "-" under SPENT, not borrow the cumulative-input number.
    const row = formatLedgerRow(ledgerFixture({ cumulativeInputTokens: 2_813_071, tokensSpent: null }));
    expect(row).toContain("2,813,071");
    expect(row).not.toContain("2,813,071  2,813,071");
    const spentColumn = row.slice(0, row.indexOf("2,813,071"));
    expect(spentColumn).toContain("-");
  });

  describe("outcome", () => {
    test("prefers the verdict", () => {
      expect(formatOutcome(ledgerFixture({ verdict: "CLEAN" }))).toBe("CLEAN");
    });

    test("names the guard that stopped a killed run", () => {
      expect(formatOutcome(ledgerFixture({ breachReason: "stalled", verdict: null, verdictProduced: false }))).toBe(
        "killed:stalled",
      );
    });

    test("reads a legacy timed-out job as a wall-clock breach", () => {
      // Jobs recorded before guards.ts existed only have `timedOut`.
      expect(formatOutcome(ledgerFixture({ timedOut: true, verdict: null, verdictProduced: false }))).toBe(
        "killed:wall_clock",
      );
    });

    test("falls back to NONE", () => {
      expect(formatOutcome(ledgerFixture({ verdict: null, verdictProduced: false }))).toBe("NONE");
    });
  });
});
