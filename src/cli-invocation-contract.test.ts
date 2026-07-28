// End-to-end tests for the invocation contract as the CLI actually enforces it.
//
// contract.test.ts covers the decision logic in isolation. These spawn the real CLI
// so the wiring is covered too: stdin ingestion, exit codes, and the fact that both
// launch paths (`start` and the bare-prompt fall-through) go through the same gate.
//
// All of these use --dry-run, so no Codex agent or tmux session is created.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

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
    // A string stdin is a pipe; "ignore" gives a non-TTY empty stream, which is the
    // `< /dev/null` case and must read as "no scope supplied".
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
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

describe("CLI invocation contract", () => {
  test("refuses an unscoped review with a distinct exit code and an actionable remedy", () => {
    const result = runCli(["start", "Review the auth changes for security issues", "--dry-run"], null);

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("Refusing to run");
    expect(result.stderr).toContain("git diff");
    // It must not have built or previewed a prompt.
    expect(result.stdout).not.toContain("Prompt Preview");
  });

  test("accepts the same review once the diff arrives on stdin", () => {
    const result = runCli(["start", "Review these changes", "--dry-run"], SAMPLE_DIFF);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scoped by stdin: yes");
    expect(result.stdout).toContain("=== DIFF ===");
  });

  test("the bare-prompt fall-through cannot bypass the gate", () => {
    // `codex-agent "review ..."` with no subcommand is a supported form, and was a
    // second, ungated path into Codex before both routed through one launcher.
    const result = runCli(["Review the auth module", "--dry-run"], null);

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("Refusing to run");
  });

  test("empty stdin counts as unscoped, not as scope", () => {
    const result = runCli(["start", "Verify the migration", "--dry-run"], "   \n  \n");

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
  });

  test("--allow-unscoped no longer waves through a one-line prompt", () => {
    // Ratcheted: the bypass used to be honoured here, which made it a general way past
    // the scope rule instead of a narrow exception.
    const result = runCli(
      ["start", "Review the whole tree", "--dry-run", "--allow-unscoped"],
      null,
    );

    expect(result.exitCode).toBe(EXIT_CONTRACT_REFUSAL);
    expect(result.stderr).toContain("not honoured here");
  });

  test("--allow-unscoped is honoured for the documented P3 shape, and recorded", () => {
    const plan =
      "This plan survives contact with production: migrate the outbound queue behind a " +
      "feature flag, backfill existing rows in batches of 500 with a resumable cursor, then " +
      "flip the flag and retire the old path once the backlog drains and error rate holds.";

    const result = runCli(
      ["start", "--pass", "adversarial", "--property", plan, "--dry-run", "--allow-unscoped"],
      null,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scoped by stdin: no");
    // A bypass that is not visible afterwards is indistinguishable from no contract.
    expect(result.stderr).toContain("Recorded as a bypass");
  });

  test("refuses the enumerated-checklist shape that ran 1h50m", () => {
    const prompt = [
      "Security review the changes. Check:",
      "- OWASP top 10 vulnerabilities",
      "- Auth bypass possibilities",
      "- Data exposure risks",
      "- Input validation",
      "- SQL/command injection",
    ].join("\n");

    const result = runCli(["start", prompt, "--dry-run"], SAMPLE_DIFF);

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
      ["start", "--pass", "review", "--property", "no value is dropped", "--dry-run"],
      bigDiff,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Prompt Preview");
  });

  test("a plan pass needs no scope and keeps xhigh", () => {
    const result = runCli(["start", "Design a caching layer for the API", "--dry-run"], null);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Pass: plan");
    expect(result.stdout).toContain("Reasoning: xhigh");
  });

  test("shapes a review into the one-property form and states its bound", () => {
    const result = runCli(
      [
        "start",
        "--pass",
        "adversarial",
        "--property",
        "the retry wrapper cannot double-post",
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
    expect(result.stdout).toContain("Wall-clock bound: 20m");
  });

  test("every pass reports a finite wall-clock bound", () => {
    // The 2026-07-26 run had none. There must be no way to launch without one.
    for (const [pass, expected] of [
      ["plan", "45m"],
      ["review", "10m"],
      ["mechanical", "5m"],
      ["adversarial", "20m"],
    ] as const) {
      const result = runCli(
        ["start", "--pass", pass, "--property", "x holds", "--dry-run", "--allow-unscoped"],
        SAMPLE_DIFF,
      );
      expect(result.stdout).toContain(`Wall-clock bound: ${expected}`);
    }
  });

  test("every pass runs read-only unless write is explicitly requested", () => {
    // Codex is the brain, not the hands. Write access must never be inferred.
    for (const pass of ["plan", "review", "mechanical", "adversarial"] as const) {
      const result = runCli(
        ["start", "--pass", pass, "--property", "x holds", "--dry-run", "--allow-unscoped"],
        SAMPLE_DIFF,
      );
      expect(result.stdout).toContain("Sandbox: read-only");
    }
  });

  test("an explicit -s workspace-write is honoured", () => {
    const result = runCli(
      ["start", "--pass", "plan", "Design a cache", "-s", "workspace-write", "--dry-run"],
      null,
    );

    expect(result.stdout).toContain("Sandbox: workspace-write");
  });

  test("--timeout overrides the profile bound", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "--timeout", "3", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.stdout).toContain("Wall-clock bound: 3m");
  });

  test("every pass reports gpt-5.6-sol at xhigh through the real CLI", () => {
    // The end-to-end form of the guarantee: not just the profile table, but what the CLI
    // actually resolves and would hand to `codex` via -c model / -c model_reasoning_effort.
    for (const pass of ["plan", "review", "mechanical", "adversarial"] as const) {
      const result = runCli(
        ["start", "--pass", pass, "--property", "x holds", "--dry-run", "--allow-unscoped"],
        SAMPLE_DIFF,
      );
      expect(result.stdout).toContain("Reasoning: xhigh");
      expect(result.stdout).toContain("Model: gpt-5.6-sol");
    }
  });

  test("an explicit -r still overrides, so the escape hatch remains", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "-r", "low", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.stdout).toContain("Reasoning: low");
  });

  test("--word-cap 0 removes the answer cap", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "x holds", "--word-cap", "0", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.stdout).not.toContain("Answer in under");
  });

  test("--no-contract is a real escape hatch", () => {
    const result = runCli(
      ["start", "Review everything everywhere", "--dry-run", "--no-contract"],
      null,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Attack ONE property.");
  });

  test("rejects an unknown pass kind instead of silently inferring one", () => {
    const result = runCli(["start", "x", "--pass", "nonsense", "--dry-run"], SAMPLE_DIFF);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid pass kind");
  });

  test("--property alone is a sufficient prompt", () => {
    const result = runCli(
      ["start", "--pass", "review", "--property", "the cache never returns stale rows", "--dry-run"],
      SAMPLE_DIFF,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PROPERTY: the cache never returns stale rows");
  });

  test("start with neither prompt nor property still errors", () => {
    const result = runCli(["start", "--dry-run"], SAMPLE_DIFF);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No prompt provided");
  });

  test("the ledger command runs with no jobs", () => {
    const result = runCli(["ledger"], null);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No runs");
  });

  test("the ledger emits a versioned JSON envelope", () => {
    const result = runCli(["ledger", "--json"], null);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    // v2 because `totalTokens` was replaced. It used to carry either true spend or
    // cumulative input depending on which was available, so consumers reading it as a cost
    // were sometimes wrong by 4x — a silent change would have left them wrong quietly.
    expect(payload.schema_version).toBe("codex-agent.ledger.v2");
    expect(Array.isArray(payload.runs)).toBe(true);
  });

  test("the ledger reports spend and cumulative input as distinct fields", () => {
    const result = runCli(["ledger", "--json", "--limit", "5"], null);
    const payload = JSON.parse(result.stdout);

    for (const run of payload.runs) {
      expect(run).not.toHaveProperty("totalTokens");
      expect(run).toHaveProperty("tokensSpent");
      expect(run).toHaveProperty("cumulativeInputTokens");
    }
  });

  test("help documents the contract, so the failure mode is discoverable", () => {
    const result = runCli(["--help"], null);

    expect(result.stdout).toContain("Invocation contract");
    expect(result.stdout).toContain("--pass");
    expect(result.stdout).toContain("--property");
    expect(result.stdout).toContain("REFUSED");
  });
});
