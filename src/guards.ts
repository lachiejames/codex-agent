// Run guards — the ceilings, and the decision to close a finished run.
//
// This module exists because the invocation contract only held on one invocation shape.
// The wall-clock bound, the convergence heartbeat, the blocking-prompt kill and the
// verdict reap all lived inside cli.ts's `waitForJobCompletion`, which only executes
// under `--wait` — while the persisted orchestration pattern told callers to use
// `start` without `--wait`. On the documented default path nothing bounded a run but a
// 60-minute log-inactivity check that only fired if someone happened to call `status`.
// A contract that holds on one invocation shape is not a contract, so the decision is
// extracted here as pure functions and applied from both paths.
//
// What this module deliberately does NOT do, measured on 2026-07-29 over 87 recorded
// runs:
//
//   * It does not cap tokens. The plan run judged "excellent" (job 1e2a3578: 25m, 83
//     exec calls) reported 13,684,096 tokens. The plan run judged a catastrophe
//     (f343761d: 18m) reported 2,813,071 — five times cheaper. No ceiling separates
//     them, so any token ceiling calibrated to kill the second one kills the first.
//     Worse, the number itself meant two different things until this PR (true spend for
//     42 runs, cumulative input for 37, reading 4.4x apart on near-identical jobs).
//     Fix the measurement first; guard on it once the numbers are comparable.
//
//   * It does not take an exec count, and must not start. `execCount === 0` is the
//     HEALTHY signature for every scoped pass, because `shapeVerificationPrompt` tells
//     the agent "Do not read other files": job a8106fca answered BROKEN correctly in
//     52s with zero exec calls, as did f3aa4214 (CLEAN, 23s) and 3365bd9a (CLEAN, 22s).
//     A fail-fast on zero execs would kill the exact 51s/31k run this whole contract is
//     calibrated on. `evaluateHeartbeat` in contract.ts already reports the condition
//     without acting on it; that restraint is correct and is left alone.
//
// So the only ceilings here are a wall clock and a runaway backstop that requires EVERY
// progress signal to be flat at once. Never guard on a single metric.
//
// Six adversarial passes over this file's own diff found five real defects in it, and four
// of those were one mistake repeated: treating the absence of evidence as evidence that a
// run is dead. The rule that survived is worth stating plainly — stall time accrues only
// while the log resolves, is the same file it was, and is genuinely not being written. A
// false negative costs one more stall window on a hung session; a false positive kills a
// working run, which is the failure this module exists to prevent.

import {
  formatElapsed,
  type BlockingPromptKind,
  type BreachReason,
  type PassKind,
} from "./contract.ts";
import { config } from "./config.ts";

// Recorded on the job so a breach is diagnosable after the fact. Declared in contract.ts
// because the run ledger reports it and this module imports that one.
export type { BreachReason };

export type GuardAction = "continue" | "reap" | "kill";

/**
 * Minutes with no progress at all before the runaway backstop fires.
 *
 * Deliberately generous. This is not a cost control — it is a hang detector, and the
 * only thing it must never do is interrupt a run that is still working.
 */
export const DEFAULT_STALL_MINUTES = config.runawayStallMinutes;

// --------------------------------------------------------------------------
// Progress tracking
// --------------------------------------------------------------------------

/** One observation of a running job. */
export interface ProgressSample {
  observedAtMs: number;
  /** Size of the job's `.log`. The progress signal that is always available. */
  logBytes: number;
  /**
   * Last-modified time of the job's `.log`, in ms. Zero when there is no log yet.
   *
   * Carried alongside the size because size alone can alias: a fourth adversarial pass
   * pointed out that a log truncated and regrown to exactly the same byte count between two
   * observations reads as unchanged, however much output was written in between. A live
   * writer always moves mtime. `jobs.ts` already treats log mtime as the liveness signal
   * for its inactivity check, so this is the same evidence, used consistently.
   */
  logMtimeMs: number;
  /**
   * Filesystem identity of the log — `"<dev>:<inode>"` — or null when the path does not
   * resolve at all.
   *
   * Two adversarial passes in a row attacked the same seam. First: unlink or rename the
   * `.log` after Codex has opened it, and Codex keeps appending to the now-nameless inode
   * while `stat` on the pathname returns nothing forever, so size and mtime read as a
   * permanent zero — flat, and indistinguishable from a hang. Then: rename it and plant an
   * unchanging decoy at the original path, which defeats a mere existence check because *a*
   * file resolves; it is just not the file being written.
   *
   * Identity closes the class rather than one more instance of it: a null means there is no
   * evidence, and a change means the file being watched is not the file that was being
   * watched. Either way, no stall time accrues from it.
   *
   * Nothing in this tool renames a live job's log, so both attacks need an outside actor.
   * The rule they break is the one worth keeping: never conclude a run is dead from
   * evidence that is missing, replaced, or otherwise not about the run.
   */
  logIdentity: string | null;
  /** True token spend, or null when Codex did not report it. */
  tokensSpent: number | null;
  /** Completed turns. */
  turnsCompleted: number;
}

