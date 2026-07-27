import { describe, expect, test } from "bun:test";
import { config } from "./config.ts";
import {
  DEFAULT_HEARTBEAT_EXECS,
  DEFAULT_HEARTBEAT_MINUTES,
  PASS_PROFILES,
  countEnumeratedChecks,
  detectBlockingPrompt,
  evaluateContract,
  evaluateHeartbeat,
  extractVerdict,
  formatLedgerRow,
  isPassKind,
  looksLikeVerification,
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
      prompt: "Review the auth changes for security issues",
      scopeText: null,
      passKind: null,
    });

    expect(decision.ok).toBe(false);
    expect(decision.passKind).toBe("review");
    expect(decision.violations.map((v) => v.code)).toContain("unscoped_verification");
    expect(decision.violations[0].remedy).toContain("git diff");
  });

  test("allows a verification pass once scope is supplied", () => {
    const decision = evaluateContract({
      prompt: "Review the auth changes",
      scopeText: "diff --git a/src/auth.ts b/src/auth.ts\n+const x = 1;",
      passKind: null,
    });

    expect(decision.ok).toBe(true);
    expect(decision.violations).toHaveLength(0);
  });

  test("treats whitespace-only stdin as no scope", () => {
    const decision = evaluateContract({
      prompt: "Review the auth changes",
      scopeText: "   \n\t\n  ",
      passKind: null,
    });

    expect(decision.ok).toBe(false);
    expect(decision.violations.map((v) => v.code)).toContain("unscoped_verification");
  });

  test("--allow-unscoped is the explicit way past the scope rule", () => {
    const decision = evaluateContract({
      prompt: "Review the whole tree",
      scopeText: null,
      passKind: null,
      allowUnscoped: true,
    });

    expect(decision.ok).toBe(true);
  });

  test("a plan pass needs no scope, because planning converged", () => {
    const decision = evaluateContract({
      prompt: "Design a caching layer for the API",
      scopeText: null,
      passKind: null,
    });

    expect(decision.passKind).toBe("plan");
    expect(decision.ok).toBe(true);
  });

  test("refuses the breadth that caused the 1h50m run", () => {
    // This is the Stage-6 review prompt the old skill actually recommended.
    const decision = evaluateContract({
      prompt: [
        "Security review the changes. Check:",
        "- OWASP top 10 vulnerabilities",
        "- Auth bypass possibilities",
        "- Data exposure risks",
        "- Input validation",
        "- SQL/command injection",
      ].join("\n"),
      scopeText: "diff --git a/src/auth.ts b/src/auth.ts",
      passKind: null,
    });

    expect(decision.ok).toBe(false);
    const breadth = decision.violations.find((v) => v.code === "excessive_breadth");
    expect(breadth).toBeDefined();
    expect(breadth!.message).toContain("5 independent checks");
    expect(breadth!.remedy).toContain("one property per call");
  });

  test("--max-checks raises the breadth limit for a single call", () => {
    const prompt = ["Review:", "- a", "- b", "- c", "- d", "- e"].join("\n");
    const scopeText = "diff --git a/x b/x";

    expect(evaluateContract({ prompt, scopeText, passKind: null }).ok).toBe(false);
    expect(evaluateContract({ prompt, scopeText, passKind: null, maxChecks: 10 }).ok).toBe(true);
  });

  test("a plan pass has no breadth limit", () => {
    const prompt = ["Design this. Consider:", ...Array.from({ length: 40 }, (_, i) => `- point ${i}`)].join("\n");
    const decision = evaluateContract({ prompt, scopeText: null, passKind: "plan" });

    expect(decision.ok).toBe(true);
  });

  test("reports both violations at once rather than one at a time", () => {
    const decision = evaluateContract({
      prompt: ["Review:", "- a", "- b", "- c", "- d"].join("\n"),
      scopeText: null,
      passKind: null,
    });

    expect(decision.violations.map((v) => v.code).sort()).toEqual([
      "excessive_breadth",
      "unscoped_verification",
    ]);
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
    // This tool exists to think. A profile that quietly resolves to a weaker effort is a
    // footgun: you ask for a pass and silently get a worse thinker than every other one.
    // If cost ever matters more than depth, lower it per call with -r, visibly.
    //
    // buildCodexArgs passes `-c model=` and `-c model_reasoning_effort=` explicitly,
    // which OVERRIDE ~/.codex/config.toml — so these values, not that file, are what
    // every plugin-launched agent actually runs with.
    expect(config.model).toBe("gpt-5.6-sol");
    expect(config.defaultReasoningEffort).toBe("xhigh");

    for (const [kind, profile] of Object.entries(PASS_PROFILES)) {
      expect(profile.reasoning, `pass "${kind}" must run at xhigh`).toBe("xhigh");
    }
  });

  test("every pass has a finite wall-clock bound", () => {
    // The failing run's defining absence.
    for (const profile of Object.values(PASS_PROFILES)) {
      expect(Number.isFinite(profile.timeoutMinutes)).toBe(true);
      expect(profile.timeoutMinutes).toBeGreaterThan(0);
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
      property: "the retry wrapper cannot double-post",
      profile: PASS_PROFILES.review,
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
      property: "x holds",
      profile: PASS_PROFILES.review,
      scopeText: "diff",
    });

    expect(prompt).toContain('"VERDICT: BROKEN"');
    expect(prompt).toContain('"VERDICT: CLEAN"');
  });

  test("omits the diff section when there is no scope", () => {
    const prompt = shapeVerificationPrompt({
      property: "x holds",
      profile: PASS_PROFILES.review,
      scopeText: null,
    });

    expect(prompt).not.toContain("=== DIFF ===");
    expect(prompt).not.toContain("Do not read other files.");
  });

  test("an explicit word cap overrides the profile default", () => {
    const prompt = shapeVerificationPrompt({
      property: "x holds",
      profile: PASS_PROFILES.review,
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
      elapsedMs: 6 * MINUTE,
      execCount: 45,
      verdict: null,
      afterMinutes: 10,
      afterExecs: 80,
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

  test("detects the trust prompt as tmux actually renders it", () => {
    // Verbatim from the real pane capture. tmux collapses the spacing in Codex's
    // box-drawn prompt, so a spaced regex silently never matches — the exact class of
    // quietly-dead guard this module exists to avoid.
    const paneOutput =
      ">You are in /Users/x/dev/personal/codex-agent" +
      "Doyoutrustthecontentsofthisdirectory?" +
      "Workingwithuntrustedcontentscomeswithhigherriskofpromptinjection." +
      "› 1. Yes, continue2.No,quitPress enter to continue";

    const detection = detectBlockingPrompt(paneOutput);

    expect(detection.blocked).toBe(true);
    expect(detection.kind).toBe("onboarding");
    expect(detection.hint).toContain("trust_level");
  });

  test("also detects the normally-spaced form", () => {
    const detection = detectBlockingPrompt("Do you trust the contents of this directory?");

    expect(detection.blocked).toBe(true);
    expect(detection.kind).toBe("onboarding");
  });

  test("classifies approval and auth prompts distinctly", () => {
    expect(detectBlockingPrompt("Allow command?").kind).toBe("permission");
    expect(detectBlockingPrompt("Sign in with ChatGPT to continue").kind).toBe("auth");
  });

  test("ordinary working output is not mistaken for a prompt", () => {
    for (const output of [
      "Reading src/cli.ts",
      "thinking... exploring the diff",
      "VERDICT: CLEAN",
      "",
      null,
      undefined,
    ]) {
      expect(detectBlockingPrompt(output).blocked).toBe(false);
    }
  });
});

describe("run ledger formatting", () => {
  test("renders a non-converging run as NONE rather than blank", () => {
    const row = formatLedgerRow({
      jobId: "abc123",
      passKind: "review",
      reasoning: "xhigh",
      model: "gpt-5.6-sol",
      durationMs: 110 * MINUTE,
      totalTokens: 412_000,
      execCount: 115,
      verdict: null,
      verdictProduced: false,
      scoped: false,
      timedOut: true,
    });

    expect(row).toContain("abc123");
    expect(row).toContain("review");
    expect(row).toContain("1h50m");
    expect(row).toContain("115");
    expect(row).toContain("NONE");
  });

  test("renders the scoped run that worked", () => {
    const row = formatLedgerRow({
      jobId: "def456",
      passKind: "adversarial",
      reasoning: "xhigh",
      model: "gpt-5.6-sol",
      durationMs: 51_000,
      totalTokens: 31_000,
      execCount: 4,
      verdict: "BROKEN",
      verdictProduced: true,
      scoped: true,
      timedOut: false,
    });

    expect(row).toContain("51s");
    expect(row).toContain("BROKEN");
    expect(row).toContain("yes");
  });

  test("tolerates missing metrics", () => {
    const row = formatLedgerRow({
      jobId: "ghi789",
      passKind: null,
      reasoning: "xhigh",
      model: "gpt-5.6-sol",
      durationMs: null,
      totalTokens: null,
      execCount: null,
      verdict: null,
      verdictProduced: false,
      scoped: false,
      timedOut: false,
    });

    expect(row).toContain("ghi789");
    expect(row).toContain("-");
  });
});
