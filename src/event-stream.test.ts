import { describe, expect, it } from "bun:test";
import {
  emptyMetrics,
  foldEvent,
  foldLines,
  hasTurnInFlight,
  parseEventLine,
  parseEventStream,
  splitCompleteLines,
} from "./event-stream.ts";

// Captured verbatim from a real `codex exec --json` run on codex-cli 0.145.0 (the wc -l
// probe used to verify the transport). Synthetic fixtures would only prove the parser
// matches what this file imagines the format to be.
const THREAD_STARTED = `{"type":"thread.started","thread_id":"019fab0d-6d23-7843-a421-2fec40fbc98c"}`;
const TURN_STARTED = `{"type":"turn.started"}`;
const COMMAND_STARTED = `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'wc -l src/config.ts'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`;
const COMMAND_COMPLETED = `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'wc -l src/config.ts'","aggregated_output":"56 src/config.ts","exit_code":0,"status":"completed"}}`;
const AGENT_MESSAGE = `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"VERDICT: CLEAN"}}`;
const TURN_COMPLETED = `{"type":"turn.completed","usage":{"input_tokens":39952,"cached_input_tokens":19200,"cache_write_input_tokens":0,"output_tokens":85,"reasoning_output_tokens":0}}`;

const FULL_RUN = [THREAD_STARTED, TURN_STARTED, COMMAND_STARTED, COMMAND_COMPLETED, AGENT_MESSAGE, TURN_COMPLETED].join(
  "\n",
);

describe("parseEventLine", () => {
  it("reads the thread id off thread.started", () => {
    expect(parseEventLine(THREAD_STARTED)).toEqual({
      kind: "thread.started",
      threadId: "019fab0d-6d23-7843-a421-2fec40fbc98c",
    });
  });

  it("reads turn.started", () => {
    expect(parseEventLine(TURN_STARTED)).toEqual({ kind: "turn.started" });
  });

  it("reads the full usage block off turn.completed", () => {
    expect(parseEventLine(TURN_COMPLETED)).toEqual({
      kind: "turn.completed",
      usage: {
        cachedInputTokens: 19200,
        cacheWriteInputTokens: 0,
        inputTokens: 39952,
        outputTokens: 85,
        reasoningOutputTokens: 0,
      },
    });
  });

  it("distinguishes a started command from a completed one", () => {
    expect(parseEventLine(COMMAND_STARTED)).toEqual({
      command: "/bin/zsh -lc 'wc -l src/config.ts'",
      kind: "command.started",
    });
    expect(parseEventLine(COMMAND_COMPLETED)).toEqual({
      command: "/bin/zsh -lc 'wc -l src/config.ts'",
      exitCode: 0,
      kind: "command.completed",
    });
  });

  it("reads an agent message", () => {
    expect(parseEventLine(AGENT_MESSAGE)).toEqual({ kind: "agent.message", text: "VERDICT: CLEAN" });
  });

  it("returns null for a line that is not JSON", () => {
    expect(parseEventLine("Reading prompt from stdin...")).toBe(null);
  });

  it("returns null for an empty or whitespace-only line", () => {
    expect(parseEventLine("")).toBe(null);
    expect(parseEventLine("   \t ")).toBe(null);
  });

  it("returns null for JSON that is not an object", () => {
    expect(parseEventLine(`"a string"`)).toBe(null);
    expect(parseEventLine(`[1,2,3]`)).toBe(null);
    expect(parseEventLine(`null`)).toBe(null);
  });

  it("returns null for an object with no type", () => {
    expect(parseEventLine(`{"thread_id":"abc"}`)).toBe(null);
  });

  // A Codex upgrade that adds an event type must not make the stream look dead.
  it("models an unrecognised event type as other rather than dropping it", () => {
    expect(parseEventLine(`{"type":"turn.throttled","retry_in_ms":500}`)).toEqual({
      kind: "other",
      type: "turn.throttled",
    });
  });

  it("treats thread.started with no thread_id as other, not as a null-id thread", () => {
    expect(parseEventLine(`{"type":"thread.started"}`)).toEqual({
      kind: "other",
      type: "thread.started",
    });
  });

  it("reports usage as null when the block is partial", () => {
    const partial = `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}`;
    expect(parseEventLine(partial)).toEqual({ kind: "turn.completed", usage: null });
  });

  it("reports usage as null when a field is non-finite", () => {
    const broken = `{"type":"turn.completed","usage":{"input_tokens":"lots","cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}`;
    expect(parseEventLine(broken)).toEqual({ kind: "turn.completed", usage: null });
  });

  it("reports usage as null when turn.completed carries none at all", () => {
    expect(parseEventLine(`{"type":"turn.completed"}`)).toEqual({ kind: "turn.completed", usage: null });
  });

  it("ignores an empty agent message so it cannot clobber a real one", () => {
    expect(parseEventLine(`{"type":"item.completed","item":{"type":"agent_message","text":"   "}}`)).toEqual({
      kind: "other",
      type: "agent_message",
    });
  });

  it("carries a non-zero command exit code through", () => {
    const failed = `{"type":"item.completed","item":{"type":"command_execution","command":"false","exit_code":1,"status":"completed"}}`;
    expect(parseEventLine(failed)).toEqual({ command: "false", exitCode: 1, kind: "command.completed" });
  });

  it("reads an error message from a flat error event", () => {
    expect(parseEventLine(`{"type":"error","message":"stream disconnected"}`)).toEqual({
      kind: "error",
      message: "stream disconnected",
    });
  });

  it("reads an error message nested under an error object", () => {
    expect(parseEventLine(`{"type":"turn.failed","error":{"message":"model overloaded"}}`)).toEqual({
      kind: "turn.failed",
      message: "model overloaded",
    });
  });

  it("falls back to a fixed reason when an error event carries no message", () => {
    expect(parseEventLine(`{"type":"error"}`)).toEqual({
      kind: "error",
      message: "codex reported an error",
    });
  });
});

