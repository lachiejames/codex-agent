#!/usr/bin/env bun

// The supervisor: one process per run, for the life of the run.
//
//   bun src/supervisor.ts <runId>
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL
// ---------------------------------------------------------------------------
//
// The previous design enforced bounds lazily: guards ran whenever some command happened to
// observe the job. That is adequate for `kill` — a late kill is still a kill — but it cannot
// deliver behaviours 6, 7 and 8 of docs/SPEC.md:
//
//   * A warning at 85% of the bound is useless if nobody is looking at 85% of the bound.
//   * "Nothing fails slowly" is unachievable when a failure is only noticed on the next poll
//     by an unrelated command that may never come. The two-hour silence this tool is built to
//     prevent was exactly that: a run blocked at startup, with nobody watching.
//   * Steering needs something holding the process handle.
//
// So something has to be awake while a run is in flight. That is this.
//
// The lazy guard-on-observe path is deliberately KEPT as a backstop elsewhere: a supervisor
// that dies must not leave an unbounded Codex process behind. Leaving a run unbounded on one
// path is this repo's original sin and the new design does not get to reintroduce it.
//
// ---------------------------------------------------------------------------
// THE SINGLE-WRITER INVARIANT
// ---------------------------------------------------------------------------
//
// Exactly one Codex process runs per thread at any moment. The supervisor owns that process
// and never starts the next one until the previous has exited. This is what makes the event
// stream and the answer file single-writer, and it is the same mechanism that makes steering
// deterministic: an interrupt happens at a boundary this loop chooses, rather than whenever a
// keystroke lands in a TUI input box.

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { appendAnswer } from "./answer-store.ts";
import { buildWrapUpPrompt, evaluateBound, formatElapsed, type KillReason } from "./bounds.ts";
import { extractVerdict } from "./contract.ts";
import { foldLines, splitCompleteLines } from "./event-stream.ts";
import {
  acquireSupervisorLock,
  clearLastMessage,
  ensureJobsDir,
  loadRun,
  RUN_ARTIFACTS,
  type Run,
  type RunInvocation,
  type RunStatus,
  readLastMessage,
  readStderrTail,
  readStreamSince,
  releaseSupervisorLock,
  runArtifactPath,
  saveRun,
  shouldResumeThread,
  takeSteer,
} from "./run-store.ts";
import { buildCodexArgv, readSandboxFromArgv } from "./runner.ts";

/** How often the supervisor looks at its child. */
const POLL_MS = 500;

/** Grace between SIGTERM and SIGKILL. Codex flushes its stream on term; this is the ceiling. */
const TERM_GRACE_MS = 5000;

/** A partial trailing JSON line is carried between polls rather than counted as malformed. */
let streamCarry = "";

