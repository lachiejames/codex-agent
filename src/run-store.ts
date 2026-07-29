// The run record, and where its artifacts live.
//
// A RUN is a Codex thread plus everything observed about it. It is deliberately a different
// record from the old `Job` in jobs.ts: under the tmux transport a job was one long-lived
// interactive session, whereas a run is a thread driven by N successive `codex exec`
// processes. Modelling the second as the first is what made the wall-clock bound start
// measuring conversation lifetime instead of thinking time.
//
// Kept in a separate file with a separate extension (`.run.json`) so the old transport keeps
// working untouched while this one is proven. See docs/SPEC.md.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import type { KillReason } from "./bounds.ts";
import { config, type ReasoningEffort, type SandboxMode } from "./config.ts";
import type { BypassKind, PassKind } from "./contract.ts";
import { emptyMetrics, type StreamMetrics } from "./event-stream.ts";

export const RUN_SCHEMA_VERSION = "codex-agent.run.v1";

/**
 * `starting`  — record written, no Codex process yet.
 * `running`   — a Codex process is in flight.
 * `waiting`   — a turn concluded; the thread is resumable via `send`.
 * `completed` — concluded and closed.
 * `failed`    — a guard stopped it, or Codex exited non-zero, or it produced no answer.
 */
export type RunStatus = "starting" | "running" | "waiting" | "completed" | "failed";

/** Why an invocation ended, when it did not end of its own accord. */
export type InvocationEnd = "warn" | "steer" | "wall_clock" | "stalled" | "killed";

export interface RunInvocation {
  index: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  endedBy?: InvocationEnd;
}

export interface Run {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  id: string;
  status: RunStatus;
  /** The original prompt. Later invocations carry wrap-up or steer text instead. */
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  cwd: string;
  /** The caller's explicit bound. Required — there is no default anywhere. */
  timeoutMinutes: number;
  passKind: PassKind | null;
  requiresVerdict: boolean;
  scoped: boolean;
  bypass: BypassKind | null;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** From `thread.started`. Without it the thread cannot be resumed. */
  threadId?: string;
  supervisorPid?: number;
  /** The Codex process currently in flight, if any. */
  codexPid?: number;
  invocations: RunInvocation[];
  /**
   * When the current LOGICAL turn began.
   *
   * Survives a warn-and-resume — same question, same deadline — and resets on an operator
   * steer, which is a new question. This is the clock `evaluateBound` is given.
   */
  turnStartedAt?: string;
  /** Whether the current logical turn has already been warned. Reset by a steer. */
  warned: boolean;
  /**
   * How many times an operator steer re-armed the bound.
   *
   * A steer starts a NEW logical turn, so it deliberately gets a fresh deadline — that is the
   * steering behaviour this tool exists to provide. But an adversarial pass pointed out the
   * consequence: repeated steers can carry a run far past its stated bound, and nothing said so.
   * Counting them makes a run that has consumed 10x its nominal bound visible in `status` and in
   * the ledger, instead of a number that quietly stopped meaning anything.
   */
  boundRearmedCount: number;
  metrics: StreamMetrics;
  /** Bytes of `.jsonl` already folded into `metrics`, so reads stay incremental. */
  streamOffset: number;
  /** Carried across polls so the stall backstop survives the supervisor restarting. */
  lastProgressAt?: string;
  verdict: string | null;
  breachReason: KillReason | null;
  breachMessage: string | null;
  error: string | null;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isUnderJobsDir(filePath: string): boolean {
  const jobsDir = resolve(config.jobsDir);
  const resolved = resolve(filePath);
  return resolved === jobsDir || resolved.startsWith(`${jobsDir}${sep}`);
}

/**
 * Path to one of a run's artifacts, or null when the id is not safe to build a path from.
 *
 * Every artifact goes through here so a crafted id cannot escape the jobs directory.
 */
export function runArtifactPath(runId: string, extension: string): string | null {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  const artifactPath = resolve(config.jobsDir, `${runId}${extension}`);
  return isUnderJobsDir(artifactPath) ? artifactPath : null;
}

export const RUN_ARTIFACTS = {
  /** Untruncated answers, one block per concluded turn. */
  answers: ".answer.md",
  /** `codex exec --json` event stream, appended across every invocation. */
  events: ".jsonl",
  /** `--output-last-message` target for the CURRENT invocation. The answer of record. */
  lastMessage: ".last.txt",
  /** Exclusive ownership. Exactly one supervisor may hold this. See acquireSupervisorLock. */
  lock: ".lock",
  /** The run record itself. */
  record: ".run.json",
  /** Codex stderr. The only place a fast startup failure explains itself. */
  stderr: ".stderr",
  /** A pending steer, written by `send` and consumed by the supervisor. */
  steer: ".steer",
  /** The supervisor's own diagnostics — how a dead supervisor explains itself. */
  supervisorLog: ".supervisor.log",
} as const;

export function ensureJobsDir(): void {
  mkdirSync(config.jobsDir, { recursive: true });
}

export function loadRun(runId: string): Run | null {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.record);
  if (!path) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Run;
  } catch {
    return null;
  }
}