/** Carried on the job between observations so the stall window survives process exits. */
export interface ProgressState {
  /** When the last sample that showed growth on ANY signal was observed. */
  lastProgressAtMs: number;
  logBytes: number;
  logMtimeMs: number;
  /** Log identity as last observed; see ProgressSample.logIdentity. */
  logIdentity: string | null;
  tokensSpent: number | null;
  turnsCompleted: number;
}

/**
 * Fold an observation into the progress state.
 *
 * Growth is measured against the PREVIOUS OBSERVATION, not against a high-water mark.
 *
 * A high-water mark was the first implementation and an adversarial review killed it: if
 * the log is ever truncated, a high-water mark forces a working run to climb all the way
 * back to its old size before any of its output counts as progress. Write slowly enough
 * and the stall window expires first, so the guard kills a run that is doing exactly what
 * it should. Only a live writer can make a file grow, so growth from a lower baseline is
 * real progress and must reset the clock.
 *
 * Where the two readings disagree, this errs toward "still working". A false negative
 * costs one more stall window on a hung session; a false positive kills a good run, which
 * is the failure this whole module is built to avoid.
 */
export function advanceProgress(
  previous: ProgressState | null,
  sample: ProgressSample
): ProgressState {
  if (!previous) {
    return {
      lastProgressAtMs: sample.observedAtMs,
      logBytes: sample.logBytes,
      logMtimeMs: sample.logMtimeMs,
      logIdentity: sample.logIdentity,
      tokensSpent: sample.tokensSpent,
      turnsCompleted: sample.turnsCompleted,
    };
  }

  // ANY change to the log counts — size in either direction, a moved mtime, or a
  // different inode.
  //
  // Growth is obviously progress. A shrink is counted too, because a second adversarial
  // pass found the hole left by only counting growth: if the log is truncated and regrows
  // to less than its previous reading between two observations, the comparison is
  // indistinguishable from regression, and a run appending output the whole time reads as
  // flat. Since observations on the background path can be minutes apart, that was enough
  // to kill a working run. Nothing in this system truncates a live log, so treating a
  // shrink as an event costs nothing — and a genuinely hung session's log is flat, not
  // shrinking, so the backstop still fires on the case it exists for.
  const changedLog =
    sample.logBytes !== previous.logBytes ||
    sample.logMtimeMs !== previous.logMtimeMs ||
    // A different inode is not the file we were watching, so what it says about staleness
    // is not about this run.
    sample.logIdentity !== previous.logIdentity;
  const grewTurns = sample.turnsCompleted > previous.turnsCompleted;
  // A first-ever token reading counts as progress; an unchanged or absent one does not.
  const grewTokens =
    sample.tokensSpent !== null &&
    (previous.tokensSpent === null || sample.tokensSpent > previous.tokensSpent);

  const grew = changedLog || grewTurns || grewTokens;

  return {
    lastProgressAtMs: grew ? sample.observedAtMs : previous.lastProgressAtMs,
    // What was actually observed — see the note above on why this is not a high-water mark.
    logBytes: sample.logBytes,
    logMtimeMs: sample.logMtimeMs,
    logIdentity: sample.logIdentity,
    // A turn counter never decreases, so a max here cannot mask real growth and does guard
    // against a corrupt record reading as a fresh turn later.
    turnsCompleted: Math.max(previous.turnsCompleted, sample.turnsCompleted),
    // A missing reading is not a reading of zero: keep the last one we had.
    tokensSpent: sample.tokensSpent ?? previous.tokensSpent,
  };
}

/** How long every progress signal has been flat. */
export function stalledForMs(state: ProgressState, nowMs: number): number {
  // A log that does not resolve gives no liveness evidence at all, and absent evidence is
  // not evidence of a hang. The backstop simply does not accumulate; the wall clock still
  // bounds the run.
  if (state.logIdentity === null) return 0;
  return Math.max(0, nowMs - state.lastProgressAtMs);
}

// --------------------------------------------------------------------------
// The decision
// --------------------------------------------------------------------------

export interface GuardInput {
  jobId: string;
  passKind: PassKind | null;
  /** Wall clock since the job started. */
  elapsedMs: number;
  /** The run's wall-clock bound in minutes, or null when it has none. */
  timeoutMinutes: number | null;
  /** How long every progress signal has been flat, from `stalledForMs`. */
  stalledForMs: number;
  /** Override the stall window. */
  stallMinutes?: number;
  /** The verdict this run produced, if any. */
  verdict: string | null;
  /** Whether this pass profile requires a verdict to count as concluded. */
  requiresVerdict: boolean;
  /** True when the agent has finished a turn and is sitting idle in the TUI. */
  idleAfterTurn: boolean;
  /**
   * Set when the pane is sitting on an interactive Codex prompt.
   *
   * Supplied by the caller rather than detected here so this stays pure. The first live
   * run of this contract spent its entire wall-clock bound on a "do you trust this
   * directory?" prompt and then reported "no verdict", which points at the wrong problem
   * entirely — so a blocked run is stopped immediately instead of waiting for the stall
   * window to expire.
   */
  blockingPrompt: { kind: BlockingPromptKind; hint: string | null } | null;
  /**
   * True when the caller asked for this run to conclude (`--wait`).
   *
   * A background run is deliberately left open — `SKILL.md` teaches `await-turn` for a
   * conversation you intend to continue, and auto-closing those would break multi-turn
   * use. Background runs are still bounded; they are just never auto-reaped.
   */
  reapWhenAnswered: boolean;
}