function log(runId: string, message: string): void {
  const path = runArtifactPath(runId, RUN_ARTIFACTS.supervisorLog);
  if (!path) return;

  try {
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never take down the run they are diagnosing.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// --------------------------------------------------------------------------
// Watching one invocation
// --------------------------------------------------------------------------

type WatchOutcome =
  | { kind: "exited"; exitCode: number }
  | { kind: "warn"; remainingMs: number; message: string }
  | { kind: "steer"; message: string }
  | { kind: "kill"; reason: KillReason; message: string };

/**
 * Fold whatever Codex has appended since the last poll into the run's metrics.
 *
 * Returns true when the stream advanced, which is the liveness signal the stall backstop runs
 * on. Direct evidence that the agent is producing something, rather than the previous
 * transport's inference from a log file's size, mtime and inode.
 */
function drainStream(run: Run): boolean {
  const chunk = readStreamSince(run.id, run.streamOffset);
  if (!chunk || !chunk.text) return false;

  const { lines, remainder } = splitCompleteLines(streamCarry + chunk.text);
  streamCarry = remainder;
  run.streamOffset = chunk.offset;

  if (lines.length === 0) return false;

  const before = run.metrics.eventCount;
  run.metrics = foldLines(run.metrics, lines);

  // The thread id arrives on the first event of the first invocation. Persist it the moment it
  // is seen: without it the thread cannot be resumed, so losing it costs the conversation.
  if (!run.threadId && run.metrics.threadId) run.threadId = run.metrics.threadId;

  return run.metrics.eventCount > before;
}

async function watchInvocation(run: Run, child: ChildProcess, turnStartedAtMs: number): Promise<WatchOutcome> {
  let exited: number | null = null;
  child.on("exit", (code, signal) => {
    // A signalled exit has a null code. Report it the way a shell would so the number in the
    // run record matches what an operator would see.
    exited = code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1);
  });

  let lastProgressAtMs = run.lastProgressAt ? Date.parse(run.lastProgressAt) : Date.now();

  for (;;) {
    await sleep(POLL_MS);

    const nowMs = Date.now();
    if (drainStream(run)) {
      lastProgressAtMs = nowMs;
      run.lastProgressAt = new Date(nowMs).toISOString();
    }
    saveRun(run);

    // Checked AFTER draining so the final events of a finished turn are never lost to the race
    // between the process exiting and its last writes landing.
    if (exited !== null) {
      drainStream(run);
      saveRun(run);
      return { exitCode: exited, kind: "exited" };
    }

    // ONE RUN IS ONE THREAD. A second announcement means an invocation started a fresh
    // conversation instead of resuming, which loses the context AND makes the recorded thread
    // id describe a conversation that did not produce the answer. It was silent once; it is
    // fatal now.
    if (run.metrics.threadsAnnounced > 1) {
      log(run.id, `FATAL: ${run.metrics.threadsAnnounced} threads announced for one run`);
      await terminate(child);
      return {
        kind: "kill",
        message:
          `this run announced ${run.metrics.threadsAnnounced} Codex threads, but a run is exactly one ` +
          `thread. An invocation started a new conversation instead of resuming, so the context and ` +
          `the recorded thread id no longer agree. Stopping rather than recording a misattributed answer.`,
        reason: "stalled",
      };
    }

    const steer = takeSteer(run.id);
    if (steer) {
      log(run.id, `steer received, interrupting invocation ${run.invocations.length - 1}`);
      await terminate(child);
      return { kind: "steer", message: steer };
    }

    const decision = evaluateBound({
      stalledForMs: nowMs - lastProgressAtMs,
      timeoutMinutes: run.timeoutMinutes,
      turnElapsedMs: nowMs - turnStartedAtMs,
      warned: run.warned,
    });

    if (decision.action === "warn") {
      log(run.id, `warn: ${decision.message}`);
      await terminate(child);
      return {
        kind: "warn",
        message: decision.message,
        remainingMs: run.timeoutMinutes * 60_000 - (nowMs - turnStartedAtMs),
      };
    }

    if (decision.action === "kill") {
      log(run.id, `kill (${decision.reason}): ${decision.message}`);
      await terminate(child);
      return { kind: "kill", message: decision.message, reason: decision.reason ?? "wall_clock" };
    }
  }
}

/**
 * Stop a Codex process and wait for it to actually be gone.
 *
 * Waiting matters: starting the next invocation while the previous one still holds the stream
 * would break the single-writer invariant and interleave two turns' events in one file.
 */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  const deadline = Date.now() + TERM_GRACE_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }

  child.kill("SIGKILL");
  // A SIGKILLed process cannot decline to die, but it is not reaped instantly either.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
}

// --------------------------------------------------------------------------
// Running one invocation
// --------------------------------------------------------------------------

