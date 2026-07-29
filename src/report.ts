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

import type { StoredAnswer } from "./answer-store.ts";
import {
  type BreachReason,
  formatLedgerRow,
  formatOutcome,
  LEDGER_HEADER,
  type PassKind,
  type RunLedger,
} from "./contract.ts";

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
 * Pure and table-tested, because this is the judgement a caller acts on. The ordering still
 * matters, for one remaining reason: a breach explains itself better than a missing verdict
 * does. A run killed at its bound has no verdict *because* it was killed, so reporting the
 * missing verdict first would name the symptom and hide the cause — and the two remedies point
 * opposite ways, one at the question's breadth and one at the transport.
 */
export function judgeRun(input: JudgementInput): Judgement {
  // There is no longer a "blocked" breach. Under the TUI transport an agent could sit forever
  // on "do you trust this directory?" and burn its whole bound in silence, so a whole guard
  // existed to detect that from scraped pane text. `codex exec` exits 1 in about a second with
  // the reason on stderr, which arrives here as an ordinary failure with a real message.
  if (input.breachReason === "wall_clock") {
    return {
      failed: true,
      remedy:
        "Narrow the question and supply scope on stdin. Raise --timeout only once you know " +
        "the question is answerable in one pass.",
      summary: "Killed at its wall-clock bound without concluding.",
    };
  }

  if (input.breachReason === "stalled") {
    return {
      failed: true,
      remedy:
        "This is a hung invocation rather than a hard question. Read the last events with " +
        "`codex-agent tail <id>` and the run's .stderr for what Codex said before it went " +
        "quiet, then re-run.",
      summary: "Killed after every progress signal flat-lined — no log output, no token growth, no completed turn.",
    };
  }

  if (input.requiresVerdict && !input.verdict) {
    return {
      failed: true,
      remedy: "Narrow to one falsifiable property and pipe the diff. Do not raise the timeout first.",
      summary:
        "No VERDICT line. A reply without one is a failed run, not a cautious one — the pass " +
        "never reached CLEAN or BROKEN.",
    };
  }

  if (!input.hasAnswer) {
    return {
      failed: true,
      remedy: "Check `codex-agent tail <id>` and the run's .stderr for a startup failure, then re-run.",
      summary: "No answer was ever persisted — the agent produced nothing to read.",
    };
  }

  if (input.verdict) {
    return {
      failed: false,
      remedy: "",
      summary: `Concluded with VERDICT: ${input.verdict}.`,
    };
  }

  return {
    failed: false,
    remedy: "",
    summary: "Produced an answer. This pass requires no verdict, so that is a complete result.",
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
          ")",
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
      "never finished a turn — not that the answer was lost.",
    );
  } else {
    if (report.answersTruncated) {
      lines.push(
        "[truncated preview only — this run predates durable answer capture, so just the",
        " first 500 characters were kept. A verdict on the last line is not recoverable.]",
        "",
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