describe("parseEventStream", () => {
  it("folds a complete single-turn run", () => {
    const metrics = parseEventStream(FULL_RUN);

    expect(metrics.threadId).toBe("019fab0d-6d23-7843-a421-2fec40fbc98c");
    expect(metrics.eventCount).toBe(6);
    expect(metrics.execCount).toBe(1);
    expect(metrics.turnsStarted).toBe(1);
    expect(metrics.turnsCompleted).toBe(1);
    expect(metrics.lastAgentMessage).toBe("VERDICT: CLEAN");
    expect(metrics.lastCommand).toBe("/bin/zsh -lc 'wc -l src/config.ts'");
    expect(metrics.malformedLines).toBe(0);
    expect(metrics.errors).toEqual([]);
  });

  // SPENT and CUM-IN are separate quantities and must never collapse into one another.
  it("reports spend as input plus output, and cumulative input as input alone", () => {
    const metrics = parseEventStream(FULL_RUN);

    expect(metrics.tokensSpent).toBe(40037);
    expect(metrics.cumulativeInputTokens).toBe(39952);
  });

  it("sums both quantities across turns without conflating them", () => {
    const secondTurn = `{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0}}`;
    const metrics = parseEventStream(`${FULL_RUN}\n${TURN_STARTED}\n${secondTurn}`);

    expect(metrics.turnsCompleted).toBe(2);
    expect(metrics.tokensSpent).toBe(41047);
    expect(metrics.cumulativeInputTokens).toBe(40952);
  });

  it("leaves both token fields null when no turn ever completed", () => {
    const metrics = parseEventStream(`${THREAD_STARTED}\n${TURN_STARTED}\n${COMMAND_COMPLETED}`);

    expect(metrics.tokensSpent).toBe(null);
    expect(metrics.cumulativeInputTokens).toBe(null);
    expect(metrics.execCount).toBe(1);
  });

  // Zero execs is the healthy signature of a scoped pass, not a hang. See docs/SPEC.md #3.
  it("reports zero execs for a scoped pass that read nothing", () => {
    const metrics = parseEventStream([THREAD_STARTED, TURN_STARTED, AGENT_MESSAGE, TURN_COMPLETED].join("\n"));

    expect(metrics.execCount).toBe(0);
    expect(metrics.turnsCompleted).toBe(1);
    expect(metrics.lastAgentMessage).toBe("VERDICT: CLEAN");
  });

  it("counts an exec once even when both its events are present", () => {
    const metrics = parseEventStream(`${COMMAND_STARTED}\n${COMMAND_COMPLETED}`);
    expect(metrics.execCount).toBe(1);
  });

  it("counts malformed lines without letting them abort the fold", () => {
    const metrics = parseEventStream(`${THREAD_STARTED}\nnot json at all\n${TURN_COMPLETED}`);

    expect(metrics.malformedLines).toBe(1);
    expect(metrics.threadId).toBe("019fab0d-6d23-7843-a421-2fec40fbc98c");
    expect(metrics.turnsCompleted).toBe(1);
  });

  it("collects stream-reported errors oldest first", () => {
    const metrics = parseEventStream(`{"type":"error","message":"first"}\n{"type":"error","message":"second"}`);
    expect(metrics.errors).toEqual(["first", "second"]);
  });

  it("returns empty metrics for empty input", () => {
    expect(parseEventStream("")).toEqual(emptyMetrics());
    expect(parseEventStream("\n\n  \n")).toEqual(emptyMetrics());
  });

  // A resumed invocation re-announces the same thread. Adopting a *different* id mid-stream
  // would silently point every later `exec resume` at the wrong conversation.
  it("keeps the first thread id when a second is announced", () => {
    const other = `{"type":"thread.started","thread_id":"deadbeef-0000-0000-0000-000000000000"}`;
    expect(parseEventStream(`${THREAD_STARTED}\n${other}`).threadId).toBe("019fab0d-6d23-7843-a421-2fec40fbc98c");
  });
});

