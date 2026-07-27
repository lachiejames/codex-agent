import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "fs";
import { Buffer } from "node:buffer";
import type { Dirent } from "fs";
import { extname, join } from "path";

export type SessionTokens = {
  input: number;
  output: number;
  context_window: number;
  context_used_pct: number;
};

export type ParsedSessionData = {
  tokens: SessionTokens | null;
  files_modified: string[] | null;
  summary: string | null;
  /**
   * Number of shell/exec tool calls the agent made.
   *
   * This is the single most diagnostic number for non-convergence. The 2026-07-26
   * review made 115 of these over 110 minutes and still produced no verdict, while a
   * scoped run answered the same question in 51 seconds. Without this count, "it took
   * too long" is anecdote; with it, the run ledger can show that the agent was busy
   * reading rather than stuck.
   */
  exec_count: number;
};

// Codex has used more than one name for the shell tool across versions; count them
// all rather than silently reporting zero execs after an upgrade.
const EXEC_TOOL_NAMES = new Set<string>([
  "exec_command",
  "shell",
  "local_shell",
  "local_shell_call",
  "container.exec",
]);

const SESSION_EXTENSIONS = new Set<string>([".jsonl", ".json"]);

function getCodexHome(): string | null {
  const configured = process.env.CODEX_HOME;
  if (configured && configured.trim()) return configured;
  if (!process.env.HOME) return null;
  return join(process.env.HOME, ".codex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractAssistantText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];

  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = part.type;
    if (type !== "output_text" && type !== "text" && type !== "input_text") continue;
    const text = part.text;
    if (typeof text === "string") parts.push(text);
  }

  return parts.length > 0 ? parts.join("") : null;
}

function extractFilesFromPatch(patchText: string): string[] {
  const files: string[] = [];
  const prefixes = [
    "*** Update File: ",
    "*** Add File: ",
    "*** Delete File: ",
    "*** Move to: ",
  ];

  for (const line of patchText.split("\n")) {
    for (const prefix of prefixes) {
      if (!line.startsWith(prefix)) continue;
      const file = line.slice(prefix.length).trim();
      if (file) files.push(file);
    }
  }

  return files;
}

function extractPatchText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.includes("*** Begin Patch")) return raw;

  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  const parsed = parseJsonLine(trimmed);
  if (!isRecord(parsed)) return null;

  const patchValue = parsed.patch ?? parsed.input;
  if (typeof patchValue === "string" && patchValue.includes("*** Begin Patch")) {
    return patchValue;
  }

  return null;
}

function parseTokensFromInfo(info: Record<string, unknown>): SessionTokens | null {
  const totalUsage = info.total_token_usage;
  if (!isRecord(totalUsage)) return null;

  const inputTokens = toNumber(totalUsage.input_tokens);
  const outputTokens = toNumber(totalUsage.output_tokens);
  const contextWindow = toNumber(info.model_context_window);

  if (inputTokens === null || outputTokens === null || contextWindow === null) return null;
  const contextUsed = contextWindow > 0 ? (inputTokens / contextWindow) * 100 : 0;
  const contextUsedPct = Math.round(contextUsed * 100) / 100;

  return {
    input: inputTokens,
    output: outputTokens,
    context_window: contextWindow,
    context_used_pct: contextUsedPct,
  };
}

