// Launching and observing runs.
//
// The CLI calls these; `supervisor.ts` is the long-lived process they start and talk to. The
// division: a supervisor owns exactly one run and is awake for its whole life, while every
// function here is called from a short-lived CLI process that may run at any moment, including
// long after the supervisor is gone.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { evaluateBound } from "./bounds.ts";
import { foldLines, splitCompleteLines } from "./event-stream.ts";
import {
  type CreateRunOptions,
  createRun,
  isRunTerminal,
  loadRun,
  type Run,
  readStreamSince,
  saveRun,
  writeSteer,
} from "./run-store.ts";

export function generateRunId(): string {
  return randomBytes(4).toString("hex");
}

/** Is a process alive? `signal 0` tests for existence without delivering anything. */
export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type LaunchRunOptions = Omit<CreateRunOptions, "id"> & { id?: string };

/**
 * Create a run and hand it to a detached supervisor.
 *
 * `detached` plus `unref` is what lets the CLI exit immediately while the run continues —
 * the property tmux used to provide. `stdio: "ignore"` matters as much as `detached`: a child
 * still holding the parent's pipes keeps the parent's stdout open, so a caller piping this
 * command would hang waiting for EOF that never comes.
 */
export function launchRun(options: LaunchRunOptions): Run {
  const run = createRun({ ...options, id: options.id ?? generateRunId() });
  saveRun(run);

  const supervisorPath = `${import.meta.dir}/supervisor.ts`;
  const child = spawn("bun", [supervisorPath, run.id], {
    cwd: run.cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return run;
}

export type SendOutcome = { ok: true; delivery: "steered" | "resumed" } | { ok: false; reason: string };

/**
 * Send an instruction to a run.
 *
 * Two cases, both ending in exactly one Codex process on the thread:
 *
 *   * A supervisor is alive — drop a steer file. It interrupts the in-flight invocation at its
 *     next poll and resumes the thread carrying this message. Interruption preserves everything
 *     the agent has already completed.
 *   * No supervisor — the run is idle and resumable. Start a fresh supervisor whose first
 *     invocation IS this message.
 *
 * There is no third case where two processes touch one thread, which is what keeps the event
 * stream and the answer file single-writer.
 */
export function sendToRun(runId: string, message: string): SendOutcome {
  const run = loadRun(runId);
  if (!run) return { ok: false, reason: `run ${runId} not found` };
  if (!message.trim()) return { ok: false, reason: "refusing to send an empty message" };

  if (isProcessAlive(run.supervisorPid)) {
    if (!writeSteer(runId, message)) return { ok: false, reason: "could not write the steer file" };
    return { delivery: "steered", ok: true };
  }

  if (isRunTerminal(run)) {
    // A killed or failed run has no live thread semantics worth resuming into, and silently
    // reviving one would make a breach look recoverable when the record says it was stopped.
    if (run.breachReason) {
      return { ok: false, reason: `run ${runId} was stopped (${run.breachReason}); start a new run` };
    }
  }

  if (!run.threadId) {
    return { ok: false, reason: `run ${runId} has no thread id yet — nothing to resume` };
  }

  run.prompt = message;
  run.warned = false;
  run.status = "starting";
  run.turnStartedAt = new Date().toISOString();
  // Deleted rather than set to undefined: this record is round-tripped through JSON, where an
  // explicit undefined and an absent key are the same thing on write but not in memory.
  delete run.completedAt;
  saveRun(run);

  const supervisorPath = `${import.meta.dir}/supervisor.ts`;
  const child = spawn("bun", [supervisorPath, runId], {
    cwd: run.cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return { delivery: "resumed", ok: true };
}

/**
 * Refresh a run from its artifacts, and stop it if its supervisor died holding it open.
 *
 * THE BACKSTOP. A supervisor is a process and processes die — machine sleep, OOM, an errant
 * pkill. If the only thing enforcing a bound is a process that can vanish, then the bound can
 * vanish with it, which is precisely the defect this repo already fixed once: the guards used
 * to live inside the `--wait` loop, so a background job had nothing bounding it at all.
 *
 * So every observing command re-derives the run's state from files and applies the same bound
 * function the supervisor applies. A run whose supervisor is gone is stopped by whoever next
 * looks at it. It cannot warn — that needs a live process holding the child — but it can and
 * does kill.
 */
export function refreshRun(runId: string): Run | null {
  const run = loadRun(runId);
  if (!run) return null;
  if (isRunTerminal(run)) return run;

  // Fold anything the supervisor has not yet accounted for, so an observer's view is current
  // even between the supervisor's polls.
  const chunk = readStreamSince(run.id, run.streamOffset);
  if (chunk?.text) {
    const { lines } = splitCompleteLines(chunk.text.endsWith("\n") ? chunk.text : `${chunk.text}\n`);
    if (lines.length > 0) {
      run.metrics = foldLines(run.metrics, lines);
      run.streamOffset = chunk.offset;
      if (!run.threadId && run.metrics.threadId) run.threadId = run.metrics.threadId;
      saveRun(run);
    }
  }

  if (isProcessAlive(run.supervisorPid)) return run;

  // No supervisor. Anything still running is unowned.
  const startedAtMs = Date.parse(run.turnStartedAt ?? run.startedAt ?? run.createdAt);
  if (!Number.isFinite(startedAtMs)) return run;

  const lastProgressMs = run.lastProgressAt ? Date.parse(run.lastProgressAt) : startedAtMs;
  const nowMs = Date.now();
  const decision = evaluateBound({
    stalledForMs: Number.isFinite(lastProgressMs) ? nowMs - lastProgressMs : 0,
    timeoutMinutes: run.timeoutMinutes,
    // An observer cannot warn, so it evaluates as though the warn has already happened. That
    // leaves exactly one outcome it is able to act on: kill.
    turnElapsedMs: nowMs - startedAtMs,
    warned: true,
  });

  if (decision.action !== "kill") {
    // Supervisor gone but still inside the bound: it may be mid-restart, and killing here would
    // shoot a run that is about to be picked up. Say so rather than acting.
    return run;
  }

  if (isProcessAlive(run.codexPid) && run.codexPid) {
    try {
      process.kill(run.codexPid, "SIGTERM");
    } catch {
      // Already gone between the check and the signal; nothing to do.
    }
  }

  run.status = "failed";
  run.breachReason = decision.reason;
  run.breachMessage = `${decision.message} (enforced by an observer — the supervisor was gone)`;
  run.error = run.error ?? run.breachMessage;
  run.completedAt = new Date().toISOString();
  saveRun(run);
  return run;
}

/** Stop a run and whatever it has running. */
export function killRun(runId: string): boolean {
  const run = loadRun(runId);
  if (!run) return false;

  for (const pid of [run.codexPid, run.supervisorPid]) {
    if (!isProcessAlive(pid) || !pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Raced with its own exit.
    }
  }

  run.status = "failed";
  run.error = run.error ?? "killed by user";
  run.completedAt = new Date().toISOString();
  delete run.codexPid;
  saveRun(run);
  return true;
}

/** Has this run finished a turn, one way or another? */
export function isRunSettled(run: Run): boolean {
  return run.status === "waiting" || isRunTerminal(run);
}
