// End-to-end tests for the invocation contract as the CLI actually enforces it.
//
// contract.test.ts covers the decision logic in isolation. These spawn the real CLI so the wiring
// is covered too: stdin ingestion, the required bound, exit codes, and the fact that there is
// exactly one launch path and no way around it.
//
// All of these use --dry-run, so no Codex process is ever created.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Contract refusal. Distinct from a crash (1) and from a no-verdict run (4). */
const EXIT_CONTRACT_REFUSAL = 3;

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-agent-invocation-"));
  mkdirSync(join(home, ".codex-agent", "jobs"), { recursive: true });
  return home;
}

function runCli(args: string[], stdin: string | null) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "src/cli.ts", ...args],
    cwd: process.cwd(),
    env: { ...process.env, HOME: makeHome() },
    stderr: "pipe",
    // A string stdin is a pipe; "ignore" gives a non-TTY empty stream, which is the
    // `< /dev/null` case and must read as "no scope supplied".
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  };
}

const SAMPLE_DIFF = [
  "diff --git a/src/slack.ts b/src/slack.ts",
  "index 1111111..2222222 100644",
  "--- a/src/slack.ts",
  "+++ b/src/slack.ts",
  "@@ -1,3 +1,6 @@",
  "+await withRetries(4, () => client.chat.postMessage(payload));",
].join("\n");

const PASS_KINDS = ["plan", "review", "mechanical", "adversarial"] as const;

describe("the required bound", () => {
  test("omitting --timeout is a contract refusal, not an inherited default", () => {
    // The newest rule, and the one the whole transport rewrite turns on. A default a machine
    // caller inherits silently is not a bound: a 10-minute review and a 60-minute deep pass end
    // up sharing one accidental number, and only the caller knows which this is.
    const result = runCli(["start", "Design a caching layer for the API", "--dry-run"], null);

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("--timeout <minutes> is required and has no default");
    // Refused before anything was built, so no prompt was previewed and nothing was spent.
    expect(result.stdout).not.toContain("Prompt Preview");
  });

  test("the bound is refused for an otherwise perfect invocation too", () => {
    // Checked first on purpose, so the refusal reads the same whether or not the rest of the
    // invocation is well formed.
    const result = runCli(["start", "--pass", "review", "--property", "x holds", "--dry-run"], SAMPLE_DIFF);

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("--timeout <minutes> is required and has no default");
  });

  test("the bound comes from --timeout alone, for every pass", () => {
    // It used to come from the pass profile, which meant four accidental numbers instead of one
    // stated one. Every pass now reports exactly what the caller asked for.
    for (const pass of PASS_KINDS) {
      const result = runCli(
        ["start", "--pass", pass, "--property", "x holds", "--timeout", "12", "--dry-run"],
        SAMPLE_DIFF,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Bound: 12m per turn");
    }
  });

  test("a different --timeout gives a different bound", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "--timeout", "3", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.stdout).toContain("Bound: 3m per turn");
  });

  test("a nonsense --timeout is rejected rather than coerced", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "--timeout", "0", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid timeout (minutes): 0");
  });
});

describe("the scope rule", () => {
  test("refuses an unscoped review with a distinct exit code and an actionable remedy", () => {
    const result = runCli(
      ["start", "Review the auth changes for security issues", "--timeout", "10", "--dry-run"],
      null,
    );

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("Refusing to run");
    expect(result.stderr).toContain("git diff");
    // It must not have built or previewed a prompt.
    expect(result.stdout).not.toContain("Prompt Preview");
  });

  test("accepts the same review once the diff arrives on stdin", () => {
    const result = runCli(["start", "Review these changes", "--timeout", "10", "--dry-run"], SAMPLE_DIFF);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scoped by stdin: yes");
    expect(result.stdout).toContain("=== DIFF ===");
  });

  test("empty stdin counts as unscoped, not as scope", () => {
    const result = runCli(["start", "Verify the migration", "--timeout", "10", "--dry-run"], "   \n  \n");

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("Refusing to run");
  });

  test("a plan pass needs no scope and keeps xhigh", () => {
    const result = runCli(["start", "Design a caching layer for the API", "--timeout", "45", "--dry-run"], null);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Pass: plan");
    expect(result.stdout).toContain("Reasoning: xhigh");
  });

  test("there is no second, ungated way into Codex", () => {
    // `codex-agent "review ..."` with no subcommand used to be a supported form, and was a
    // second path into Codex before both routed through one launcher. It is now not a launch path
    // at all: an unknown command costs a message rather than a bounded-but-real spend.
    const result = runCli(["Review the auth module", "--timeout", "10", "--dry-run"], null);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: Review");
    expect(result.stdout).not.toContain("Prompt Preview");
  });
});

