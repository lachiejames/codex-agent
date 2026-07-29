// The ledger row and the report, for a run.
//
// `report.ts` still owns the JUDGEMENT — how a finished run should be read — because that
// logic is transport-independent and table-tested. This file only maps a `Run` onto the
// shapes it and the ledger expect.

import { readAnswers } from "./answer-store.ts";
import { formatElapsed } from "./bounds.ts";
import { PASS_PROFILES, type RunLedger } from "./contract.ts";
import { judgeRun, type RunReport } from "./report.ts";
import { RUN_ARTIFACTS, type Run, runArtifactPath } from "./run-store.ts";

function computeDurationMs(run: Run): number | null {
  const startedAt = run.startedAt ?? run.createdAt;
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;

  const endMs = run.completedAt ? Date.parse(run.completedAt) : Date.now();
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
 */
export function buildRunLedger(run: Run): RunLedger {
  return {
    breachReason: run.breachReason,
    bypass: run.bypass,
    cumulativeInputTokens: run.metrics.cumulativeInputTokens,
    durationMs: computeDurationMs(run),
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

export function buildRunReport(run: Run): RunReport {
  const answers = readAnswers(run.id);
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
    ledger: buildRunLedger(run),
    passKind: run.passKind,
    promptPath: runArtifactPath(run.id, RUN_ARTIFACTS.record),
    status: toReportStatus(run),
  };
}

/** One line of live progress, for `status` and the `--wait` meter. */
export function formatRunProgress(run: Run): string {
  const duration = computeDurationMs(run);
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