/**
 * Persist a run.
 *
 * Atomic (temp file + rename) because the supervisor writes this on every poll while the CLI
 * reads it from a different process. A torn read would show a caller a half-written record and
 * be indistinguishable from a corrupt run.
 */
export function saveRun(run: Run): void {
  ensureJobsDir();
  const path = runArtifactPath(run.id, RUN_ARTIFACTS.record);
  if (!path) throw new Error(`Invalid run id: ${run.id}`);

  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(run, null, 2));
  renameSync(temporary, path);
}

export interface CreateRunOptions {
  id: string;
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  cwd: string;
  timeoutMinutes: number;
  passKind: PassKind | null;
  requiresVerdict: boolean;
  scoped: boolean;
  bypass: BypassKind | null;
}

export function createRun(options: CreateRunOptions): Run {
  return {
    boundRearmedCount: 0,
    breachMessage: null,
    breachReason: null,
    bypass: options.bypass,
    createdAt: new Date().toISOString(),
    cwd: options.cwd,
    error: null,
    id: options.id,
    invocations: [],
    metrics: emptyMetrics(),
    model: options.model,
    passKind: options.passKind,
    prompt: options.prompt,
    reasoningEffort: options.reasoningEffort,
    requiresVerdict: options.requiresVerdict,
    sandbox: options.sandbox,
    schemaVersion: RUN_SCHEMA_VERSION,
    scoped: options.scoped,
    status: "starting",
    streamOffset: 0,
    timeoutMinutes: options.timeoutMinutes,
    verdict: null,
    warned: false,
  };
}

/** Is a run in a state where a Codex process should be running? */
export function isRunActive(run: Run): boolean {
  return run.status === "starting" || run.status === "running";
}

/**
 * Does this supervisor resume an existing thread, or start a new one?
 *
 * A RUN IS A THREAD. So a supervisor starts a new one only when the run has none yet; every
 * later supervisor for the same run must resume.
 *
 * This was hardcoded `false` in the supervisor's loop, which was correct for the first
 * supervisor and wrong for every subsequent one. `send` on an idle run spawns a FRESH
 * supervisor, so a multi-turn conversation silently began a second Codex thread: the context
 * was gone, and — worse — the run record still reported the first thread id, so it claimed an
 * answer belonged to a conversation that had not produced it. Two turns, two answers, both
 * persisted, everything looking correct.
 *
 * Extracted here rather than left inline because supervisor.ts runs `main()` at import and so
 * cannot be unit tested at all. This is the part worth asserting.
 */
export function shouldResumeThread(run: Pick<Run, "threadId">): boolean {
  return Boolean(run.threadId);
}

