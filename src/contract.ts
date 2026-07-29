// The invocation contract.
//
// Every rule in this file exists because of one measured failure. On 2026-07-26 a
// single review call ran 1h50m across 115 exec calls and produced no verdict before
// being killed. The same model at the same effort had produced an excellent planning
// report 25 minutes earlier, and a deliberately narrowed call answered the same
// question correctly in 51 seconds using 31k tokens.
//
// The difference was never capability. It was prompt shape:
//
//   | run        | scope         | diff supplied | result                  |
//   |------------|---------------|---------------|-------------------------|
//   | planning   | one artifact  | no            | 100 execs, 25m, verdict |
//   | review     | ~25 checks    | no            | 115 execs, 110m, NONE   |
//   | narrow     | one property  | yes, stdin    | 51s, correct finding    |
//
// So this module does NOT lower reasoning effort. xhigh is what caught a genuinely
// subtle double-post defect (a postMessage running under both a client's default ten
// retries and a four-retry wrapper — ~44 attempts at an irreversible POST). Lowering
// effort to make review terminate would trade away the exact capability being paid
// for. The fix is to bound the *question*, not the thinking.

import { formatElapsed, type KillReason } from "./bounds.ts";
import type { SandboxMode } from "./config.ts";

// --------------------------------------------------------------------------
// Pass kinds — effort tiering per pass, not one global dial
// --------------------------------------------------------------------------

// Verification is N independent investigations with no natural stopping point; planning
// converges on a single artifact. They differ in scope rules, breadth limits and word caps —
// but NOT in effort. Every profile carried `reasoning: "xhigh"`, four identical values, so the
// field was variation that never varied. Effort is pinned once in config.ts.
export type PassKind = "plan" | "review" | "mechanical" | "adversarial";

export interface PassProfile {
  readonly kind: PassKind;
  /**
   * Sandbox for this pass. Every pass here is read-only: Codex is the brain, Claude is
   * the body. Planning and reviewing are both pure reads, so no profile grants write.
   */
  readonly sandbox: SandboxMode;
  /** Word cap on the answer. An unbounded answer invites exploration over verdicts. */
  readonly wordCap: number | null;
  /** Require a diff (or other scope) on stdin. */
  readonly requiresScope: boolean;
  /** Maximum independent checks allowed in one call. */
  readonly maxChecks: number;
  /** Require a machine-checkable VERDICT line in the answer. */
  readonly requiresVerdict: boolean;
  readonly description: string;
}

export const PASS_PROFILES: Record<PassKind, PassProfile> = {
  // Hardest pass. Keeps xhigh; gets the longest leash of any scoped pass.
  adversarial: {
    description: "Try hard to break one falsifiable claim about a supplied diff.",
    kind: "adversarial",
    maxChecks: 1,
    requiresScope: true,
    requiresVerdict: true,
    sandbox: "read-only",
    wordCap: 400,
  },
  // Was "medium" on the theory that pattern-matching does not need xhigh. Raised to
  // xhigh because this tool is used for thinking, not for cheap bulk work, and a pass
  // that silently downgrades the model's reasoning is a footgun: you would ask for a
  // check and quietly get a worse thinker than every other pass. There is deliberately
  // no per-call escape hatch: `-r` and `--reasoning` are retired flags and are refused
  // (see RETIRED_FLAGS in cli.ts). Bound the question, not the thinking.
  mechanical: {
    description: "Mechanical house-rule/pattern checks against a supplied diff.",
    kind: "mechanical",
    maxChecks: 10,
    requiresScope: true,
    requiresVerdict: true,
    sandbox: "read-only",
    wordCap: 200,
  },
  // Planning converged fine at xhigh in 25 minutes. Left deliberately broad.
  // No bound lives here: --timeout is required per invocation. See docs/SPEC.md behaviour 4.
  plan: {
    description: "Design/plan a single artifact. Broad by nature; converges on one output.",
    kind: "plan",
    maxChecks: Number.POSITIVE_INFINITY,
    requiresScope: false,
    requiresVerdict: false,
    sandbox: "read-only",
    wordCap: null,
  },
  // The pass that failed. Every bound here is set from the 51s run that worked.
  review: {
    description: "Attack a specific property of a supplied diff. Must reach CLEAN or BROKEN.",
    kind: "review",
    maxChecks: 3,
    requiresScope: true,
    requiresVerdict: true,
    sandbox: "read-only",
    wordCap: 300,
  },
};

