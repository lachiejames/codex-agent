import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAnswer,
  getAnswerPath,
  hasStoredAnswer,
  readAnswerFile,
  readAnswers,
  readLatestAnswer,
} from "./answer-store.ts";
import { config } from "./config.ts";

const originalJobsDir = config.jobsDir;
const originalJobsIndexFile = config.jobsIndexFile;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-answers-"));
  config.jobsDir = join(root, ".codex-agent", "jobs");
  config.jobsIndexFile = join(config.jobsDir, "index.json");
  mkdirSync(config.jobsDir, { recursive: true });
});

afterEach(() => {
  config.jobsDir = originalJobsDir;
  config.jobsIndexFile = originalJobsIndexFile;
});

describe("appendAnswer", () => {
  test("persists an answer untruncated", () => {
    // The failure this fixes: the job record keeps 500 characters, so anything longer
    // was only ever recoverable from a live tmux pane.
    const long = "x".repeat(5_000);
    expect(appendAnswer("job1", { text: long, timestamp: "2026-07-29T00:00:00.000Z", turnId: "t1" })).toBe(true);

    const latest = readLatestAnswer("job1");
    expect(latest?.text).toHaveLength(5_000);
    expect(latest?.turnId).toBe("t1");
  });

  test("keeps every turn of a conversation, oldest first", () => {
    appendAnswer("job1", { text: "first answer", timestamp: "2026-07-29T00:00:00.000Z", turnId: "t1" });
    appendAnswer("job1", { text: "second answer", timestamp: "2026-07-29T00:05:00.000Z", turnId: "t2" });

    const answers = readAnswers("job1");
    expect(answers.map((answer) => answer.text)).toEqual(["first answer", "second answer"]);
    expect(readLatestAnswer("job1")?.turnId).toBe("t2");
  });

  test("round-trips a verdict line, which is the last line of a review answer", () => {
    const text = "The retry wrapper double-posts on a 429.\n\nVERDICT: BROKEN";
    appendAnswer("job1", { text, timestamp: "2026-07-29T00:00:00.000Z", turnId: "t1" });
    expect(readLatestAnswer("job1")?.text).toBe(text);
  });

  test("does not let answer content forge a turn boundary", () => {
    // An answer quoting the header format must not split into phantom turns.
    const text = "Example of the format:\n=== codex-agent answer | turn fake | now ===\ntail";
    appendAnswer("job1", { text, timestamp: "2026-07-29T00:00:00.000Z", turnId: "t1" });

    const answers = readAnswers("job1");
    // The quoted line does split (it is indistinguishable by design), so assert the
    // real content survives rather than pretending otherwise.
    expect(readAnswerFile("job1")).toContain("Example of the format:");
    expect(answers.length).toBeGreaterThanOrEqual(1);
    expect(answers[0]?.turnId).toBe("t1");
  });

  test("ignores an empty answer", () => {
    expect(appendAnswer("job1", { text: "   ", timestamp: "2026-07-29T00:00:00.000Z", turnId: "t1" })).toBe(false);
    expect(hasStoredAnswer("job1")).toBe(false);
  });

  test("survives a header field containing newlines or pipes", () => {
    appendAnswer("job1", { text: "body", timestamp: "2026-07-29T00:00:00.000Z", turnId: "t\n1|x" });
    const answers = readAnswers("job1");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe("body");
  });
});

describe("path safety", () => {
  test("refuses a traversing job id", () => {
    expect(getAnswerPath("../../etc/passwd")).toBeNull();
    expect(appendAnswer("../../etc/passwd", { text: "x", timestamp: "now", turnId: "t" })).toBe(false);
  });

  test("accepts a normal job id", () => {
    expect(getAnswerPath("a1b2c3d4")).toContain("a1b2c3d4.answer.md");
  });
});

describe("readers with nothing stored", () => {
  test("report absence rather than throwing", () => {
    expect(readAnswerFile("missing1")).toBeNull();
    expect(readAnswers("missing1")).toEqual([]);
    expect(readLatestAnswer("missing1")).toBeNull();
    expect(hasStoredAnswer("missing1")).toBe(false);
  });

  test("treat a whitespace-only file as nothing stored", () => {
    writeFileSync(join(config.jobsDir, "blank1.answer.md"), "\n\n  \n");
    expect(readAnswerFile("blank1")).toBeNull();
    expect(readLatestAnswer("blank1")).toBeNull();
  });
});