describe("splitCompleteLines", () => {
  it("returns no lines and holds everything back when there is no newline yet", () => {
    expect(splitCompleteLines(`{"type":"turn.st`)).toEqual({
      lines: [],
      remainder: `{"type":"turn.st`,
    });
  });

  it("carries a half-written trailing line forward as the remainder", () => {
    const result = splitCompleteLines(`${THREAD_STARTED}\n${TURN_STARTED}\n{"type":"item.comp`);

    expect(result.lines).toEqual([THREAD_STARTED, TURN_STARTED]);
    expect(result.remainder).toBe(`{"type":"item.comp`);
  });

  it("leaves an empty remainder when the buffer ends on a newline", () => {
    const result = splitCompleteLines(`${THREAD_STARTED}\n`);

    expect(result.lines).toEqual([THREAD_STARTED]);
    expect(result.remainder).toBe("");
  });

  it("drops blank lines rather than reporting them as content", () => {
    expect(splitCompleteLines(`${TURN_STARTED}\n\n\n${TURN_STARTED}\n`).lines).toEqual([TURN_STARTED, TURN_STARTED]);
  });

  it("returns nothing for an empty buffer", () => {
    expect(splitCompleteLines("")).toEqual({ lines: [], remainder: "" });
  });
});

describe("incremental folding", () => {
  // The supervisor reads only the bytes that arrived since its last read. Folding chunk by
  // chunk must land on exactly the same metrics as parsing the finished file in one go.
  it("matches a whole-stream parse when applied in arbitrary chunks", () => {
    const chunks = [
      `${THREAD_STARTED}\n${TURN_STARTED}\n`,
      `${COMMAND_STARTED}\n`,
      `${COMMAND_COMPLETED}\n${AGENT_MESSAGE}\n`,
      `${TURN_COMPLETED}\n`,
    ];

    let metrics = emptyMetrics();
    let carry = "";
    for (const chunk of chunks) {
      const { lines, remainder } = splitCompleteLines(carry + chunk);
      metrics = foldLines(metrics, lines);
      carry = remainder;
    }

    expect(carry).toBe("");
    expect(metrics).toEqual(parseEventStream(FULL_RUN));
  });

  it("survives a chunk boundary that lands mid-line", () => {
    const whole = `${THREAD_STARTED}\n${TURN_COMPLETED}\n`;
    const splitAt = 40;

    let metrics = emptyMetrics();
    let carry = "";
    for (const chunk of [whole.slice(0, splitAt), whole.slice(splitAt)]) {
      const { lines, remainder } = splitCompleteLines(carry + chunk);
      metrics = foldLines(metrics, lines);
      carry = remainder;
    }

    expect(metrics.malformedLines).toBe(0);
    expect(metrics.threadId).toBe("019fab0d-6d23-7843-a421-2fec40fbc98c");
    expect(metrics.tokensSpent).toBe(40037);
  });

  it("increments the liveness counter for every well-formed event, including unmodelled ones", () => {
    const metrics = foldLines(emptyMetrics(), [
      TURN_STARTED,
      `{"type":"turn.throttled"}`,
      `{"type":"some.future.event"}`,
    ]);

    expect(metrics.eventCount).toBe(3);
  });

  it("does not count a malformed line as liveness", () => {
    const metrics = foldLines(emptyMetrics(), [TURN_STARTED, "garbage"]);

    expect(metrics.eventCount).toBe(1);
    expect(metrics.malformedLines).toBe(1);
  });

  it("leaves the input metrics untouched", () => {
    const before = emptyMetrics();
    const after = foldEvent(before, { kind: "turn.started" });

    expect(before.turnsStarted).toBe(0);
    expect(after.turnsStarted).toBe(1);
  });
});