export const PASS_KINDS = Object.keys(PASS_PROFILES) as PassKind[];

export function isPassKind(value: string): value is PassKind {
  return Object.prototype.hasOwnProperty.call(PASS_PROFILES, value);
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

// Word-boundary matched so "previewing" does not read as "review" and "auditor"
// does not trip the audit rule via substring.
const VERIFICATION_PATTERN =
  /\b(review|reviews|reviewing|reviewed|verify|verifies|verifying|verified|verification|audit|audits|auditing|audited|critique|criticise|criticize|vet|vetting|falsify|sanity[-\s]?check|double[-\s]?check)\b/i;

/**
 * Does this prompt describe a verification pass?
 *
 * Used to decide whether the scope rule applies when no explicit --pass was given.
 * Deliberately generous: a false positive costs one `--pass plan` flag, while a
 * false negative costs an unbounded run.
 */
export function looksLikeVerification(prompt: string): boolean {
  return VERIFICATION_PATTERN.test(prompt);
}

const BULLET_PATTERN = /^\s*(?:[-*+•]|\d+[.)])\s+\S/;

/**
 * Count independent checks enumerated in a prompt.
 *
 * The failing run packed ~25 of these into one call. Each bullet in a review prompt
 * is a separate investigation with its own stopping condition, and N of them in one
 * call has no joint stopping condition at all — which is precisely why it read 9,564
 * lines of whole files and never converged.
 */
export function countEnumeratedChecks(prompt: string): number {
  let count = 0;
  let inFence = false;

  for (const rawLine of prompt.split(/\r?\n/)) {
    // Fenced blocks are usually the supplied diff or sample code, not a checklist.
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (BULLET_PATTERN.test(rawLine)) count += 1;
  }

  return count;
}

// --------------------------------------------------------------------------
// Contract evaluation
// --------------------------------------------------------------------------

export type ViolationCode = "unscoped_verification" | "excessive_breadth" | "unratcheted_bypass";

/**
 * Minimum inline subject length before `--allow-unscoped` is honoured.
 *
 * "Unscoped" was only ever meant to mean "the scope is not a diff on stdin" — not "there
 * is no subject at all". The one documented legitimate use is the P3 stress-test in
 * SKILL.md, which pastes an entire plan into `--property` and so runs to thousands of
 * characters. A bypass reaching for the flag to dodge the scope rule looks like
 * `--allow-unscoped --property "check the auth module"`, around 25. The floor separates
 * those two by an order of magnitude without needing to guess intent.
 */
export const MIN_INLINE_SUBJECT_CHARS = 200;

export interface ContractViolation {
  readonly code: ViolationCode;
  readonly message: string;
  readonly remedy: string;
}

export interface ContractInput {
  readonly prompt: string;
  /** Text piped on stdin, if any. This is how scope is supplied. */
  readonly scopeText: string | null;
  /** Explicit --pass, or null to infer from the prompt. */
  readonly passKind: PassKind | null;
  /** --max-checks override. */
  readonly maxChecks?: number | null;
  /** --allow-unscoped: explicit, per-call opt-out of the scope rule. */
  readonly allowUnscoped?: boolean;
}

export interface ContractDecision {
  readonly passKind: PassKind;
  readonly profile: PassProfile;
  readonly violations: ContractViolation[];
  /** True when the invocation may proceed. */
  readonly ok: boolean;
  /**
   * Which control this invocation actually switched off, or null when it relied on none.
   *
   * Only set when the bypass was load-bearing: passing `--allow-unscoped` alongside a
   * piped diff bypasses nothing and is not recorded as a bypass.
   */
  readonly bypass: BypassKind | null;
}

