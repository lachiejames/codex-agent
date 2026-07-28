// The diagnosable artifact.
//
// A killed run that says nothing is barely better than a burning one, and a *successful*
// run whose answer you cannot retrieve is worse than either — it looks like a failure and
// gets thrown away. Both happened on 2026-07-28. Job f343761d produced a substantive plan
// in 18 minutes and was written off as a total loss, because `output --clean` returned
// 53KB of Codex TUI box-drawing scrollback beginning with the splash screen, and the copy
// in the job record was truncated at 500 characters.
//
// So `codex-agent report <id>` answers exactly three questions, from persisted files
// rather than from a terminal that may no longer exist: what was asked, what came back,
// and why it was judged the way it was.

import {
  LEDGER_HEADER,
  formatLedgerRow,
  formatOutcome,
  type BreachReason,
  type PassKind,
  type RunLedger,
} from "./contract.ts";
import type { StoredAnswer } from "./answer-store.ts";

export interface JudgementInput {
  passKind: PassKind | null;
  /** Whether this pass profile demands a machine-checkable verdict. */
  requiresVerdict: boolean;
  status: "pending" | "running" | "completed" | "failed";
  verdict: string | null;
  breachReason: BreachReason | null;
  /** Whether any answer was persisted at all. */
  hasAnswer: boolean;
}

export interface Judgement {
  /** True when this run must not be treated as a usable result. */
  failed: boolean;
  summary: string;
  /** What to do about it. Empty when there is nothing to do. */
  remedy: string;
}

/**
 * Decide how a finished run should be read.
 *
 * Pure and table-tested, because this is the judgement a caller acts on. The ordering
 * matters: a breach explains itself better than a missing verdict does, and "blocked on a
 * human" must never be reported as "did not converge".
 */
export function judgeRun(input: JudgementInput): Judgement {
  if (input.breachReason === "blocked") {
    return {
      failed: true,
      summary: "Killed while blocked on an interactive Codex prompt — it never started work.",
      remedy:
        "Resolve the prompt (directory trust, approval policy, or login), then re-run. Do not " +
        "narrow the question: the question was never reached.",
    };
  }

  if (input.breachReason === "wall_clock") {
    return {
      failed: true,
      summary: "Killed at its wall-clock bound without concluding.",
      remedy:
        "Narrow the question and supply scope on stdin. Raise --timeout only once you know " +
        "the question is answerable in one pass.",
    };
  }

  if (input.breachReason === "stalled") {
    return {
      failed: true,
      summary:
        "Killed after every progress signal flat-lined — no log output, no token growth, " +
        "no completed turn.",
      remedy:
        "This is a hung session rather than a hard question. Check `codex-agent sessions` " +
        "and re-run; if it recurs, capture the pane before it dies.",
    };
  }

  if (input.requiresVerdict && !input.verdict) {
    return {
      failed: true,
      summary:
        "No VERDICT line. A reply without one is a failed run, not a cautious one — the pass " +
        "never reached CLEAN or BROKEN.",
      remedy: "Narrow to one falsifiable property and pipe the diff. Do not raise the timeout first.",
    };
  }

  if (!input.hasAnswer) {
    return {
      failed: true,
      summary: "No answer was ever persisted — the agent produced nothing to read.",
      remedy: "Check `codex-agent capture <id> 40 --clean` for a startup failure, then re-run.",
    };
  }

  if (input.verdict) {
    return {
      failed: false,
      summary: `Concluded with VERDICT: ${input.verdict}.`,
      remedy: "",
    };
  }

  return {
    failed: false,
    summary: "Produced an answer. This pass requires no verdict, so that is a complete result.",
    remedy: "",
  };
}

export interface RunReport {
  jobId: string;
  passKind: PassKind | null;
  status: "pending" | "running" | "completed" | "failed";
  /** The prompt as sent. */
  asked: string;
  answers: StoredAnswer[];
  /**
   * True when the answers shown are the old 500-character previews rather than durable
   * captures. Must be surfaced: a truncated answer read as a whole one is how a review's
   * verdict went missing, since the verdict is deliberately the last line.
   */
  answersTruncated: boolean;
  ledger: RunLedger | null;
  judgement: Judgement;
  breachMessage: string | null;
  /** Where the untruncated prompt lives, for when the preview below is cut. */
  promptPath: string | null;
}

/**
 * Characters of the prompt to show inline.
 *
 * A review prompt carries the whole diff — the recorded ones run to 84KB — and dumping
 * that buries the answer, which is the thing being asked for.
 */
const ASKED_PREVIEW_CHARS = 2_000;

export function formatRunReport(report: RunReport): string {
  const promptPath = report.promptPath;
  const lines: string[] = [
    `Report for job ${report.jobId}`,
    "=".repeat(`Report for job ${report.jobId}`.length),
    "",
    `Pass:      ${report.passKind ?? "-"}`,
    `Status:    ${report.status}`,
    `Outcome:   ${report.ledger ? formatOutcome(report.ledger) : "-"}`,
    `Judgement: ${report.judgement.failed ? "FAILED RUN" : "usable result"} — ${report.judgement.summary}`,
  ];

  if (report.judgement.remedy) {
    lines.push(`Remedy:    ${report.judgement.remedy}`);
  }

  if (report.breachMessage) {
    lines.push("", "--- Why it was stopped ---", report.breachMessage);
  }

  if (report.ledger) {
    lines.push("", "--- Ledger ---", LEDGER_HEADER, formatLedgerRow(report.ledger));
  }

  lines.push("", "--- Asked ---", "");
  if (report.asked.trim()) {
    lines.push(report.asked.slice(0, ASKED_PREVIEW_CHARS).trimEnd());
    if (report.asked.length > ASKED_PREVIEW_CHARS) {
      lines.push(
        "",
        `... (${(report.asked.length - ASKED_PREVIEW_CHARS).toLocaleString()} more characters` +
          (promptPath ? `; full prompt at ${promptPath}` : "") +
          ")"
      );
    }
  } else {
    lines.push("(the prompt was not recorded)");
  }

  lines.push("", "--- Answer ---", "");
  if (report.answers.length === 0) {
    lines.push(
      "(nothing persisted)",
      "",
      "An answer is written the moment Codex completes a turn. Nothing here means the run",
      "never finished a turn — not that the answer was lost."
    );
  } else {
    if (report.answersTruncated) {
      lines.push(
        "[truncated preview only — this run predates durable answer capture, so just the",
        " first 500 characters were kept. A verdict on the last line is not recoverable.]",
        ""
      );
    }
    report.answers.forEach((answer, index) => {
      if (report.answers.length > 1) {
        lines.push(`[turn ${index + 1} of ${report.answers.length} — ${answer.timestamp}]`, "");
      }
      lines.push(answer.text, "");
    });
  }

  return lines.join("\n").trimEnd();
}
