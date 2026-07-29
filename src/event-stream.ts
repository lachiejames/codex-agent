// Parsing `codex exec --json`.
//
// This module replaces three separate reverse-engineering efforts that the TUI transport
// forced on us: `session-parser.ts` (walking ~/.codex/sessions to recover an exec count),
// `usage-parser.ts` (regexing a `script(1)` log for a token line), and `output-cleaner.ts`
// (guessing which terminal glyphs were noise). All three existed because the pane could not
// be trusted. `codex exec --json` emits a typed event per line, so none of them are needed.
//
// The shape, observed on codex-cli 0.145.0:
//
//   {"type":"thread.started","thread_id":"019f..."}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"...",
//                                  "aggregated_output":"","exit_code":null,"status":"in_progress"}}
//   {"type":"item.completed","item":{"id":"item_1","type":"command_execution",...,"exit_code":0}}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens":39952,"cached_input_tokens":19200,
//                                     "cache_write_input_tokens":0,"output_tokens":85,
//                                     "reasoning_output_tokens":0}}
//
// This file is PURE: strings in, values out. No filesystem, no process, no clock. Everything
// that touches the world lives in `supervisor.ts`. That split is what makes the parsing
// table-testable at exact boundaries, which the session-file parser never was.
//
// One deliberate non-goal: the agent's answer is NOT sourced from here. `agent_message` items
// are an event-stream implementation detail that can change shape between Codex versions;
// `--output-last-message` is Codex's own contract for "this is the final answer". See
// docs/SPEC.md behaviour 9. The `lastAgentMessage` below exists only for live progress
// display, never as the answer of record.

/** Per-turn token usage, exactly as `turn.completed` reports it. */
export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export type CodexEvent =
  | { kind: "thread.started"; threadId: string }
  | { kind: "turn.started" }
  | { kind: "turn.completed"; usage: TurnUsage | null }
  | { kind: "turn.failed"; message: string | null }
  | { kind: "command.started"; command: string }
  | { kind: "command.completed"; command: string; exitCode: number | null }
  | { kind: "agent.message"; text: string }
  | { kind: "error"; message: string }
  /** A well-formed event this version does not model. Counted as progress, nothing more. */
  | { kind: "other"; type: string };

/**
 * Everything the supervisor and the ledger need, folded from the stream.
 *
 * `tokensSpent` and `cumulativeInputTokens` are two different quantities and are kept
 * separate here for the same reason the ledger prints them as two columns: they were once
 * silently substituted for one another, and two near-identical plan runs reported figures
 * 4.4x apart as a result. See docs/SPEC.md behaviour 3.
 */
export interface StreamMetrics {
  threadId: string | null;
  /**
   * Total well-formed events seen. This is the runaway backstop's liveness signal.
   *
   * It replaces the previous transport's log size + mtime + inode triple, which needed five
   * adversarial passes to get right and still only worked by watching a file for indirect
   * evidence of writing. A monotonically increasing count of parsed events is direct evidence,
   * cannot alias, and cannot be defeated by renaming a file.
   */
  eventCount: number;
  /** Completed shell/tool calls. `0` is the HEALTHY signature of a scoped pass. */
  execCount: number;
  turnsStarted: number;
  turnsCompleted: number;
  /** True billed tokens: input + output summed across every completed turn. */
  tokensSpent: number | null;
  /** Input tokens only, summed across turns. Includes context re-sent each turn. Not spend. */
  cumulativeInputTokens: number | null;
  /** Most recent agent message. For progress display only — never the answer of record. */
  lastAgentMessage: string | null;
  /** Most recent command Codex ran, for "what is it doing right now". */
  lastCommand: string | null;
  /** Reasons reported by the stream itself, oldest first. */
  errors: string[];
  /** Lines that were not parseable JSON. A non-zero count means the stream is suspect. */
  malformedLines: number;
}

export function emptyMetrics(): StreamMetrics {
  return {
    cumulativeInputTokens: null,
    errors: [],
    eventCount: 0,
    execCount: 0,
    lastAgentMessage: null,
    lastCommand: null,
    malformedLines: 0,
    threadId: null,
    tokensSpent: null,
    turnsCompleted: 0,
    turnsStarted: 0,
  };
}

// --------------------------------------------------------------------------
// Narrowing helpers
// --------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readFiniteNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A usage block is only trusted when every field is present and finite.
 *
 * Partial usage is worse than none: it would silently under-report spend under a column
 * heading that claims to be complete. `null` means "not measured", which the ledger renders
 * as `-` rather than as zero.
 */
function readUsage(raw: unknown): TurnUsage | null {
  if (!isRecord(raw)) return null;

  const inputTokens = readFiniteNumber(raw, "input_tokens");
  const cachedInputTokens = readFiniteNumber(raw, "cached_input_tokens");
  const cacheWriteInputTokens = readFiniteNumber(raw, "cache_write_input_tokens");
  const outputTokens = readFiniteNumber(raw, "output_tokens");
  const reasoningOutputTokens = readFiniteNumber(raw, "reasoning_output_tokens");

  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null
  ) {
    return null;
  }

  return {
    cachedInputTokens,
    cacheWriteInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

// --------------------------------------------------------------------------
// Line parsing
// --------------------------------------------------------------------------

/**
 * Parse one JSONL line into a modelled event.
 *
 * Returns null only when the line is not parseable JSON or carries no `type`. A well-formed
 * event of an unrecognised type becomes `{kind: "other"}` rather than null, so a Codex upgrade
 * that adds an event type does not make the stream look dead to the liveness counter.
 */
export function parseEventLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const type = readString(parsed, "type");
  if (!type) return null;

  switch (type) {
    case "thread.started": {
      const threadId = readString(parsed, "thread_id");
      return threadId ? { kind: "thread.started", threadId } : { kind: "other", type };
    }

    case "turn.started":
      return { kind: "turn.started" };

    case "turn.completed":
      return { kind: "turn.completed", usage: readUsage(parsed["usage"]) };

    case "turn.failed":
      return { kind: "turn.failed", message: readErrorMessage(parsed) };

    case "error":
      return { kind: "error", message: readErrorMessage(parsed) ?? "codex reported an error" };

    case "item.started":
    case "item.completed":
      return parseItemEvent(parsed, type === "item.completed");

    default:
      return { kind: "other", type };
  }
}

