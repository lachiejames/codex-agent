// The ledger row and the report, for a run.
//
// `report.ts` still owns the JUDGEMENT — how a finished run should be read — because that
// logic is transport-independent and table-tested. This file maps a `Run` onto the shapes it
// and the ledger expect.
//
// PURE CORE / EFFECTFUL SHELL. The header used to claim this file "only maps" a Run, and that
// was not true: `buildRunReport` read answers off the disk, and every duration came from
// `Date.now()` reached directly. Both are now parameters of the mapping functions, and the three
// exported wrappers at the bottom are the only code here that touches the world.
//
// That makes the mapping testable with a fixed clock, which matters more than it sounds: a
// duration derived from a live clock cannot be asserted exactly, so the ledger's DURATION column
// — the column this repo keeps for measuring runs against their bound — had no exact test.
//
// The wrappers keep EXACTLY one parameter each. `buildRunLedger` is used as
// `listRuns(...).map(buildRunLedger)`, and `Array.prototype.map` passes (element, index, array):
// giving the wrapper a second `nowMs` parameter would silently feed it the array index as the
// current time.

import { readAnswers, type StoredAnswer } from "./answer-store.ts";
import { formatElapsed } from "./bounds.ts";
import { PASS_PROFILES, type RunLedger } from "./contract.ts";
import { judgeRun, type RunReport } from "./report.ts";
import { RUN_ARTIFACTS, type Run, runArtifactPath } from "./run-store.ts";

// --------------------------------------------------------------------------
// Pure core — no clock, no filesystem
// --------------------------------------------------------------------------

/**
 * How long the run has been going, in ms, or null when its timestamps are unusable.
 *
 * @param run the run record
 * @param nowMs the current time, supplied so an in-flight run's duration is testable
 * @returns elapsed ms, never negative, or null when a timestamp will not parse
 */
export function computeDurationMs(run: Run, nowMs: number): number | null {
  const startedAt = run.startedAt ?? run.createdAt;
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;

  const endMs = run.completedAt ? Date.parse(run.completedAt) : nowMs;
  if (!Number.isFinite(endMs)) return null;

  return Math.max(0, endMs - startMs);
}

/**
 * Map a run onto a ledger row.
 *
 * Both token quantities come straight off the folded event stream now, and neither can stand in
 * for the other. Under the old transport `tokensSpent` fell back to the session file's
 * cumulative input whenever Codex's usage line was missing, so 42 of 87 recorded runs reported
 * spend and 37 reported cumulative input under the same column heading — reading 4.4x apart on
 * near-identical jobs. `turn.completed.usage` is structured, so there is nothing to fall back
 * from: a null here means not measured, and is printed as `-`.
 *
 * @param run the run record
 * @param nowMs the current time, for an unfinished run's duration
 * @returns the ledger row
 */
export function mapRunLedger(run: Run, nowMs: number): RunLedger {
  return {
    breachReason: run.breachReason,
    bypass: run.bypass,
    cumulativeInputTokens: run.metrics.cumulativeInputTokens,
    durationMs: computeDurationMs(run, nowMs),
    execCount: run.metrics.execCount,
    jobId: run.id,
    model: run.model,
    passKind: run.passKind,
    reasoning: run.reasoningEffort,
    scoped: run.scoped,
    timedOut: run.breachReason === "wall_clock",
    tokensSpent: run.metrics.tokensSpent,
    verdict: run.verdict,
    verdictProduced: run.verdict !== null,
  };
}

/** The old `Job["status"]` vocabulary that `judgeRun` and `RunReport` are written against. */
function toReportStatus(run: Run): "pending" | "running" | "completed" | "failed" {
  switch (run.status) {
    case "starting":
      return "pending";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "waiting":
    case "completed":
      return "completed";
  }
}

/**
 * Map a run plus its already-loaded answers onto the report shape.
 *
 * @param run the run record
 * @param answers every answer already read for this run, newest last
 * @param nowMs the current time, for an unfinished run's duration
 * @returns the report, ready to render
 */
export function mapRunReport(run: Run, answers: readonly StoredAnswer[], nowMs: number): RunReport {
  const profile = run.passKind ? PASS_PROFILES[run.passKind] : null;

  return {
    answers,
    // Every answer now comes from the file Codex itself wrote, so there is no truncated-preview
    // fallback left to warn about. The flag stays on the shape because report.ts renders it.
    answersTruncated: false,
    asked: run.prompt,
    breachMessage: run.breachMessage,
    jobId: run.id,
    judgement: judgeRun({
      breachReason: run.breachReason,
      hasAnswer: answers.length > 0,
      passKind: run.passKind,
      requiresVerdict: profile?.requiresVerdict ?? run.requiresVerdict,
      status: toReportStatus(run),
      verdict: run.verdict,
    }),
    ledger: mapRunLedger(run, nowMs),
    passKind: run.passKind,
    promptPath: runArtifactPath(run.id, RUN_ARTIFACTS.record),
    status: toReportStatus(run),
  };
}

/**
 * One line of live progress.
 *
 * @param run the run record
 * @param nowMs the current time, for the elapsed figure
 * @returns the progress line, ` · `-separated
 */
export function formatProgressLine(run: Run, nowMs: number): string {
  const duration = computeDurationMs(run, nowMs);
  const parts = [
    `${run.status}`,
    duration === null ? "-" : formatElapsed(duration),
    `${run.metrics.execCount} execs`,
    run.metrics.tokensSpent === null ? "spend not reported yet" : `${run.metrics.tokensSpent.toLocaleString()} spent`,
  ];

  if (run.metrics.lastCommand) parts.push(`last: ${run.metrics.lastCommand.slice(0, 60)}`);
  if (run.verdict) parts.push(`VERDICT: ${run.verdict}`);

  return parts.join(" · ");
}

// --------------------------------------------------------------------------
// Effectful shell — reads the clock and the disk, one parameter each
// --------------------------------------------------------------------------

/** Map a run onto a ledger row, against the current time. */
export function buildRunLedger(run: Run): RunLedger {
  return mapRunLedger(run, Date.now());
}

/** Read a run's answers and map it onto the report shape, against the current time. */
export function buildRunReport(run: Run): RunReport {
  return mapRunReport(run, readAnswers(run.id), Date.now());
}

/** One line of live progress, for `status` and the `--wait` meter. */
export function formatRunProgress(run: Run): string {
  return formatProgressLine(run, Date.now());
}