/**
 * Resolve which pass profile applies.
 *
 * An explicit --pass always wins. Otherwise a verification-shaped prompt is treated
 * as a review (the bounded default) and everything else as a plan (the broad one).
 */
export function resolvePassKind(prompt: string, explicit: PassKind | null): PassKind {
  if (explicit) return explicit;
  return looksLikeVerification(prompt) ? "review" : "plan";
}

/**
 * Rule 0 — ratchet the bypass. Only called when the bypass is actually load-bearing.
 *
 * A generic escape hatch weakens more than the rule it opens, unless its semantics are
 * narrow and its use is visible afterwards. Two conditions, both cheap:
 *
 *   * The pass must be named explicitly. Bypassing an *inferred* pass means neither the
 *     caller nor the tool knows which lane was opened.
 *   * The subject must actually be present in the invocation. "Unscoped" means the scope
 *     is not a diff on stdin — it never meant there is no subject.
 *
 * This deliberately keeps SKILL.md's P3 stress-test working: `--pass adversarial` is
 * explicit and the plan is pasted into --property, so both conditions hold.
 *
 * @returns the violation, or null when the bypass is honoured
 */
function checkBypassRatchet(input: ContractInput, passKind: PassKind): ContractViolation | null {
  const reasons: string[] = [];
  if (input.passKind === null) {
    reasons.push("the pass was inferred rather than named — add --pass " + passKind + " to say which lane you mean");
  }
  if (input.prompt.trim().length < MIN_INLINE_SUBJECT_CHARS) {
    reasons.push(
      `the subject is only ${input.prompt.trim().length} characters, under the ` +
        `${MIN_INLINE_SUBJECT_CHARS}-character floor — supply the material inline ` +
        "(a plan, a spec, the text under attack) or pipe a diff instead",
    );
  }

  if (reasons.length === 0) return null;

  return {
    code: "unratcheted_bypass",
    message: "--allow-unscoped is not honoured here: " + reasons.join("; and ") + ".",
    remedy:
      '--allow-unscoped means "the scope is not a diff", not "there is no scope". Its one\n' +
      "  documented use is the P3 stress-test, where the plan under attack is supplied inline:\n" +
      "    codex-agent start --pass adversarial --allow-unscoped \\\n" +
      '      --property "This plan survives contact with production: <the whole plan>"\n' +
      "  Otherwise pipe the diff:\n" +
      '    git diff origin/main...HEAD -- path | codex-agent start "..." --pass ' +
      passKind +
      "\n  Every honoured bypass is recorded and shows up in `codex-agent ledger`.",
  };
}

/**
 * Rule 1 — refuse an unscoped verification.
 *
 * This single rule deletes the 114 whole-file reads. Without a diff the agent
 * reconstructed context with 50 `nl -ba` and 64 `sed -n` calls over 9,564 lines of
 * whole files, when the diff itself was 5,705 lines. Whole files also fail to
 * localise the reasoning, so it never knew when it was done.
 *
 * @returns the violation, or null when the pass is scoped or the bypass was requested
 */
function checkScopeRule(
  input: ContractInput,
  profile: PassProfile,
  passKind: PassKind,
  hasScope: boolean,
): ContractViolation | null {
  if (!profile.requiresScope || hasScope || input.allowUnscoped) return null;

  return {
    code: "unscoped_verification",
    message:
      `This is a ${passKind} pass and nothing was supplied on stdin. ` +
      `Refusing to run: an unscoped verification has no stopping condition.`,
    remedy:
      "Pipe the diff:\n" +
      '  git diff origin/main...HEAD -- path/a path/b | codex-agent start "..." --pass ' +
      passKind +
      "\n" +
      "If the scope genuinely is the whole tree, pass --allow-unscoped to say so explicitly.",
  };
}

/**
 * Rule 2 — breadth guard.
 *
 * @returns the violation, or null when the prompt enumerates no more checks than the pass allows
 */