function parseJsonlSession(content: string): ParsedSessionData {
  const filesModified = new Set<string>();
  let tokens: SessionTokens | null = null;
  let summary: string | null = null;
  let execCount = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const record = parseJsonLine(line);
    if (!isRecord(record)) continue;

    const recordType = typeof record.type === "string" ? record.type : null;
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!recordType || !payload) continue;

    const payloadType = typeof payload.type === "string" ? payload.type : null;
    if (recordType === "event_msg" && payloadType === "token_count") {
      if (isRecord(payload.info)) {
        const parsedTokens = parseTokensFromInfo(payload.info);
        if (parsedTokens) tokens = parsedTokens;
      }
    }

    if (recordType === "event_msg" && payloadType === "agent_message") {
      const message = payload.message;
      if (typeof message === "string") summary = message;
    }

    if (recordType === "response_item" && payloadType === "message") {
      const role = payload.role;
      if (role === "assistant") {
        const messageText = extractAssistantText(payload.content);
        if (messageText) summary = messageText;
      }
    }

    if (recordType === "response_item") {
      const toolType = payloadType === "custom_tool_call" || payloadType === "function_call";
      const toolName = typeof payload.name === "string" ? payload.name : null;
      if (toolType && toolName && EXEC_TOOL_NAMES.has(toolName)) {
        execCount += 1;
      }
      if (toolType && toolName === "apply_patch") {
        const patchText = extractPatchText(payload.input ?? payload.arguments);
        if (patchText) {
          for (const file of extractFilesFromPatch(patchText)) {
            filesModified.add(file);
          }
        }
      }
    }
  }

  return {
    tokens,
    files_modified: Array.from(filesModified),
    summary,
    exec_count: execCount,
  };
}

function parseJsonSession(content: string): ParsedSessionData | null {
  const parsed = parseJsonLine(content);
  if (!isRecord(parsed)) return null;

  let summary: string | null = null;
  const items = parsed.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (item.role !== "assistant") continue;
      const messageText = extractAssistantText(item.content);
      if (messageText) summary = messageText;
    }
  }

  return {
    tokens: null,
    files_modified: [],
    summary,
    // The single-JSON transcript form carries no tool-call records to count.
    exec_count: 0,
  };
}

function stripAnsiCodes(text: string): string {
  // Remove ANSI escape sequences
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[\d;]*m/g, '');
}

export function extractSessionId(logContent: string): string | null {
  // Strip ANSI codes before matching
  const cleanContent = stripAnsiCodes(logContent);

  const patterns = [
    /session id:\s*([0-9a-f-]{8,})/i,
    /session_id[:=]\s*([0-9a-f-]{8,})/i,
    /sessionId["\s:=]*([0-9a-f-]{8,})/i,
  ];

  for (const pattern of patterns) {
    const match = cleanContent.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

export function findSessionFile(sessionId: string): string | null {
  if (!sessionId.trim()) return null;
  const codexHome = getCodexHome();
  if (!codexHome) return null;

  const sessionsDir = join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) return null;

  const stack: string[] = [sessionsDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const extension = extname(entry.name);
      if (!SESSION_EXTENSIONS.has(extension)) continue;
      if (fullPath.includes(sessionId)) return fullPath;
    }
  }

  return null;
}

/**
 * Locate a session file by working directory and time window.
 *
 * The id-based lookup above depends on Codex printing "session id: <uuid>" into the
 * captured pane. Codex 0.145.0's TUI never prints it, so extractSessionId always
 * returns null and every session-derived metric — token totals and, more importantly,
 * the exec count the run ledger and convergence heartbeat are built on — silently
 * reads as unavailable. That is a quietly-dead measurement, so match on what the
 * session file itself records instead: session_meta.payload.cwd plus the rollout
 * timestamp.
 */
export interface FindSessionForJobOptions {
  cwd: string;
  startedAtMs: number;
  endedAtMs: number;
  /**
   * The exact prompt the job was launched with.
   *
   * Working directory and timestamp proximity alone cannot identify a job: two agents
   * started seconds apart in the same directory both match, and the nearest-in-time
   * tiebreak can pick the wrong one. Since this orchestrator exists to run agents in
   * parallel, that is a live collision, not a theoretical one — it was found by
   * pointing this contract's own adversarial pass at the cwd-and-window lookup. The
   * prompt appears verbatim in the transcript, so it disambiguates exactly.
   */
  prompt?: string | null;
}

/**
 * Locate the session file for a specific job.
 *
 * Filters on cwd and time window first because that is cheap, then disambiguates on
 * prompt content. Falls back to nearest-in-time only when no candidate contains the
 * prompt, so jobs recorded before prompt matching existed still resolve.
 */
export function findSessionFileForJob(options: FindSessionForJobOptions): string | null {
  const candidates = findSessionCandidates(options.cwd, options.startedAtMs, options.endedAtMs);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].path;

  const prompt = options.prompt?.trim();
  if (prompt) {
    const matches = candidates.filter((candidate) => sessionContainsPrompt(candidate.path, prompt));
    // Only trust the prompt match when it is unambiguous.
    if (matches.length === 1) return matches[0].path;
  }

  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.distance < best.distance) best = candidate;
  }
  return best.path;
}