export interface GuardDecision {
  action: GuardAction;
  reason: BreachReason | null;
  /** Operator-facing explanation. Empty only when the action is `continue`. */
  message: string;
}

const CONTINUE: GuardDecision = { action: "continue", reason: null, message: "" };

/**
 * Decide what to do with a running job.
 *
 * Pure: every time-dependent input is passed in, so this is table-testable at exact
 * boundary values and needs no clock, no tmux and no Codex.
 */
export function evaluateGuards(input: GuardInput): GuardDecision {
  const stallMinutes = input.stallMinutes ?? DEFAULT_STALL_MINUTES;

  const pastBound =
    input.timeoutMinutes !== null && input.elapsedMs >= input.timeoutMinutes * 60_000;
  const stalled = input.stalledForMs >= stallMinutes * 60_000;

  // 1. AN ANSWERED RUN IS NEVER A BREACH.
  //
  // This is an invariant, not a first guess, and it took three adversarial passes to get
  // right. Earlier versions let an answered run fall through to the ceilings below, which
  // stamped `killed:wall_clock` — and then `killed:stalled` — on background jobs that had
  // already reached VERDICT: CLEAN. The stalled case is the nastier one: a run that has
  // answered goes idle *by definition*, so its log, tokens and turns all flat-line and the
  // backstop fires on every answered background job that outlives the stall window.
  // Recording a concluded run as a failure corrupts exactly the signal the ledger exists
  // to report.
  //
  // So an answered run has only two possible outcomes: close it, or leave it open.
  //
  // Closing it is right when the caller asked for a conclusion (`--wait`), or when any
  // bound has expired — a background run left open for another turn does not get to hold a
  // session forever. Either way it closes as *answered*, with reason null.
  //
  // This is also what stops the plan lane idling on the clock: job f343761d answered at
  // 14:12 and its session did not exit until 14:19, seven minutes of a 45-minute bound
  // spent on a run that was already done.
  const answered = input.requiresVerdict ? input.verdict !== null : input.idleAfterTurn;
  if (answered) {
    if (!input.reapWhenAnswered && !pastBound && !stalled) return CONTINUE;

    return {
      action: "reap",
      reason: null,
      message: input.verdict
        ? `verdict reached (${input.verdict}) — closing session ${input.jobId}.`
        : `turn complete — closing session ${input.jobId}.`,
    };
  }

  // 2. Blocked on a human. Not slow — not started. Reported first because every other
  //    message would send the reader off narrowing a question that was never the problem.
  if (input.blockingPrompt) {
    return {
      action: "kill",
      reason: "blocked",
      message:
        `job ${input.jobId} is BLOCKED on an interactive Codex prompt (${input.blockingPrompt.kind}), ` +
        `not working. Stopping it.` +
        (input.blockingPrompt.hint ? `\n  ${input.blockingPrompt.hint}` : "") +
        `\n  Inspect with: codex-agent capture ${input.jobId} 40 --clean`,
    };
  }

  // 3. Wall clock. The 2026-07-26 run had none, which is why it ran 1h50m.
  if (pastBound) {
    return {
      action: "kill",
      reason: "wall_clock",
      message:
        `wall-clock bound of ${input.timeoutMinutes}m reached after ` +
        `${formatElapsed(input.elapsedMs)} — stopping job ${input.jobId}. ` +
        `This is the bound working, not a crash. Narrow the question, or raise it with ` +
        `--timeout <minutes>. Read what it did produce with: codex-agent report ${input.jobId}`,
    };
  }

  // 4. Runaway backstop.
  //
  // Multi-condition by construction: `stalledForMs` only advances when the log, the
  // token count AND the turn count are all flat, so no single metric can trip this.
  // It is a hang detector, not a budget — a run that is still emitting output is never
  // stopped here however expensive it is.
  if (stalled) {
    return {
      action: "kill",
      reason: "stalled",
      message:
        `no progress for ${formatElapsed(input.stalledForMs)} — log, tokens and turns ` +
        `all flat. Stopping job ${input.jobId}: it is no longer working. ` +
        `Read what it did produce with: codex-agent report ${input.jobId}`,
    };
  }

  return CONTINUE;
}
