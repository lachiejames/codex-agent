// The gate's plan and its verdict. Pure: no spawning, no filesystem, no process exit.
//
// WHY THIS FILE EXISTS AT ALL
//
// Before this, the repo had THREE different quality bars and no two agreed:
//
//   `bun run validate`      lint + format + typecheck + test-discipline + test
//   CI                      typecheck + test + build
//   scripts/verify-install  test + typecheck + lint + machine probes
//
// So a formatting regression passed CI, a build break passed pre-push, and `knip` — which was
// installed, configured, and sitting at exit 1 — was run by none of the three. A contract that
// holds on one invocation shape is not a contract; the same is true of a quality bar. There is
// now ONE list, here, and every door runs it.
//
// The list is also NO-SHORT-CIRCUIT, which is the part that changes what a developer sees.
// `validate` used to be `a && b && c`, so a tree with both a formatting error and a type error
// reported only the formatting error, and you fixed one thing per run. Every check now runs and
// the failures are reported together.
//
// That IS a behaviour change, and it is deliberately scoped: it changes `bun run validate`,
// which is developer tooling. It does not touch the `codex-agent` CLI — its exit codes (1, 3,
// 4), its JSON field names and its printed strings are untouched by this file, and docs/SPEC.md
// is unaffected.

/** One check: a display name plus the exact command to spawn. */
export interface GateCheck {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

/** One check's outcome. */
export interface GateResult {
  readonly name: string;
  readonly ok: boolean;
}

/** The whole gate's verdict. */
export interface GateVerdict {
  readonly ok: boolean;
  readonly failed: readonly string[];
}

/**
 * The checks the gate runs, in reporting order.
 *
 * Each delegates to the matching `package.json` script rather than invoking the tool directly,
 * so the flags a tool runs under are defined in exactly one place. `oxlint --deny-warnings`
 * lives in the `lint` script; this file must not acquire a second opinion about it.
 *
 * `build` is included even though the bundle it produces has no runtime consumer — `bin/`
 * execs `src/cli.ts` directly. It stays as a bundleability check: the CLI is what every other
 * project on the machine invokes, so it failing to bundle is worth knowing even when the
 * artifact is unused. It is NOT "the shipped CLI", whatever CI used to claim.
 *
 * @returns the checks in the order their output should appear
 */
export function gateChecks(): readonly GateCheck[] {
  return [
    { args: ["run", "format:check"], cmd: "bun", name: "format" },
    { args: ["run", "lint"], cmd: "bun", name: "lint" },
    { args: ["run", "typecheck"], cmd: "bun", name: "typecheck" },
    { args: ["run", "check:tests"], cmd: "bun", name: "test-discipline" },
    { args: ["run", "knip"], cmd: "bun", name: "dead-code" },
    { args: ["test"], cmd: "bun", name: "test" },
    { args: ["run", "build"], cmd: "bun", name: "build" },
  ];
}

/**
 * Fold the per-check outcomes into one verdict.
 *
 * @param results one entry per check that ran, in run order
 * @returns ok when every check passed, plus the names that did not, in run order
 */
export function composeGate(results: readonly GateResult[]): GateVerdict {
  const failed = results.filter((result) => !result.ok).map((result) => result.name);
  return { failed, ok: failed.length === 0 };
}

/**
 * The closing summary.
 *
 * Names every failure on one line, because the reason this gate does not short-circuit is so a
 * single run tells you everything that is wrong.
 *
 * @param verdict the folded outcome
 * @returns the lines to print, without a trailing newline
 */
export function formatGateSummary(verdict: GateVerdict): string {
  if (verdict.ok) return "gate: all checks passed.";
  const plural = verdict.failed.length === 1 ? "check" : "checks";
  return `gate: ${verdict.failed.length} ${plural} FAILED — ${verdict.failed.join(", ")}`;
}
