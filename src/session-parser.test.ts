import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findSessionFileForJob, parseSessionFile } from "./session-parser.ts";

function writeSession(lines: unknown[], extension = ".jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-agent-session-"));
  const path = join(dir, `rollout-test${extension}`);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
  return path;
}

function execCall(name: string) {
  return { type: "response_item", payload: { type: "function_call", name } };
}

describe("exec counting", () => {
  // The exec count is what turns "the review does not converge" from anecdote into a
  // number. On 2026-07-26 the answer was 115; a scoped run needed 4.
  test("counts exec_command calls, which is the name Codex currently emits", () => {
    const path = writeSession([execCall("exec_command"), execCall("exec_command"), execCall("exec_command")]);

    expect(parseSessionFile(path)?.exec_count).toBe(3);
  });

  test("counts the other shell tool names Codex has used across versions", () => {
    // Recognising only one name would silently report zero execs after an upgrade,
    // which would quietly disable the heartbeat rather than fail loudly.
    const path = writeSession([
      execCall("exec_command"),
      execCall("shell"),
      execCall("local_shell"),
      execCall("local_shell_call"),
      execCall("container.exec"),
    ]);

    expect(parseSessionFile(path)?.exec_count).toBe(5);
  });

  test("does not count non-shell tool calls", () => {
    const path = writeSession([
      execCall("exec_command"),
      { type: "response_item", payload: { type: "function_call", name: "apply_patch", input: "" } },
      { type: "response_item", payload: { type: "function_call", name: "update_plan" } },
    ]);

    expect(parseSessionFile(path)?.exec_count).toBe(1);
  });

  test("counts custom_tool_call as well as function_call", () => {
    const path = writeSession([
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec_command" } },
    ]);

    expect(parseSessionFile(path)?.exec_count).toBe(1);
  });

  test("reports zero rather than null for a session with no exec calls", () => {
    // The ledger distinguishes "no execs" from "unknown"; a null here would read as
    // a missing measurement instead of a real zero.
    const path = writeSession([
      { type: "event_msg", payload: { type: "agent_message", message: "Done." } },
    ]);

    expect(parseSessionFile(path)?.exec_count).toBe(0);
  });

  test("survives malformed lines without losing the count", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-session-"));
    const path = join(dir, "rollout-broken.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(execCall("exec_command")),
        "{ not valid json",
        "",
        JSON.stringify(execCall("exec_command")),
      ].join("\n"),
    );

    expect(parseSessionFile(path)?.exec_count).toBe(2);
  });

  test("still reports a count alongside the summary and token fields", () => {
    const path = writeSession([
      execCall("exec_command"),
      { type: "event_msg", payload: { type: "agent_message", message: "VERDICT: CLEAN" } },
    ]);

    const parsed = parseSessionFile(path);
    expect(parsed?.exec_count).toBe(1);
    expect(parsed?.summary).toBe("VERDICT: CLEAN");
  });

  test("returns null for a missing file", () => {
    expect(parseSessionFile("/nonexistent/path/rollout.jsonl")).toBeNull();
  });
});

describe("locating the session file for a job", () => {
  // Codex 0.145.0 never prints a session id, so the id-based lookup always fails and
  // every session-derived metric silently reads as unavailable. These cover the
  // fallback, including the concurrency collision that this contract's own adversarial
  // pass found in the first version of it.
  const originalCodexHome = process.env.CODEX_HOME;
  let codexHome: string;
  let sessionsDir: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-agent-home-"));
    sessionsDir = join(codexHome, "sessions", "2026", "07", "27");
    mkdirSync(sessionsDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  /** Local time, matching how Codex names rollout files. */
  function localStamp(hour: number, minute: number, second: number): number {
    return new Date(2026, 6, 27, hour, minute, second).getTime();
  }

  function writeRollout(
    name: string,
    cwd: string,
    prompt: string | null,
  ): string {
    const lines: unknown[] = [
      { type: "session_meta", payload: { type: "session_meta", session_id: name, cwd } },
    ];
    if (prompt !== null) {
      lines.push({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      });
    }
    const path = join(sessionsDir, name);
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
    return path;
  }

  test("finds the only session in the window for that directory", () => {
    const expected = writeRollout("rollout-2026-07-27T10-00-00-aaa.jsonl", "/work/repo", "do a thing");
    writeRollout("rollout-2026-07-27T10-00-00-bbb.jsonl", "/other/repo", "do a thing");

    const found = findSessionFileForJob({
      cwd: "/work/repo",
      startedAtMs: localStamp(10, 0, 0),
      endedAtMs: localStamp(10, 1, 0),
    });

    expect(found).toBe(expected);
  });

  test("disambiguates two concurrent jobs in the same directory by prompt", () => {
    // The exact scenario the adversarial pass produced: two sessions 2s apart, same
    // cwd, both inside the window. Nearest-in-time picks the wrong one.
    writeRollout(
      "rollout-2026-07-27T10-00-00-aaa.jsonl",
      "/work/repo",
      "Attack ONE property.\n\nPROPERTY: the other job's property",
    );
    const wanted = writeRollout(
      "rollout-2026-07-27T10-00-02-bbb.jsonl",
      "/work/repo",
      "Attack ONE property.\n\nPROPERTY: the requested job's property",
    );

    const found = findSessionFileForJob({
      cwd: "/work/repo",
      startedAtMs: localStamp(10, 0, 0),
      endedAtMs: localStamp(10, 1, 0),
      prompt: "Attack ONE property.\n\nPROPERTY: the requested job's property",
    });

    expect(found).toBe(wanted);
  });

  test("falls back to nearest-in-time when no candidate carries the prompt", () => {
    // Jobs recorded before prompt matching existed must still resolve.
    const nearest = writeRollout("rollout-2026-07-27T10-00-01-aaa.jsonl", "/work/repo", null);
    writeRollout("rollout-2026-07-27T10-00-45-bbb.jsonl", "/work/repo", null);

    const found = findSessionFileForJob({
      cwd: "/work/repo",
      startedAtMs: localStamp(10, 0, 0),
      endedAtMs: localStamp(10, 1, 0),
      prompt: "a prompt that appears in neither transcript",
    });

    expect(found).toBe(nearest);
  });

  test("ignores sessions outside the time window", () => {
    writeRollout("rollout-2026-07-27T08-00-00-aaa.jsonl", "/work/repo", "x");

    const found = findSessionFileForJob({
      cwd: "/work/repo",
      startedAtMs: localStamp(10, 0, 0),
      endedAtMs: localStamp(10, 1, 0),
    });

    expect(found).toBeNull();
  });

  test("ignores sessions from a different working directory", () => {
    writeRollout("rollout-2026-07-27T10-00-00-aaa.jsonl", "/somewhere/else", "x");

    const found = findSessionFileForJob({
      cwd: "/work/repo",
      startedAtMs: localStamp(10, 0, 0),
      endedAtMs: localStamp(10, 1, 0),
    });

    expect(found).toBeNull();
  });

  test("returns null rather than guessing when there are no sessions at all", () => {
    const found = findSessionFileForJob({
      cwd: "/work/repo",
      startedAtMs: localStamp(10, 0, 0),
      endedAtMs: localStamp(10, 1, 0),
      prompt: "anything",
    });

    expect(found).toBeNull();
  });
});