/**
 * Does this transcript contain the given prompt?
 *
 * Matches against the raw file using the JSON-escaped form, so the prompt's newlines
 * line up with how they are stored rather than needing the whole transcript parsed.
 */
function sessionContainsPrompt(path: string, prompt: string): boolean {
  const probe = prompt.slice(0, 400);
  // Drop the quotes JSON.stringify adds to get the escaped body as it appears in file.
  const escaped = JSON.stringify(probe).slice(1, -1);

  try {
    const content = readFileSync(path, "utf-8");
    return content.includes(escaped);
  } catch {
    return false;
  }
}

interface SessionCandidate {
  path: string;
  distance: number;
}

function findSessionCandidates(
  cwd: string,
  startedAtMs: number,
  endedAtMs: number,
): SessionCandidate[] {
  const codexHome = getCodexHome();
  if (!codexHome) return [];

  const sessionsRoot = join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];

  // The session is created moments after the job starts, so allow a little slack on
  // each side but keep the window tight. Successive runs in the same directory are
  // often only minutes apart, and a wide window makes them indistinguishable.
  const LEAD_SLACK_MS = 30_000;
  const TRAIL_SLACK_MS = 60_000;
  const windowStart = startedAtMs - LEAD_SLACK_MS;
  const windowEnd = endedAtMs + TRAIL_SLACK_MS;

  const candidates: SessionCandidate[] = [];

  for (const path of walkSessionFiles(sessionsRoot)) {
    const stampMs = readRolloutTimestampMs(path);
    if (stampMs === null) continue;
    if (stampMs < windowStart || stampMs > windowEnd) continue;
    if (readSessionCwd(path) !== cwd) continue;

    candidates.push({ path, distance: Math.abs(stampMs - startedAtMs) });
  }

  return candidates;
}

/** rollout-2026-07-27T01-33-13-<uuid>.jsonl -> epoch ms, or null if unparseable. */
function readRolloutTimestampMs(path: string): number | null {
  const match = path.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  // The filename stamp is local time, which is why it is parsed as local rather than
  // via Date.parse on a Z-suffixed string.
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();

  return Number.isFinite(parsed) ? parsed : null;
}

function readSessionCwd(path: string): string | null {
  let handle: number | null = null;
  try {
    // session_meta is the first record, so read a bounded prefix rather than pulling
    // a multi-megabyte transcript into memory for every candidate file.
    handle = openSync(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf-8");
    const firstLine = prefix.split("\n", 1)[0];
    if (!firstLine) return null;

    const record = parseJsonLine(firstLine);
    if (!isRecord(record) || record.type !== "session_meta") return null;
    const payload = isRecord(record.payload) ? record.payload : null;
    const cwd = payload?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        // Nothing useful to do if the descriptor is already gone.
      }
    }
  }
}

function* walkSessionFiles(root: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkSessionFiles(fullPath);
      continue;
    }
    if (SESSION_EXTENSIONS.has(extname(entry.name))) yield fullPath;
  }
}

export function parseSessionFile(sessionFilePath: string): ParsedSessionData | null {
  let content: string;
  try {
    content = readFileSync(sessionFilePath, "utf-8");
  } catch {
    return null;
  }

  if (sessionFilePath.endsWith(".jsonl")) {
    return parseJsonlSession(content);
  }

  return parseJsonSession(content);
}