/** Is a run finished, one way or another? */
export function isRunTerminal(run: Run): boolean {
  return run.status === "completed" || run.status === "failed";
}

// --------------------------------------------------------------------------
// The steer channel
// --------------------------------------------------------------------------

/**
 * Leave a message for the supervisor to deliver.
 *
 * A file rather than a signal or a socket because the writer (`codex-agent send`) and the
 * reader (the supervisor) are separate short-lived and long-lived processes with no shared
 * memory, and the message must survive the moment between being written and being picked up.
 */
export function writeSteer(runId: string, message: string): boolean {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.steer);
  if (!path) return false;

  try {
    writeFileSync(path, message);
    return true;
  } catch {
    return false;
  }
}

/** Take a pending steer, removing it so it is delivered exactly once. */
export function takeSteer(runId: string): string | null {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.steer);
  if (!path) return null;

  try {
    const message = readFileSync(path, "utf-8");
    unlinkSync(path);
    return message.trim().length > 0 ? message : null;
  } catch {
    return null;
  }
}

export function hasSteer(runId: string): boolean {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.steer);
  return path !== null && existsSync(path);
}

// --------------------------------------------------------------------------
// Reading the event stream incrementally
// --------------------------------------------------------------------------

export interface StreamChunk {
  text: string;
  /** New byte offset after this chunk. */
  offset: number;
}

/**
 * Read whatever has been appended to a run's event stream since `fromOffset`.
 *
 * Bounded by design: the supervisor polls a file Codex is actively appending to, and
 * `command_execution` items carry full command output, so a plan pass running `git diff` over a
 * large tree can produce a very large stream. Reading only the delta keeps each poll O(new
 * bytes) rather than O(file), which is what stops a long run getting quadratically slower to
 * observe as it goes.
 */
export function readStreamSince(runId: string, fromOffset: number): StreamChunk | null {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.events);
  if (!path) return null;

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }

  // A shrinking file means it was truncated or replaced. Nothing in this tool does that, but
  // reading from a stale offset into a smaller file would silently skip content, so restart.
  const start = size < fromOffset ? 0 : fromOffset;
  if (size === start) return { offset: start, text: "" };

  try {
    const handle = readFileSync(path);
    return { offset: size, text: handle.subarray(start, size).toString("utf-8") };
  } catch {
    return null;
  }
}

/** The answer Codex wrote for the current invocation, or null when it wrote none. */
export function readLastMessage(runId: string): string | null {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.lastMessage);
  if (!path) return null;

  try {
    const text = readFileSync(path, "utf-8");
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Clear the last-message file so a later invocation cannot inherit an earlier answer. */
export function clearLastMessage(runId: string): void {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.lastMessage);
  if (!path) return;

  try {
    unlinkSync(path);
  } catch {
    // Absent is the desired state; nothing to do.
  }
}

/**
 * The tail of Codex's stderr.
 *
 * This is where a run that never started explains itself — an untrusted directory exits 1 with
 * a single line here and nothing at all on stdout.
 */
