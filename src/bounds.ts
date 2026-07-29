// The bound decision: continue, warn, or kill.
//
// One pure function, used by the supervisor (which can act on all three outcomes) and by any
// observing command (which can act on `kill` but not on `warn`). Two decision sites would
// drift, and the thing that drifts is a ceiling — so there is exactly one.
//
// ---------------------------------------------------------------------------
// WARN-THEN-KILL, and why the old kill-at-bound was a gamble
// ---------------------------------------------------------------------------
//
// The previous behaviour was: reach the bound, die. That makes every timeout a bet. Too tight
// and a good run is shot seconds from its verdict; too loose and a stray run burns an hour
// before anyone notices. Retuning the number does not fix it, because the right number depends
// on facts you only have after the run.
//
// So the bound now has two phases. At WARN_FRACTION of the bound the supervisor interrupts the
// agent and resumes it with an instruction to conclude now — interruption preserves everything
// the agent has already completed, verified against codex-cli 0.145.0. Only if that fails does
// the bound become fatal.
//
// The warn does NOT extend the deadline. Elapsed time is measured across the whole logical turn
// including the resumed continuation, so a run gets its bound and not a millisecond more. A
// `steer` from the operator is different — that is a new question, so it starts a new logical
// turn with a fresh bound. See supervisor.ts.
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY DOES NOT DO — carried over from guards.ts, still true
// ---------------------------------------------------------------------------
//
//   * No token ceiling. Measured over 87 runs, the plan judged excellent cost 13.7M tokens and
//     the one judged a catastrophe cost 2.8M. No ceiling separates them.
//   * No exec-count ceiling and no zero-exec fail-fast. `execCount: 0` is the HEALTHY signature
//     of a scoped pass, because the shaped prompt tells the agent not to read other files.
//   * The stall backstop requires EVERY progress signal to be flat at once. It is a hang
//     detector, not a budget: a run still emitting events is never stopped, however expensive.

/** Fraction of the bound at which the agent is told to wrap up. */
export const WARN_FRACTION = 0.85;

/**
 * Below this much remaining time a warn is pointless — the agent could not conclude inside it,
 * and the interrupt would cost more than it buys. Such a run simply runs to its bound.
 */
export const MIN_WARN_REMAINING_MS = 30_000;

/** Minutes with every signal flat before the runaway backstop fires. */
export const DEFAULT_STALL_MINUTES = 10;

export type BoundAction = "continue" | "warn" | "kill";
export type KillReason = "wall_clock" | "stalled";

export interface BoundInput {
  /**
   * Milliseconds since the LOGICAL TURN began.
   *
   * Survives a warn-and-resume (same question, same deadline) and resets on an operator steer
   * (new question, new deadline). Measuring per-process instead would hand a run a fresh bound
   * every time it was warned, which is how a 10-minute bound becomes 18.5 minutes.
   */
  readonly turnElapsedMs: number;
  /** The caller's explicit bound. Required on every invocation; there is no default. */
  readonly timeoutMinutes: number;
  /** How long every progress signal has been flat. */
  readonly stalledForMs: number;
  readonly stallMinutes?: number | undefined;
  /** Whether this logical turn has already been warned. A turn is warned at most once. */
  readonly warned: boolean;
}

export interface BoundDecision {
  readonly action: BoundAction;
  readonly reason: KillReason | null;
  readonly message: string;
}

export function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return `${Math.floor(ms / 1000)}s`;
}

/** The instant, in ms from the turn's start, at which the agent should be told to wrap up. */
export function warnAtMs(timeoutMinutes: number): number {
  return Math.floor(timeoutMinutes * 60_000 * WARN_FRACTION);
}

/**
 * The instruction sent to an agent that is running out of time.
 *
 * Deliberately concrete about how long is left and about what a non-answer costs, because a
 * vague "please hurry" produces more thinking rather than a conclusion.
 */
export function buildWrapUpPrompt(remainingMs: number, requiresVerdict: boolean): string {
  const lines = [
    `You have ${formatElapsed(remainingMs)} left before this run is stopped.`,
    "Stop investigating now and answer with what you already have.",
  ];

  if (requiresVerdict) {
    lines.push(
      'End with exactly one line: "VERDICT: BROKEN" if you found a concrete breaking input,',
      'or "VERDICT: CLEAN" if you did not. An answer without that line is a failed run.',
    );
  }

  lines.push("Do not start any new investigation. Do not read any more files.");
  return lines.join("\n");
}

/**
 * Decide what to do with an in-flight invocation.
 *
 * Pure: every time-dependent input is passed in, so this is table-testable at exact boundary
 * values with no clock, no process and no Codex.
 *
 * An answered run is never passed here — the supervisor exits the watch loop the moment the
 * process ends. That is the same invariant the old guards enforced explicitly, relocated to
 * where it is structural rather than conditional: a concluded run goes idle by definition, so
 * its signals flat-line, and scoring that as a stall corrupts the exact number the ledger
 * exists to report.
 */
export function evaluateBound(input: BoundInput): BoundDecision {
  const boundMs = input.timeoutMinutes * 60_000;
  const stallMs = (input.stallMinutes ?? DEFAULT_STALL_MINUTES) * 60_000;

  // 1. Hard bound. Checked before the warn: once the bound has passed there is nothing left to
  //    wrap up into, and warning here would extend a run that is already over its limit.
  if (input.turnElapsedMs >= boundMs) {
    return {
      action: "kill",
      message:
        `bound of ${input.timeoutMinutes}m reached after ${formatElapsed(input.turnElapsedMs)} — stopping. ` +
        `This is the bound working, not a crash. Read what it produced with: codex-agent report <id>`,
      reason: "wall_clock",
    };
  }

  // 2. Stall backstop. Multi-condition by construction — `stalledForMs` only advances when the
  //    event stream, the token count AND the turn count are all flat together.
  if (input.stalledForMs >= stallMs) {
    return {
      action: "kill",
      message:
        `no progress for ${formatElapsed(input.stalledForMs)} — events, tokens and turns all flat. ` +
        `Stopping: it is no longer working.`,
      reason: "stalled",
    };
  }

  // 3. Warn, once, and only when there is enough time left for the agent to actually conclude.
  const remainingMs = boundMs - input.turnElapsedMs;
  if (!input.warned && input.turnElapsedMs >= warnAtMs(input.timeoutMinutes) && remainingMs >= MIN_WARN_REMAINING_MS) {
    return {
      action: "warn",
      message:
        `${formatElapsed(remainingMs)} left of a ${input.timeoutMinutes}m bound — ` +
        `interrupting to ask for a conclusion rather than killing a run that may be nearly done.`,
      reason: null,
    };
  }

  return { action: "continue", message: "", reason: null };
}