function checkBreadthGuard(input: ContractInput, profile: PassProfile, passKind: PassKind): ContractViolation | null {
  const maxChecks = input.maxChecks ?? profile.maxChecks;
  const checkCount = countEnumeratedChecks(input.prompt);
  if (!Number.isFinite(maxChecks) || checkCount <= maxChecks) return null;

  return {
    code: "excessive_breadth",
    message:
      `Prompt enumerates ${checkCount} independent checks; the limit for a ${passKind} ` +
      `pass is ${maxChecks}. Refusing to run.`,
    remedy:
      "Fan out instead — one property per call, run in parallel:\n" +
      '  for prop in ...; do git diff ... | codex-agent start "PROPERTY: $prop" --pass ' +
      passKind +
      "; done\n" +
      "N properties in one call have no joint stopping condition. That is the shape " +
      "that ran 1h50m without a verdict.\n" +
      "Raise the limit with --max-checks N if you are certain.",
  };
}

/**
 * Apply every contract rule to one invocation.
 *
 * THE ORDER OF THIS ARRAY IS THE CONTRACT. When an invocation breaks two rules at once, the
 * caller sees them in this order, and the first is the one they will act on. Rule 0 comes first
 * because an unhonoured bypass explains why the scope rule is about to fire; reporting the
 * missing diff first would name the symptom and hide the cause.
 *
 * @param input the invocation to judge
 * @returns the decision: the resolved pass, its profile, every violation, and any honoured bypass
 */
export function evaluateContract(input: ContractInput): ContractDecision {
  const passKind = resolvePassKind(input.prompt, input.passKind);
  const profile = PASS_PROFILES[passKind];

  const hasScope = Boolean(input.scopeText && input.scopeText.trim().length > 0);
  // The bypass only does work when the scope rule would otherwise have refused this call.
  const bypassIsLoadBearing = profile.requiresScope && !hasScope && Boolean(input.allowUnscoped);

  const violations = [
    bypassIsLoadBearing ? checkBypassRatchet(input, passKind) : null,
    checkScopeRule(input, profile, passKind, hasScope),
    checkBreadthGuard(input, profile, passKind),
  ].filter((violation): violation is ContractViolation => violation !== null);

  return {
    bypass: bypassIsLoadBearing ? "unscoped" : null,
    ok: violations.length === 0,
    passKind,
    profile,
    violations,
  };
}

export function formatViolations(violations: ContractViolation[]): string {
  return violations.map((violation) => `contract: ${violation.message}\n\n${violation.remedy}`).join("\n\n---\n\n");
}

// --------------------------------------------------------------------------
// Prompt shaping — the shape proven at 51 seconds
// --------------------------------------------------------------------------

export const VERDICT_CLEAN = "CLEAN";
export const VERDICT_BROKEN = "BROKEN";

const VERDICT_PATTERN = /^\s*VERDICT:\s*(CLEAN|BROKEN)\b/im;

/**
 * Did the agent actually produce a verdict?
 *
 * The failing run's defining property was not that it looped — it made 115 distinct,
 * methodical calls. It simply never concluded. "Verdict produced: no" is the metric
 * that makes non-convergence measurable rather than anecdotal, so it has to be
 * machine-checkable, which is why the prompt demands a fixed VERDICT: line.
 */
export function extractVerdict(text: string | null | undefined): string | null {
  if (!text) return null;
  const verdict = text.match(VERDICT_PATTERN)?.[1];
  return verdict ? verdict.toUpperCase() : null;
}

export interface ShapePromptOptions {
  /** The single falsifiable claim under attack. */
  readonly property: string;
  readonly profile: PassProfile;
  /** Diff or other scope, as piped on stdin. */
  readonly scopeText: string | null;
  /**
   * Tri-state: `undefined` defers to the profile, `null` means no cap, a number caps
   * explicitly. `??` alone would collapse "no cap" back into the profile default.
   */
  readonly wordCap?: number | null | undefined;
}