describe("the breadth guard", () => {
  test("refuses the enumerated-checklist shape that ran 1h50m", () => {
    const prompt = [
      "Security review the changes. Check:",
      "- OWASP top 10 vulnerabilities",
      "- Auth bypass possibilities",
      "- Data exposure risks",
      "- Input validation",
      "- SQL/command injection",
    ].join("\n");

    const result = runCli(["start", prompt, "--timeout", "10", "--dry-run"], SAMPLE_DIFF);

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("5 independent checks");
    expect(result.stderr).toContain("one property per call");
  });

  test("a diff full of +/- lines does not itself trip the breadth guard", () => {
    // Regression guard: the diff is appended to the prompt, and its lines look like
    // list items. Counting them would refuse every correctly scoped review.
    const bigDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      ...Array.from({ length: 30 }, (_, i) => `-const removed${i} = ${i};`),
      ...Array.from({ length: 30 }, (_, i) => `+const added${i} = ${i};`),
    ].join("\n");

    const result = runCli(
      ["start", "--pass", "review", "--property", "no value is dropped", "--timeout", "10", "--dry-run"],
      bigDiff,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Prompt Preview");
  });

  test("--max-checks raises the limit for a caller who is certain", () => {
    const prompt = ["Review the changes. Check:", "- one", "- two", "- three", "- four"].join("\n");

    expect(runCli(["start", prompt, "--timeout", "10", "--dry-run"], SAMPLE_DIFF).exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(runCli(["start", prompt, "--max-checks", "4", "--timeout", "10", "--dry-run"], SAMPLE_DIFF).exitCode).toBe(
      0,
    );
  });
});

describe("the bypass ratchet", () => {
  test("--allow-unscoped does not wave through a one-line prompt", () => {
    // Ratcheted: the bypass used to be honoured here, which made it a general way past
    // the scope rule instead of a narrow exception.
    const result = runCli(["start", "Review the whole tree", "--timeout", "10", "--dry-run", "--allow-unscoped"], null);

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("not honoured here");
  });

  test("--allow-unscoped is honoured for the documented P3 shape, and recorded", () => {
    const plan =
      "This plan survives contact with production: migrate the outbound queue behind a " +
      "feature flag, backfill existing rows in batches of 500 with a resumable cursor, then " +
      "flip the flag and retire the old path once the backlog drains and error rate holds.";

    const result = runCli(
      ["start", "--pass", "adversarial", "--property", plan, "--timeout", "20", "--dry-run", "--allow-unscoped"],
      null,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scoped by stdin: no");
    expect(result.stdout).toContain("Bypass: unscoped");
    // A bypass that is not visible afterwards is indistinguishable from no contract.
    expect(result.stderr).toContain("Recorded as a bypass");
  });

  test("--allow-unscoped alongside a piped diff bypasses nothing, and is not recorded as one", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "--timeout", "10", "--dry-run", "--allow-unscoped"],
      SAMPLE_DIFF,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Bypass: none");
    expect(result.stderr).not.toContain("Recorded as a bypass");
  });

  test("--no-contract is a real escape hatch, and says it was used", () => {
    const result = runCli(
      ["start", "Review everything everywhere", "--timeout", "10", "--dry-run", "--no-contract"],
      null,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Attack ONE property.");
    expect(result.stdout).toContain("Bypass: no-contract");
    expect(result.stderr).toContain("every guard in contract.ts is off for this run");
  });
});

describe("prompt shaping and profile resolution", () => {
  test("shapes a review into the one-property form", () => {
    const result = runCli(
      [
        "start",
        "--pass",
        "adversarial",
        "--property",
        "the retry wrapper cannot double-post",
        "--timeout",
        "20",
        "--dry-run",
      ],
      SAMPLE_DIFF,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Attack ONE property.");
    expect(result.stdout).toContain("PROPERTY: the retry wrapper cannot double-post");
    expect(result.stdout).toContain('"VERDICT: BROKEN"');
    expect(result.stdout).toContain("Answer in under 400 words.");
    expect(result.stdout).toContain("Do not read other files.");
    expect(result.stdout).toContain("Bound: 20m per turn");
  });

  test("every pass runs read-only unless write is explicitly requested", () => {
    // Codex is the brain, not the hands. Write access must never be inferred.
    for (const pass of PASS_KINDS) {
      const result = runCli(
        ["start", "--pass", pass, "--property", "x holds", "--timeout", "10", "--dry-run"],
        SAMPLE_DIFF,
      );

      expect(result.stdout).toContain("Sandbox: read-only");
    }
  });

  test("an explicit -s workspace-write is honoured", () => {
    const result = runCli(
      ["start", "--pass", "plan", "Design a cache", "-s", "workspace-write", "--timeout", "45", "--dry-run"],
      null,
    );

    expect(result.stdout).toContain("Sandbox: workspace-write");
  });

  test("every pass reports gpt-5.6-sol at xhigh through the real CLI", () => {
    // The end-to-end form of the guarantee: not just the profile table, but what the CLI
    // actually resolves and would hand to `codex` via -c model / -c model_reasoning_effort.
    for (const pass of PASS_KINDS) {
      const result = runCli(
        ["start", "--pass", pass, "--property", "x holds", "--timeout", "10", "--dry-run"],
        SAMPLE_DIFF,
      );

      expect(result.stdout).toContain("Reasoning: xhigh");
      expect(result.stdout).toContain("Model: gpt-5.6-sol");
    }
  });

  // The escape hatch is GONE, and its absence is the assertion. `-r low` was the one
  // documented way to violate docs/SPEC.md behaviour 2.
  test("-r is rejected outright, not silently ignored", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "-r", "low", "--timeout", "10", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("-r was removed");
    expect(result.stderr).toContain("pinned to xhigh");
  });

  // Why rejection matters rather than ignoring: the parser used to fall through on unknown
  // flags, so `-r low` would have dropped `-r` and appended "low" to the PROMPT as a
  // positional — silently changing the question being asked.
  test("a retired flag's value never leaks into the prompt", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "-m", "gpt-4", "--timeout", "10", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("gpt-4");
  });

  test("an unknown flag is an error", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "--timeout", "10", "--nonsense", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown option: --nonsense");
  });

  test("--word-cap 0 removes the answer cap", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "--word-cap", "0", "--timeout", "10", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.stdout).not.toContain("Answer in under");
  });

  test("rejects an unknown pass kind instead of silently inferring one", () => {
    const result = runCli(["start", "x", "--pass", "nonsense", "--timeout", "10", "--dry-run"], SAMPLE_DIFF);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid pass kind");
  });

  test("--property alone is a sufficient prompt", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "the cache never returns stale rows", "--timeout", "10", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PROPERTY: the cache never returns stale rows");
  });

  test("start with neither prompt nor property still errors", () => {
    const result = runCli(["start", "--timeout", "10", "--dry-run"], SAMPLE_DIFF);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No prompt provided");
  });
});

describe("discoverability", () => {
  test("help documents the contract, so the failure mode is discoverable", () => {
    const result = runCli(["--help"], null);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Invocation contract");
    expect(result.stdout).toContain("--pass");
    expect(result.stdout).toContain("--property");
    expect(result.stdout).toContain("REFUSED");
    expect(result.stdout).toContain("--timeout is REQUIRED and has no default");
  });

  test("the ledger command runs with no runs at all", () => {
    const result = runCli(["ledger"], null);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No runs");
  });
});
