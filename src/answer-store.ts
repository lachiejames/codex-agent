// Durable answers.
//
// A verdict that exists only in a live process is not a verdict. Two separate failures on
// 2026-07-28 said so, both under the retired tmux transport: one chat lost a whole planning
// pass when the tmux server died and took both sessions with it, and another went looking for
// the answer in terminal scrollback and got 53KB of Codex TUI box-drawing starting at the
// splash screen — while the answer it wanted sat in the run record, truncated to 500
// characters.
//
// Both are the same defect: the answer was never persisted as an answer. The 500-character
// preview stays where it is, because status listings need something short — but the full text
// is written to `<runId>.answer.md` when the supervisor concludes a turn, and
// `codex-agent report` reads that file. Nothing parses it back out of the event stream.

import { appendFileSync, readFileSync } from "fs";
import { resolve, sep } from "path";
import { config } from "./config.ts";

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isUnderJobsDir(filePath: string): boolean {
  const jobsDir = resolve(config.jobsDir);
  const resolved = resolve(filePath);
  return resolved === jobsDir || resolved.startsWith(`${jobsDir}${sep}`);
}

/** Path to a job's durable answer file, or null when the job id is not safe to use. */
export function getAnswerPath(jobId: string): string | null {
  if (!JOB_ID_PATTERN.test(jobId)) return null;

  const answerPath = resolve(config.jobsDir, `${jobId}.answer.md`);
  return isUnderJobsDir(answerPath) ? answerPath : null;
}

export interface StoredAnswer {
  turnId: string;
  timestamp: string;
  text: string;
}

// A line that cannot plausibly occur inside a Codex answer, so splitting on it never
// severs real content. Kept on one line for the same reason.
const ANSWER_HEADER_PREFIX = "=== codex-agent answer |";
const ANSWER_HEADER_PATTERN = /^=== codex-agent answer \| turn (.*?) \| (.*?) ===$/;

function formatHeader(answer: StoredAnswer): string {
  // Newlines in either field would break the one-line header contract above.
  const turnId = answer.turnId.replace(/[\r\n|]/g, " ").trim() || "-";
  const timestamp = answer.timestamp.replace(/[\r\n|]/g, " ").trim();
  return `${ANSWER_HEADER_PREFIX} turn ${turnId} | ${timestamp} ===`;
}

/**
 * Append one turn's answer, untruncated.
 *
 * Appends rather than overwrites so a multi-turn conversation keeps every answer — the
 * lost-pass failure above was a second turn overwriting nothing, but a conversation
 * driven by `send` produces several answers and losing the earlier ones would recreate
 * the same problem one level down.
 */
export function appendAnswer(jobId: string, answer: StoredAnswer): boolean {
  const answerPath = getAnswerPath(jobId);
  if (!answerPath) return false;
  if (!answer.text.trim()) return false;

  try {
    appendFileSync(answerPath, `${formatHeader(answer)}\n${answer.text.trimEnd()}\n\n`);
    return true;
  } catch {
    // The hook runs inside Codex's own process tree; a failed write must never take the
    // run down with it.
    return false;
  }
}

/** Raw contents of the answer file, or null when nothing has been persisted. */
export function readAnswerFile(jobId: string): string | null {
  const answerPath = getAnswerPath(jobId);
  if (!answerPath) return null;

  try {
    const content = readFileSync(answerPath, "utf-8");
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** Every persisted answer, oldest first. */
export function readAnswers(jobId: string): StoredAnswer[] {
  const content = readAnswerFile(jobId);
  if (!content) return [];

  const answers: StoredAnswer[] = [];
  let current: StoredAnswer | null = null;

  for (const line of content.split("\n")) {
    const match = ANSWER_HEADER_PATTERN.exec(line);
    if (match) {
      if (current) answers.push({ ...current, text: current.text.trim() });
      // Both capture groups are mandatory in the pattern, so a match always fills them.
      current = { text: "", timestamp: match[2] ?? "", turnId: match[1] ?? "" };
      continue;
    }
    if (current) current.text += `${line}\n`;
  }

  if (current) answers.push({ ...current, text: current.text.trim() });
  return answers.filter((answer) => answer.text.length > 0);
}

/** The most recent persisted answer — the one a verdict would be in. */
export function readLatestAnswer(jobId: string): StoredAnswer | null {
  const answers = readAnswers(jobId);
  return answers.at(-1) ?? null;
}

export function hasStoredAnswer(jobId: string): boolean {
  return readAnswerFile(jobId) !== null;
}