/**
 * Build the bounded prompt.
 *
 * This is the shape that answered correctly in 51 seconds and 31k tokens, kept
 * close to verbatim because its specifics are load-bearing: one property, an
 * explicit instruction not to read other files, a word cap, and a required verdict
 * token. Widening any of these reproduces the failure.
 */
export function shapeVerificationPrompt(options: ShapePromptOptions): string {
  const wordCap = options.wordCap === undefined ? options.profile.wordCap : options.wordCap;
  const lines = [
    "Attack ONE property. Ignore everything else.",
    "",
    `PROPERTY: ${options.property.trim()}`,
    "",
    "Find a concrete input that breaks it.",
  ];

  if (options.profile.requiresVerdict) {
    lines.push(
      "",
      `End your answer with exactly one line: "VERDICT: ${VERDICT_BROKEN}" if you found a`,
      `concrete breaking input, or "VERDICT: ${VERDICT_CLEAN}" if you could not.`,
      "A reply without that line is a failed run, not a cautious one.",
    );
  }

  if (wordCap) {
    lines.push("", `Answer in under ${wordCap} words.`);
  }

  if (options.scopeText && options.scopeText.trim()) {
    lines.push(
      "",
      "Do not read other files. The material below is complete for this question.",
      "",
      "=== DIFF ===",
      options.scopeText.trimEnd(),
    );
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Convergence heartbeat
// --------------------------------------------------------------------------

export interface HeartbeatInput {
  readonly elapsedMs: number;
  readonly execCount: number;
  readonly verdict: string | null;
  /** Minutes with no verdict before reporting. */
  readonly afterMinutes?: number;
  /** Exec calls with no verdict before reporting. */
  readonly afterExecs?: number;
}

export interface HeartbeatReport {
  readonly shouldReport: boolean;
  readonly message: string | null;
  readonly triggeredBy: "minutes" | "execs" | null;
  /**
   * True when the agent looks blocked rather than merely slow.
   *
   * Found by running this contract for real: the first live adversarial pass sat for
   * 7 minutes on an interactive "do you trust this directory?" prompt and burned its
   * whole wall-clock bound. Zero exec calls and zero tokens after minutes is a
   * completely different failure from 115 exec calls and no verdict, and saying
   * "not converging" for it sends you off narrowing a property that was never the
   * problem.
   */
  readonly looksBlocked: boolean;
}

export const DEFAULT_HEARTBEAT_MINUTES = 5;
export const DEFAULT_HEARTBEAT_EXECS = 40;

/**
 * Decide whether to report non-convergence.
 *
 * The 2026-07-26 run gave no signal at all for 110 minutes. The point of this is not
 * to kill the job — it is to say the quiet part out loud while it is still happening:
 * "115 execs, no verdict, still reading whole files."
 */
export function evaluateHeartbeat(input: HeartbeatInput): HeartbeatReport {
  if (input.verdict) {
    return { looksBlocked: false, message: null, shouldReport: false, triggeredBy: null };
  }

  const afterMinutes = input.afterMinutes ?? DEFAULT_HEARTBEAT_MINUTES;
  const afterExecs = input.afterExecs ?? DEFAULT_HEARTBEAT_EXECS;

  const byExecs = input.execCount >= afterExecs;
  const byMinutes = input.elapsedMs >= afterMinutes * 60_000;

  if (!byExecs && !byMinutes) {
    return { looksBlocked: false, message: null, shouldReport: false, triggeredBy: null };
  }

  // An agent that has made no tool calls at all after minutes of wall clock is not
  // failing to converge — it has not started. Usually an interactive prompt.
  const looksBlocked = input.execCount === 0;

  const message = looksBlocked
    ? `agent appears BLOCKED, not working: 0 exec calls after ${formatElapsed(input.elapsedMs)}. ` +
      `Check for an interactive prompt with: codex-agent capture <jobId> 40 --clean`
    : `not converging: ${input.execCount} exec calls, ${formatElapsed(input.elapsedMs)} elapsed, ` +
      `no verdict yet. Narrow the property or supply the diff.`;

  return {
    looksBlocked,
    message,
    shouldReport: true,
    triggeredBy: byExecs ? "execs" : "minutes",
  };
}

// --------------------------------------------------------------------------
// Run ledger
// --------------------------------------------------------------------------

/**
 * Why a run was stopped.
 *
 * Re-exported from bounds.ts rather than redeclared. It was previously a separate union here,
 * which is how "blocked" survived in one copy after the transport that could block was gone —
 * two spellings of one concept drift, and the concept is a ceiling.
 */
export type BreachReason = KillReason;

/**
 * A contract control the caller deliberately switched off.
 *
 * Recorded so a bypass is visible after the fact. An invisible escape hatch is
 * indistinguishable from no contract at all.
 */
export type BypassKind = "unscoped" | "no-contract";

export interface RunLedger {
  readonly jobId: string;
  readonly passKind: PassKind | null;
  readonly reasoning: string;
  readonly model: string;
  readonly durationMs: number | null;
  /**
   * Tokens Codex reported actually spending, from its own `Token usage: total=` line.
   * null means it was never reported — NOT zero, and never a stand-in from elsewhere.
   */
  readonly tokensSpent: number | null;
  /**
   * Cumulative INPUT tokens read off the Codex session file.
   *
   * This is not spend and must never be presented as it. It excludes output entirely and
   * counts re-sent context on every turn, so a long conversation inflates it without
   * limit. It used to be silently substituted for `tokensSpent` whenever the usage line
   * was missing, which is why two near-identical plan runs reported 253,275 and 1,109,604
   * — a 4.4x spread that was pure measurement artifact, on the field anyone would have
   * built a token ceiling from.
   */
  readonly cumulativeInputTokens: number | null;
  readonly execCount: number | null;
  readonly verdict: string | null;
  readonly verdictProduced: boolean;
  readonly scoped: boolean;
  /** Which contract control, if any, the caller switched off for this run. */
  readonly bypass: BypassKind | null;
  readonly timedOut: boolean;
  /** Set when a guard stopped this run. See guards.ts. */
  readonly breachReason: BreachReason | null;
}

/** How a run ended, in one token: a verdict, a breach, or nothing at all. */
export function formatOutcome(ledger: RunLedger): string {
  if (ledger.verdict) return ledger.verdict;
  if (ledger.breachReason) return `killed:${ledger.breachReason}`;
  if (ledger.timedOut) return "killed:wall_clock";
  return "NONE";
}

export function formatLedgerRow(ledger: RunLedger): string {
  const duration = ledger.durationMs === null ? "-" : formatElapsed(ledger.durationMs);
  const spent = ledger.tokensSpent === null ? "-" : ledger.tokensSpent.toLocaleString();
  const cumulativeInput = ledger.cumulativeInputTokens === null ? "-" : ledger.cumulativeInputTokens.toLocaleString();
  const execs = ledger.execCount === null ? "-" : String(ledger.execCount);

  return [
    ledger.jobId.padEnd(10),
    (ledger.passKind ?? "-").padEnd(12),
    duration.padEnd(8),
    spent.padStart(10),
    cumulativeInput.padStart(10),
    execs.padStart(6),
    (ledger.scoped ? "yes" : "no").padEnd(7),
    (ledger.bypass ?? "-").padEnd(11),
    formatOutcome(ledger),
  ].join("  ");
}

// SPENT and CUM-IN are two different quantities and are shown as two columns on purpose.
// A single "TOKENS" column is what let the two meanings blur together.
export const LEDGER_HEADER = [
  "JOB".padEnd(10),
  "PASS".padEnd(12),
  "DURATION".padEnd(8),
  "SPENT".padStart(10),
  "CUM-IN".padStart(10),
  "EXECS".padStart(6),
  "SCOPED".padEnd(7),
  "BYPASS".padEnd(11),
  "OUTCOME",
].join("  ");