describe("hasTurnInFlight", () => {
  it("is true between a turn starting and completing", () => {
    expect(hasTurnInFlight(parseEventStream(`${THREAD_STARTED}\n${TURN_STARTED}`))).toBe(true);
  });

  it("is false once the turn completes", () => {
    expect(hasTurnInFlight(parseEventStream(FULL_RUN))).toBe(false);
  });

  it("is false before anything has started", () => {
    expect(hasTurnInFlight(emptyMetrics())).toBe(false);
  });

  it("is true again when a second turn starts", () => {
    expect(hasTurnInFlight(parseEventStream(`${FULL_RUN}\n${TURN_STARTED}`))).toBe(true);
  });
});

describe("threadsAnnounced — one run is one thread", () => {
  it("counts a single announcement", () => {
    expect(parseEventStream(FULL_RUN).threadsAnnounced).toBe(1);
  });

  it("is zero before any thread starts", () => {
    expect(parseEventStream(TURN_STARTED).threadsAnnounced).toBe(0);
  });

  // `codex exec resume` re-emits thread.started with the SAME id — verified on 0.145.0. Every
  // healthy multi-turn conversation does this, so it must not read as a violation. Counting
  // announcements rather than distinct ids killed a working second turn in a live test.
  it("does NOT count a resume re-announcing the same thread", () => {
    const metrics = parseEventStream(`${THREAD_STARTED}\n${TURN_COMPLETED}\n${THREAD_STARTED}`);

    expect(metrics.threadsAnnounced).toBe(1);
    expect(metrics.threadId).toBe("019fab0d-6d23-7843-a421-2fec40fbc98c");
  });

  // The first-wins rule on threadId deliberately hides a second id, so counting distinct ids is
  // what makes a genuine violation visible: a supervisor that started a NEW conversation instead
  // of resuming was previously undetectable from the record.
  it("counts a genuinely DIFFERENT thread id as a second thread", () => {
    const other = `{"type":"thread.started","thread_id":"019fac1e-2d62-7c81-8608-21527cc40489"}`;
    const metrics = parseEventStream(`${THREAD_STARTED}\n${other}`);

    expect(metrics.threadsAnnounced).toBe(2);
    expect(metrics.threadId).toBe("019fab0d-6d23-7843-a421-2fec40fbc98c");
  });

  it("does not count a malformed thread.started with no id", () => {
    expect(parseEventStream(`{"type":"thread.started"}`).threadsAnnounced).toBe(0);
  });
});