function readErrorMessage(source: Record<string, unknown>): string | null {
  const direct = readString(source, "message") ?? readString(source, "error");
  if (direct) return direct;

  const nested = source["error"];
  return isRecord(nested) ? readString(nested, "message") : null;
}

function parseItemEvent(parsed: Record<string, unknown>, completed: boolean): CodexEvent {
  const item = parsed["item"];
  if (!isRecord(item)) return { kind: "other", type: completed ? "item.completed" : "item.started" };

  const itemType = readString(item, "type");

  if (itemType === "command_execution") {
    const command = readString(item, "command") ?? "";
    if (!completed) return { command, kind: "command.started" };
    return { command, exitCode: readFiniteNumber(item, "exit_code"), kind: "command.completed" };
  }

  if (itemType === "agent_message" && completed) {
    const text = readString(item, "text");
    // An empty agent message carries no information and must not clobber a real earlier one.
    if (text !== null && text.trim().length > 0) return { kind: "agent.message", text };
  }

  return { kind: "other", type: itemType ?? "item" };
}

// --------------------------------------------------------------------------
// Folding
// --------------------------------------------------------------------------

/**
 * Fold one event into the running metrics, returning a new value.
 *
 * Pure and incremental so the supervisor can apply only the bytes that arrived since its last
 * read, rather than re-parsing a stream that grows without bound while a run is in flight.
 */
export function foldEvent(metrics: StreamMetrics, event: CodexEvent): StreamMetrics {
  const next: StreamMetrics = { ...metrics, eventCount: metrics.eventCount + 1 };

  switch (event.kind) {
    case "thread.started":
      // The FIRST thread id wins. A resumed invocation re-announces the same thread, but if a
      // future Codex ever reported a different one mid-stream, silently adopting it would point
      // every later `exec resume` at the wrong conversation.
      next.threadId = metrics.threadId ?? event.threadId;
      return next;

    case "turn.started":
      next.turnsStarted = metrics.turnsStarted + 1;
      return next;

    case "turn.completed": {
      next.turnsCompleted = metrics.turnsCompleted + 1;
      if (event.usage) {
        const spent = event.usage.inputTokens + event.usage.outputTokens;
        next.tokensSpent = (metrics.tokensSpent ?? 0) + spent;
        next.cumulativeInputTokens = (metrics.cumulativeInputTokens ?? 0) + event.usage.inputTokens;
      }
      return next;
    }

    case "turn.failed":
      if (event.message) next.errors = [...metrics.errors, event.message];
      return next;

    case "error":
      next.errors = [...metrics.errors, event.message];
      return next;

    case "command.started":
      if (event.command) next.lastCommand = event.command;
      return next;

    case "command.completed":
      // Counted on completion, not on start, so an in-flight call is never double-counted when
      // both its started and completed events land between two reads.
      next.execCount = metrics.execCount + 1;
      if (event.command) next.lastCommand = event.command;
      return next;

    case "agent.message":
      next.lastAgentMessage = event.text;
      return next;

    case "other":
      return next;
  }
}

/**
 * Split a buffer into complete lines plus whatever trailing fragment is left over.
 *
 * The supervisor reads a file that Codex is actively appending to, so the final line is
 * routinely a half-written JSON object. Folding that fragment would count it as a malformed
 * line and permanently inflate the suspect-stream counter for a perfectly healthy run, so the
 * remainder is carried forward to be completed by the next read instead.
 */
export function splitCompleteLines(buffer: string): { lines: string[]; remainder: string } {
  const newlineAt = buffer.lastIndexOf("\n");
  if (newlineAt === -1) return { lines: [], remainder: buffer };

  const complete = buffer.slice(0, newlineAt);
  return {
    lines: complete.split("\n").filter((line) => line.trim().length > 0),
    remainder: buffer.slice(newlineAt + 1),
  };
}

function countMalformedLine(metrics: StreamMetrics): StreamMetrics {
  return { ...metrics, malformedLines: metrics.malformedLines + 1 };
}

/** Fold a batch of complete lines into existing metrics. */
export function foldLines(metrics: StreamMetrics, lines: readonly string[]): StreamMetrics {
  let current = metrics;

  for (const line of lines) {
    const event = parseEventLine(line);
    if (!event) {
      current = countMalformedLine(current);
      continue;
    }
    current = foldEvent(current, event);
  }

  return current;
}

/** Parse a whole stream in one go. Convenience for tests and for reading a finished run. */
export function parseEventStream(text: string): StreamMetrics {
  const { lines } = splitCompleteLines(text.endsWith("\n") ? text : `${text}\n`);
  return foldLines(emptyMetrics(), lines);
}

/** Is a turn currently in flight? */
export function hasTurnInFlight(metrics: StreamMetrics): boolean {
  return metrics.turnsStarted > metrics.turnsCompleted;
}