export function readStderrTail(runId: string, maxChars = 2000): string | null {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.stderr);
  if (!path) return null;

  try {
    const text = readFileSync(path, "utf-8").trim();
    if (!text) return null;
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Listing and expiry
// --------------------------------------------------------------------------

export interface ListRunsOptions {
  all?: boolean;
  limit?: number | null;
}

/** Every run on disk, newest first. */
export function listRuns(options: ListRunsOptions = {}): Run[] {
  ensureJobsDir();

  let names: string[];
  try {
    names = readdirSync(config.jobsDir).filter((name) => name.endsWith(RUN_ARTIFACTS.record));
  } catch {
    return [];
  }

  const runs = names
    .map((name) => loadRun(name.slice(0, -RUN_ARTIFACTS.record.length)))
    .filter((run): run is Run => run !== null)
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const limit = options.all ? null : (options.limit ?? config.runsListLimit);
  return limit && limit > 0 ? runs.slice(0, limit) : runs;
}

/**
 * Delete runs older than the retention window, and every artifact belonging to them.
 *
 * Deletes rather than archives. The previous transport moved artifacts into `jobs/.trash/` for
 * recoverability and then never emptied it, so 699 MB accumulated across 964 files while
 * `clean` cheerfully reported jobs "cleaned" and freed nothing. Recoverability nobody expires
 * is just a leak with a nicer name; the answer of record is in the report, and a week is long
 * enough to have read it.
 */
export function purgeOldRuns(maxAgeDays: number): { runsRemoved: number; bytesFreed: number } {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let runsRemoved = 0;
  let bytesFreed = 0;

  for (const run of listRuns({ all: true })) {
    const stamp = Date.parse(run.completedAt ?? run.createdAt);
    if (!Number.isFinite(stamp) || stamp >= cutoff) continue;
    if (!isRunTerminal(run) && run.status !== "waiting") continue;

    for (const extension of Object.values(RUN_ARTIFACTS)) {
      const path = runArtifactPath(run.id, extension);
      if (!path) continue;
      try {
        bytesFreed += statSync(path).size;
        unlinkSync(path);
      } catch {
        // Absent or unreadable artifacts contribute nothing rather than aborting the sweep.
      }
    }
    runsRemoved += 1;
  }

  return { bytesFreed, runsRemoved };
}

// --------------------------------------------------------------------------
// The supervisor lock
// --------------------------------------------------------------------------

/**
 * Exclusive ownership of a run, held by exactly one supervisor.
 *
 * FOUND BY AN ADVERSARIAL PASS ON THIS TRANSPORT'S OWN DIFF. `run.supervisorPid` is mutable
 * metadata, not mutual exclusion — and `sendToRun` decides whether to spawn a supervisor by
 * checking whether one is alive, which is a check-then-act race. Two concurrent
 * `codex-agent send` calls on an idle run both saw no supervisor, both spawned one, and both
 * children then appended to the same `.jsonl` and the same `.answer.md`. Parallel use is the
 * whole point of this tool, so that race is reachable rather than theoretical.
 *
 * `wx` makes creation atomic at the filesystem level: exactly one caller can win, no matter how
 * many race. The loser exits rather than sharing the stream.
 */
export function acquireSupervisorLock(runId: string, pid: number): boolean {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.lock);
  if (!path) return false;

  try {
    // "wx" fails if the path exists. This is the atomic step; everything below is stale-lock
    // recovery, which is only reached when a lock already exists.
    writeFileSync(path, String(pid), { flag: "wx" });
    return true;
  } catch {
    // Someone holds it — or a crashed supervisor left it behind. A lock held by a dead process
    // must not wedge a run forever, but "the holder is dead" has to be established, never
    // assumed: an unreadable or unparseable lock is treated as HELD, because wrongly stealing a
    // live lock reintroduces the exact concurrency this prevents.
    let holder: number | null = null;
    try {
      const parsed = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
      holder = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return false;
    }
    if (holder === null) return false;

    try {
      process.kill(holder, 0);
      return false; // Alive. Not ours.
    } catch {
      // Dead. Remove and make exactly one more attempt — a bounded retry, so two processes
      // racing to reclaim the same stale lock cannot loop.
      try {
        unlinkSync(path);
        writeFileSync(path, String(pid), { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }
  }
}

/** Release the lock, but only if we still hold it. */
export function releaseSupervisorLock(runId: string, pid: number): void {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.lock);
  if (!path) return;

  try {
    // Checked before unlinking so a supervisor that lost its lock to stale-recovery cannot
    // delete the lock of whoever legitimately took over.
    if (Number.parseInt(readFileSync(path, "utf-8").trim(), 10) !== pid) return;
    unlinkSync(path);
  } catch {
    // Already gone, which is the desired end state.
  }
}