function spawnCodex(run: Run, prompt: string, resume: boolean): ChildProcess {
  const lastMessagePath = runArtifactPath(run.id, RUN_ARTIFACTS.lastMessage);
  const eventsPath = runArtifactPath(run.id, RUN_ARTIFACTS.events);
  const stderrPath = runArtifactPath(run.id, RUN_ARTIFACTS.stderr);
  if (!lastMessagePath || !eventsPath || !stderrPath) {
    throw new Error(`Invalid run id: ${run.id}`);
  }

  // Cleared before every invocation. Otherwise a turn that produces no answer would inherit the
  // previous turn's file and be recorded as having answered.
  clearLastMessage(run.id);

  const argv = buildCodexArgv({
    lastMessagePath,
    model: run.model,
    prompt,
    reasoningEffort: run.reasoningEffort,
    sandbox: run.sandbox,
    ...(resume && run.threadId ? { threadId: run.threadId } : {}),
  });

  // Belt and braces on the one property whose silent loss is a security regression rather than
  // a bug: `codex exec resume` rejects `--sandbox`, so the sandbox travels as a `-c` key, and
  // this asserts it actually survived into the argv about to be executed.
  const sandboxInArgv = readSandboxFromArgv(argv);
  if (sandboxInArgv !== run.sandbox) {
    throw new Error(`Refusing to spawn: argv carries sandbox ${sandboxInArgv}, run requires ${run.sandbox}`);
  }

  const out = openSync(eventsPath, "a");
  const err = openSync(stderrPath, "a");

  try {
    return spawn("codex", argv, {
      cwd: run.cwd,
      // stdin is ignored, never inherited. The CLI's own stdin may be a pipe carrying the diff
      // that is ALREADY embedded in the prompt; passing it through would feed Codex the scope
      // twice and, if the pipe never closed, hang it waiting on input it does not need.
      stdio: ["ignore", out, err],
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

// --------------------------------------------------------------------------
// Concluding
// --------------------------------------------------------------------------

/**
 * Record the outcome of a turn that ended on its own.
 *
 * Three distinguishable endings, and conflating any two of them loses information the operator
 * needs:
 *
 *   * non-zero exit          — Codex refused or crashed. stderr says why, in one line, now.
 *   * zero exit, no answer   — `-o` FAILED TO WRITE AND CODEX STILL EXITED 0. Verified against
 *                              0.145.0: pointing `-o` at an unwritable path prints a warning to
 *                              stderr and exits successfully. Trusting the exit code alone would
 *                              record a silent, answerless run as a success.
 *   * zero exit, answer      — the good case.
 */
function concludeTurn(run: Run, exitCode: number): RunStatus {
  const answer = readLastMessage(run.id);
  const invocation = run.invocations[run.invocations.length - 1];
  if (invocation) {
    invocation.endedAt = new Date().toISOString();
    invocation.exitCode = exitCode;
  }

  if (exitCode !== 0) {
    const stderr = readStderrTail(run.id);
    run.status = "failed";
    run.error = stderr ? extractFailureReason(stderr) : `codex exited ${exitCode}`;
    run.completedAt = new Date().toISOString();
    log(run.id, `codex exited ${exitCode}: ${run.error}`);
    return run.status;
  }

  if (!answer) {
    run.status = "failed";
    run.error =
      "codex exited 0 but wrote no answer to --output-last-message. " +
      (readStderrTail(run.id) ?? "No stderr was captured.");
    run.completedAt = new Date().toISOString();
    log(run.id, "exited 0 with no answer file");
    return run.status;
  }

  appendAnswer(run.id, {
    text: answer,
    timestamp: new Date().toISOString(),
    turnId: String(invocation?.index ?? run.invocations.length),
  });

  // A verdict reached on ANY turn stands. A later turn does not retract an earlier verdict, and
  // reading only the newest answer once recorded a concluded run as never having answered.
  run.verdict = run.verdict ?? extractVerdict(answer);
  run.status = "waiting";
  log(run.id, `turn concluded, verdict=${run.verdict ?? "none"}`);
  return run.status;
}

/**
 * Codex progress chatter that appears on stderr and is not a failure.
 *
 * Deliberately a short list of exact literals, not a heuristic. The transport this replaces
 * carried 187 lines of glyph-guessing (`output-cleaner.ts`) because it had to identify noise in
 * an unbounded terminal render; here there are two known progress lines in a structured stream,
 * and if Codex adds a third the worst case is one noisy error message, not a lost answer.
 */
const BENIGN_STDERR_PREFIXES = ["Reading prompt from stdin", "Reading additional input from stdin"] as const;

function isBenignStderrLine(line: string): boolean {
  return BENIGN_STDERR_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * The line of stderr that actually explains a failure.
 *
 * Found by the first live fast-fail test: an untrusted directory writes TWO lines, and the
 * first is "Reading additional input from stdin..." — so taking the first non-empty line
 * reported progress chatter as the cause and buried "Not inside a trusted directory". A
 * diagnosis that names the wrong thing is worse than none, because it sends the reader after
 * a problem they do not have.
 */
export function extractFailureReason(text: string): string {
  const meaningful = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !isBenignStderrLine(line));

  return meaningful ?? text.trim();
}

function recordBreach(run: Run, reason: KillReason, message: string): void {
  const invocation = run.invocations[run.invocations.length - 1];
  if (invocation) {
    invocation.endedAt = new Date().toISOString();
    invocation.endedBy = reason;
  }

  run.status = "failed";
  run.breachReason = reason;
  run.breachMessage = message;
  run.error = run.error ?? message;
  run.completedAt = new Date().toISOString();
}

// --------------------------------------------------------------------------
// The loop
// --------------------------------------------------------------------------

async function supervise(runId: string): Promise<number> {
  ensureJobsDir();
  const loaded = loadRun(runId);
  if (!loaded) {
    process.stderr.write(`supervisor: run ${runId} not found\n`);
    return 1;
  }

  // EXACTLY ONE SUPERVISOR PER RUN. Taken before anything is written, because the whole point
  // is that the loser must not touch the event stream or the answer file. Found by an
  // adversarial pass on this file's own diff: `supervisorPid` is metadata, and two concurrent
  // `send` calls on an idle run could both spawn a supervisor and both append.
  if (!acquireSupervisorLock(runId, process.pid)) {
    process.stderr.write(`supervisor: run ${runId} is already owned by another supervisor\n`);
    log(runId, `refusing to start: lock held by another supervisor`);
    return 0;
  }

  const run = loaded;
  run.supervisorPid = process.pid;
  run.status = "running";
  run.startedAt = run.startedAt ?? new Date().toISOString();
  run.turnStartedAt = run.turnStartedAt ?? run.startedAt;
  saveRun(run);
  log(runId, `supervisor ${process.pid} started, bound ${run.timeoutMinutes}m, resume=${shouldResumeThread(run)}`);

  let prompt = run.prompt;
  // A run is a thread: resume whenever one already exists. Hardcoding `false` here meant every
  // supervisor after the first silently started a NEW conversation. See shouldResumeThread.
  let resume = shouldResumeThread(run);
  let turnStartedAtMs = Date.parse(run.turnStartedAt);

  for (;;) {
    const invocation: RunInvocation = {
      index: run.invocations.length,
      startedAt: new Date().toISOString(),
    };
    run.invocations.push(invocation);
    run.status = "running";
    saveRun(run);

    let child: ChildProcess;
    try {
      child = spawnCodex(run, prompt, resume);
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = new Date().toISOString();
      saveRun(run);
      log(runId, `spawn failed: ${run.error}`);
      return 1;
    }

    if (child.pid !== undefined) run.codexPid = child.pid;
    saveRun(run);
    log(runId, `invocation ${invocation.index} pid=${child.pid} resume=${resume}`);

    const outcome = await watchInvocation(run, child, turnStartedAtMs);
    delete run.codexPid;

    if (outcome.kind === "exited") {
      // The status is taken from the return value rather than re-read off `run`: the compiler
      // has `run.status` narrowed to "running" from the assignment above and cannot see that
      // concludeTurn mutates it, so reading the field back would compare against a stale type.
      const status = concludeTurn(run, outcome.exitCode);
      saveRun(run);
      return status === "failed" ? 1 : 0;
    }

    if (outcome.kind === "kill") {
      recordBreach(run, outcome.reason, outcome.message);
      saveRun(run);
      return 1;
    }

    // A thread that was never announced cannot be resumed, so there is nothing to continue
    // into. This is only reachable if Codex died before its first event.
    if (!run.threadId) {
      recordBreach(run, "stalled", "codex produced no thread id, so the run cannot be continued");
      saveRun(run);
      return 1;
    }

    if (outcome.kind === "warn") {
      invocation.endedAt = new Date().toISOString();
      invocation.endedBy = "warn";
      run.warned = true;
      prompt = buildWrapUpPrompt(outcome.remainingMs, run.requiresVerdict);
      resume = true;
      // turnStartedAtMs deliberately UNCHANGED: the wrap-up continues the same logical turn, so
      // it inherits the same deadline. Resetting it here would hand a warned run a second full
      // bound and turn a 10-minute limit into 18.5 minutes.
      log(runId, `resuming for wrap-up, ${formatElapsed(outcome.remainingMs)} left`);
      continue;
    }

    // A steer is a NEW question from the operator, so it starts a new logical turn with a fresh
    // bound and a fresh warn budget.
    invocation.endedAt = new Date().toISOString();
    invocation.endedBy = "steer";
    prompt = outcome.message;
    resume = true;
    run.warned = false;
    run.boundRearmedCount += 1;
    turnStartedAtMs = Date.now();
    run.turnStartedAt = new Date(turnStartedAtMs).toISOString();
    log(runId, `resuming with operator steer, new bound window (re-armed ${run.boundRearmedCount}x)`);
  }
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    process.stderr.write("usage: supervisor <runId>\n");
    process.exit(1);
  }

  try {
    const code = await supervise(runId);
    releaseSupervisorLock(runId, process.pid);
    process.exit(code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(runId, `supervisor crashed: ${message}`);

    // A crashed supervisor must not leave the run looking alive forever. Whoever next observes
    // it needs to be told, not left to infer it from silence.
    const run = loadRun(runId);
    if (run && !["completed", "failed"].includes(run.status)) {
      run.status = "failed";
      run.error = `supervisor crashed: ${message}`;
      run.completedAt = new Date().toISOString();
      saveRun(run);
    }
    releaseSupervisorLock(runId, process.pid);
    process.exit(1);
  }
}

await main();
