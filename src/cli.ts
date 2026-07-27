#!/usr/bin/env bun

// Codex Agent CLI - Delegate tasks to GPT Codex agents with tmux integration
// Designed for Claude Code orchestration with bidirectional communication

import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import {
  startJob,
  loadJob,
  saveJob,
  listJobs,
  killJob,
  refreshJobStatus,
  cleanupOldJobs,
  deleteJob,
  sendToJob,
  getJobOutput,
  getJobFullOutput,
  getAttachCommand,
  getTurnSignal,
  getJobsJson,
  getStatusJson,
  buildCompactJobJson,
} from "./jobs.ts";
import type { CompactJobJson, Job } from "./jobs.ts";
import { getRunLedger, getRunLedgers } from "./jobs.ts";
import { isTmuxAvailable, listSessions } from "./tmux.ts";
import { cleanTerminalOutput } from "./output-cleaner.ts";
import { buildPromptContext, type BuiltPromptContext } from "./prompt-context.ts";
import {
  DEFAULT_HEARTBEAT_EXECS,
  DEFAULT_HEARTBEAT_MINUTES,
  LEDGER_HEADER,
  PASS_KINDS,
  PASS_PROFILES,
  detectBlockingPrompt,
  evaluateContract,
  evaluateHeartbeat,
  formatLedgerRow,
  formatViolations,
  isPassKind,
  resolvePassKind,
  shapeVerificationPrompt,
  type PassKind,
} from "./contract.ts";

const HELP = `
Codex Agent - Delegate tasks to GPT Codex agents (tmux-based)

Usage:
  codex-agent start "prompt" [options]   Start agent in tmux session
  codex-agent status <jobId>             Check job status
  codex-agent await-turn <jobId>         Wait for agent to finish current turn
  codex-agent send <jobId> "message"     Send message to running agent
  codex-agent capture <jobId> [lines]    Capture recent output (default: 50 lines)
  codex-agent output <jobId>             Get full session output
  codex-agent attach <jobId>             Get tmux attach command
  codex-agent watch <jobId>              Stream output updates
  codex-agent jobs [--json]              List all jobs
  codex-agent sessions                   List active tmux sessions
  codex-agent kill <jobId>               Kill running job
  codex-agent clean                      Clean old completed jobs and orphaned tmux sessions
  codex-agent ledger [--json]            Run ledger: duration, tokens, execs, verdict
  codex-agent health                     Check tmux and codex availability

Codex is the brain; Claude is the body:
  Codex plans and reviews. It does NOT write code. Every pass profile is read-only, so
  the default sandbox is read-only and write access is something you opt into with an
  explicit -s workspace-write. Claude makes the edits.

Invocation contract:
  Verification passes are bounded, because unbounded ones do not converge. On
  2026-07-26 a review packing ~25 checks into one call with no diff ran 1h50m across
  115 exec calls and produced no verdict; the same question, scoped to one property
  with the diff piped in, was answered correctly in 51 seconds.

  So: pipe the diff, and ask one thing at a time.

    git diff origin/main...HEAD -- src/a.ts |
      codex-agent start --pass review --property "postMessage cannot double-post"

  A review/verify/audit prompt with nothing on stdin is REFUSED. Override per call
  with --allow-unscoped when the scope really is the whole tree.

Options:
      --pass <kind>          Pass profile: ${PASS_KINDS.join(", ")} (default: inferred)
      --property <claim>     The single falsifiable claim to attack (shapes the prompt)
      --timeout <minutes>    Wall-clock bound (default: per-pass profile)
      --allow-unscoped       Permit a verification pass with nothing on stdin
      --max-checks <n>       Override the enumerated-check limit for this call
      --word-cap <n>         Override the answer word cap (0 disables)
      --no-contract          Disable contract enforcement entirely (escape hatch)
  -r, --reasoning <level>    Reasoning effort: low, medium, high, xhigh (default: ${config.defaultReasoningEffort})
  -m, --model <model>        Model name (default: ${config.model})
  -s, --sandbox <mode>       Sandbox: read-only, workspace-write, danger-full-access
                             (default: ${config.defaultSandbox} — Codex plans, it does not write)
  -w, --wait                 Wait for completion before exiting
  --notify-on-complete <cmd>  Run command when job completes
  -d, --dir <path>           Working directory (default: cwd)
  --parent-session <id>      Parent session ID for linkage
  --map                      Include codebase map if available
  --dry-run                  Show prompt without executing
  --strip-ansi               Remove ANSI and Codex TUI noise from output (for capture/output)
  --clean                    Alias for --strip-ansi
  --json                     Output JSON (status, await-turn, jobs)
  --limit <n>                Limit jobs shown (jobs command only)
  --all                      Show all jobs (jobs command only)
  -h, --help                 Show this help

Examples:
  # Plan (read-only, broad by design)
  codex-agent start --pass plan "Design the retry strategy for the outbound queue" --map

  # Review one property of a diff (read-only, bounded, must reach a verdict)
  git diff origin/main...HEAD -- src/queue.ts |
    codex-agent start --pass review --property "no message is delivered twice" --wait

  # Check on it
  codex-agent capture abc123

  # Send additional context
  codex-agent send abc123 "Also check the auth module"

  # Attach to watch interactively
  tmux attach -t codex-agent-abc123

  # Or use the attach command
  codex-agent attach abc123

Bidirectional Communication:
  - Use 'send' to give agents additional instructions mid-task
  - Use 'capture' to see recent output programmatically
  - Use 'attach' to interact directly in tmux
  - Press Ctrl+C in tmux to interrupt, type to continue conversation
`;

interface Options {
  reasoning: ReasoningEffort;
  model: string;
  sandbox: SandboxMode;
  waitForCompletion: boolean;
  notifyOnComplete: string | null;
  dir: string;
  includeMap: boolean;
  parentSessionId: string | null;
  dryRun: boolean;
  stripAnsi: boolean;
  json: boolean;
  jobsLimit: number | null;
  jobsAll: boolean;
  // --- Invocation contract ---
  passKind: PassKind | null;
  property: string | null;
  timeoutMinutes: number | null;
  allowUnscoped: boolean;
  maxChecks: number | null;
  /**
   * Tri-state: `undefined` means --word-cap was not given (use the profile default),
   * `null` means it was given as 0 (no cap at all), a number is an explicit cap.
   * A plain `number | null` cannot distinguish "not supplied" from "disabled".
   */
  wordCap: number | null | undefined;
  contractEnabled: boolean;
  /** True when -r/--reasoning was given explicitly, so a pass profile must not override it. */
  reasoningExplicit: boolean;
  /** True when -s/--sandbox was given explicitly. Write access is opt-in, never inferred. */
  sandboxExplicit: boolean;
}

function parseArgs(args: string[]): {
  command: string;
  positional: string[];
  options: Options;
} {
  const options: Options = {
    reasoning: config.defaultReasoningEffort,
    model: config.model,
    sandbox: config.defaultSandbox,
    waitForCompletion: false,
    notifyOnComplete: null,
    dir: process.cwd(),
    includeMap: false,
    parentSessionId: null,
    dryRun: false,
    stripAnsi: false,
    json: false,
    jobsLimit: config.jobsListLimit,
    jobsAll: false,
    passKind: null,
    property: null,
    timeoutMinutes: null,
    allowUnscoped: false,
    maxChecks: null,
    wordCap: undefined,
    contractEnabled: true,
    reasoningExplicit: false,
    sandboxExplicit: false,
  };

  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "-r" || arg === "--reasoning") {
      const level = args[++i] as ReasoningEffort;
      if (config.reasoningEfforts.includes(level)) {
        options.reasoning = level;
        options.reasoningExplicit = true;
      } else {
        console.error(`Invalid reasoning level: ${level}`);
        console.error(`Valid options: ${config.reasoningEfforts.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "-m" || arg === "--model") {
      options.model = args[++i];
    } else if (arg === "-s" || arg === "--sandbox") {
      const mode = args[++i] as SandboxMode;
      if (config.sandboxModes.includes(mode)) {
        options.sandbox = mode;
        options.sandboxExplicit = true;
      } else {
        console.error(`Invalid sandbox mode: ${mode}`);
        console.error(`Valid options: ${config.sandboxModes.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "-w" || arg === "--wait") {
      options.waitForCompletion = true;
    } else if (arg === "--notify-on-complete") {
      options.notifyOnComplete = args[++i] ?? null;
      options.waitForCompletion = true;
    } else if (arg === "-d" || arg === "--dir") {
      options.dir = args[++i];
    } else if (arg === "--parent-session") {
      options.parentSessionId = args[++i] ?? null;
    } else if (arg === "--map") {
      options.includeMap = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--strip-ansi" || arg === "--clean") {
      options.stripAnsi = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--limit") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        console.error(`Invalid limit: ${raw}`);
        process.exit(1);
      }
      options.jobsLimit = Math.floor(parsed);
    } else if (arg === "--all") {
      options.jobsAll = true;
    } else if (arg === "--pass") {
      const kind = args[++i];
      if (!kind || !isPassKind(kind)) {
        console.error(`Invalid pass kind: ${kind}`);
        console.error(`Valid options: ${PASS_KINDS.join(", ")}`);
        process.exit(1);
      }
      options.passKind = kind;
    } else if (arg === "--property") {
      options.property = args[++i] ?? null;
    } else if (arg === "--timeout") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`Invalid timeout (minutes): ${raw}`);
        process.exit(1);
      }
      options.timeoutMinutes = parsed;
    } else if (arg === "--allow-unscoped") {
      options.allowUnscoped = true;
    } else if (arg === "--max-checks") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        console.error(`Invalid max-checks: ${raw}`);
        process.exit(1);
      }
      options.maxChecks = Math.floor(parsed);
    } else if (arg === "--word-cap") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        console.error(`Invalid word-cap: ${raw}`);
        process.exit(1);
      }
      // 0 means "no cap", so the profile default can be switched off per call.
      options.wordCap = parsed === 0 ? null : Math.floor(parsed);
    } else if (arg === "--no-contract") {
      options.contractEnabled = false;
    } else if (!arg.startsWith("-")) {
      if (!command) {
        command = arg;
      } else {
        positional.push(arg);
      }
    }
  }

  return { command, positional, options };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatJobStatus(job: Job): string {
  const elapsed = job.startedAt
    ? formatDuration(
        (job.completedAt ? new Date(job.completedAt).getTime() : Date.now()) -
          new Date(job.startedAt).getTime()
      )
    : "-";

  const status = job.status.toUpperCase().padEnd(10);
  const promptPreview = job.prompt.slice(0, 50) + (job.prompt.length > 50 ? "..." : "");

  return `${job.id}  ${status}  ${elapsed.padEnd(8)}  ${job.reasoningEffort.padEnd(6)}  ${promptPreview}`;
}

function refreshJobsForDisplay(jobs: Job[]): Job[] {
  return jobs.map((job) => {
    if (job.status !== "running" && job.status !== "pending") return job;
    const refreshed = refreshJobStatus(job.id);
    return refreshed ?? job;
  });
}

function sortJobsRunningFirst(jobs: Job[]): Job[] {
  const statusRank: Record<Job["status"], number> = {
    running: 0,
    pending: 1,
    failed: 2,
    completed: 3,
  };

  return [...jobs].sort((a, b) => {
    const rankDiff = statusRank[a.status] - statusRank[b.status];
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function applyJobsLimit<T>(jobs: T[], limit: number | null): T[] {
  if (!limit || limit <= 0) return jobs;
  return jobs.slice(0, limit);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a job, bounded by wall clock and narrated when it stops converging.
 *
 * The 2026-07-26 run had neither bound. It was never *inactive* — 115 exec calls over
 * 110 minutes — so an inactivity timeout would not have caught it either. What was
 * missing was a total-elapsed ceiling and any signal at all that it was making calls
 * without approaching an answer.
 */
async function waitForJobCompletion(
  jobId: string,
  timeoutMinutes: number | null = null,
  /**
   * When true, the wait ends as soon as a verdict appears rather than when the Codex
   * process exits. A Codex session stays `running` after the agent has answered — it
   * only closes on /quit or inactivity — so waiting for exit made a verification pass
   * that had already answered correctly still burn its whole wall-clock bound and get
   * scored as a timeout.
   */
  expectVerdict = false,
  pollIntervalMs = 1000
): Promise<Job | null> {
  const startedMs = Date.now();
  const timeoutMs = timeoutMinutes ? timeoutMinutes * 60_000 : null;
  let heartbeatsEmitted = 0;
  let ticks = 0;

  while (true) {
    const refreshed = refreshJobStatus(jobId);
    if (!refreshed || refreshed.status !== "running") {
      return refreshed;
    }

    const elapsedMs = Date.now() - startedMs;
    ticks += 1;

    if (expectVerdict && ticks % 3 === 0) {
      // Resolving the transcript walks the sessions tree, so do not do it every tick.
      const verdict = getRunLedger(jobId)?.verdict ?? null;
      if (verdict) {
        const answered = loadJob(jobId);
        if (answered) {
          answered.verdict = verdict;
          answered.turnState = "idle";
          saveJob(answered);
        }
        console.error(`\ncontract: verdict reached (${verdict}) — closing session ${jobId}.`);
        sendToJob(jobId, "/quit");
        // Give Codex a moment to exit cleanly so the job records completion itself.
        for (let i = 0; i < 10; i += 1) {
          await sleep(500);
          const closing = refreshJobStatus(jobId);
          if (closing && closing.status !== "running") return closing;
        }
        return loadJob(jobId);
      }
    }

    // Fail fast on a prompt that will never resolve on its own. Without this, the
    // first live run of this contract spent its entire wall-clock bound sitting on a
    // directory-trust prompt and then reported "no verdict", which points at the
    // wrong problem entirely.
    const blocking = detectBlockingPrompt(getJobOutput(jobId, 40));
    if (blocking.blocked) {
      console.error(`\ncontract: job ${jobId} is BLOCKED on an interactive prompt, not working.`);
      console.error(`  ${blocking.hint}`);
      console.error(`  Inspect with: codex-agent capture ${jobId} 40 --clean`);
      killJob(jobId);
      const stopped = loadJob(jobId);
      if (stopped) {
        stopped.blockerKind = blocking.kind;
        if (!stopped.error) stopped.error = "Blocked on an interactive Codex prompt";
        saveJob(stopped);
      }
      return loadJob(jobId);
    }

    if (timeoutMs !== null && elapsedMs >= timeoutMs) {
      const ledger = getRunLedger(jobId);
      console.error(
        `\ncontract: wall-clock bound of ${timeoutMinutes}m reached — stopping job ${jobId}.`
      );
      console.error(
        `  ${ledger?.execCount ?? "?"} exec calls, verdict: ${ledger?.verdict ?? "NONE"}.`
      );
      console.error(
        "  This is the bound working, not a crash. Narrow the property, supply the diff,"
      );
      console.error("  or raise it with --timeout <minutes>.");
      killJob(jobId);
      const stopped = loadJob(jobId);
      if (stopped) {
        stopped.timedOut = true;
        if (!stopped.error) stopped.error = `Timed out after ${timeoutMinutes}m without a verdict`;
        saveJob(stopped);
      }
      return loadJob(jobId);
    }

    // Report non-convergence while it is still happening, rather than after.
    const ledger = getRunLedger(jobId);
    const heartbeat = evaluateHeartbeat({
      elapsedMs,
      execCount: ledger?.execCount ?? 0,
      verdict: ledger?.verdict ?? null,
      // Back off after the first report so a long legitimate run is not spammed:
      // 5m/40 execs, then 10m/80, then 15m/120...
      afterMinutes: DEFAULT_HEARTBEAT_MINUTES * (heartbeatsEmitted + 1),
      afterExecs: DEFAULT_HEARTBEAT_EXECS * (heartbeatsEmitted + 1),
    });

    if (heartbeat.shouldReport) {
      console.error(`contract: ${heartbeat.message}`);
      heartbeatsEmitted += 1;
    }

    await sleep(pollIntervalMs);
  }
}

async function notifyOnCompletion(
  job: Job,
  notifyCommand: string | null
): Promise<void> {
  process.stdout.write("\x07");

  if (!notifyCommand) return;

  try {
    const { spawnSync } = await import("child_process");
    spawnSync(notifyCommand, {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        CODEX_AGENT_JOB_ID: job.id,
        CODEX_AGENT_STATUS: job.status,
        CODEX_AGENT_ERROR: job.error || "",
      },
    });
  } catch {
    // Best effort only; completion ping already emitted.
  }
}

function printDryRun(context: BuiltPromptContext, options: Options): void {
  const accounting = context.accounting;
  console.log(
    `Would send ~${accounting.estimatedTokens.toLocaleString()} tokens (${accounting.bytes.toLocaleString()} bytes)`
  );
  console.log(`Model: ${options.model}`);
  console.log(`Reasoning: ${options.reasoning}`);
  console.log(`Sandbox: ${options.sandbox}`);
  console.log("Prompt components:");
  for (const component of accounting.components) {
    console.log(
      `  - ${component.label}: ~${component.estimatedTokens.toLocaleString()} tokens, ${component.bytes.toLocaleString()} bytes`
    );
  }
  console.log(
    `Codebase map: ${accounting.map.included ? "included" : "not included"}`
  );
  if (accounting.map.included) {
    console.log(`Map path: ${accounting.map.path ?? "-"}`);
    console.log(
      `Map prompt cost: ~${accounting.map.estimatedTokens.toLocaleString()} tokens, ${accounting.map.bytes.toLocaleString()} bytes`
    );
    console.log(
      `Map metadata total_tokens: ${accounting.map.cartographerTotalTokens?.toLocaleString() ?? "-"}`
    );
  }
  console.log("\n--- Prompt Preview ---\n");
  console.log(context.prompt.slice(0, 3000));
  if (context.prompt.length > 3000) {
    console.log(`\n... (${context.prompt.length - 3000} more characters)`);
  }
}

/**
 * Read scope (normally a diff) from stdin.
 *
 * This is the channel the contract's scope rule checks. An interactive terminal has
 * no piped scope; an explicitly empty pipe (`< /dev/null`) is also treated as no
 * scope, so `--allow-unscoped` remains the only way to say "the whole tree" on
 * purpose rather than by accident.
 */
async function readStdinScope(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  try {
    const text = await new Response(Bun.stdin.stream()).text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

interface PreparedLaunch {
  context: BuiltPromptContext;
  passKind: PassKind;
  reasoning: ReasoningEffort;
  sandbox: SandboxMode;
  timeoutMinutes: number;
  scoped: boolean;
}

/**
 * Apply the invocation contract and shape the prompt.
 *
 * Both launch paths (`start` and the bare-prompt fall-through) route through here, so
 * there is no way to reach Codex while skipping the gate — the fall-through was how
 * an unscoped review would otherwise sneak past.
 */
async function prepareLaunch(taskPrompt: string, options: Options): Promise<PreparedLaunch> {
  const scopeText = await readStdinScope();
  const passKind = resolvePassKind(taskPrompt, options.passKind);
  const profile = PASS_PROFILES[passKind];

  if (options.contractEnabled) {
    const decision = evaluateContract({
      prompt: taskPrompt,
      scopeText,
      passKind: options.passKind,
      maxChecks: options.maxChecks,
      allowUnscoped: options.allowUnscoped,
    });

    if (!decision.ok) {
      console.error(formatViolations(decision.violations));
      // Distinct exit code: a contract refusal is not a crash and not a failed run.
      // Callers (and Claude) can branch on 3 to mean "fix the invocation, then retry".
      process.exit(3);
    }
  }

  // Effort tiering per pass, not one global dial. An explicit -r always wins so the
  // operator keeps the final say; otherwise the pass profile decides.
  const reasoning = options.reasoningExplicit ? options.reasoning : profile.reasoning;
  // Codex is the brain, not the hands. Every profile is read-only, so write access only
  // ever arrives through an explicit -s on the command line.
  const sandbox = options.sandboxExplicit ? options.sandbox : profile.sandbox;
  const timeoutMinutes = options.timeoutMinutes ?? profile.timeoutMinutes;

  let finalPrompt: string;
  if (options.contractEnabled && (options.property || profile.requiresVerdict)) {
    finalPrompt = shapeVerificationPrompt({
      property: options.property ?? taskPrompt,
      profile,
      scopeText,
      wordCap: options.wordCap === undefined ? profile.wordCap : options.wordCap,
    });
  } else if (scopeText) {
    finalPrompt = `${taskPrompt}\n\n=== DIFF ===\n${scopeText.trimEnd()}`;
  } else {
    finalPrompt = taskPrompt;
  }

  const context = await buildPromptContext({
    taskPrompt: finalPrompt,
    includeMap: options.includeMap,
    cwd: options.dir,
  });

  if (options.includeMap) {
    console.error(
      context.accounting.map.included ? "Included codebase map" : "No codebase map found",
    );
  }

  return {
    context,
    passKind,
    reasoning,
    sandbox,
    timeoutMinutes,
    scoped: Boolean(scopeText),
  };
}

function formatNextAction(job: CompactJobJson): string {
  return job.actions.recommended_next;
}

function formatHumanStatus(job: CompactJobJson): string {
  const lines = [
    `State: ${job.orchestration_state}`,
    `Process: ${job.process_state}`,
    `Turn: ${job.turn_state}${job.blocker_kind ? ` (${job.blocker_kind})` : ""}`,
    `Turns completed: ${job.turns_completed}`,
    `Last message: ${job.last_message ?? "-"}`,
    `Next: ${formatNextAction(job)}`,
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Model: ${job.model} (${job.reasoning})`,
    `Sandbox: ${job.sandbox}`,
    `Created: ${job.created_at}`,
  ];

  if (job.started_at) lines.push(`Started: ${job.started_at}`);
  if (job.completed_at) lines.push(`Completed: ${job.completed_at}`);
  if (job.last_activity_at) lines.push(`Last activity: ${job.last_activity_at}`);
  if (job.usage) {
    lines.push(
      `Usage: total=${job.usage.total.toLocaleString()} input=${job.usage.input.toLocaleString()} cached=${job.usage.cached_input.toLocaleString()} output=${job.usage.output.toLocaleString()}`
    );
  }
  if (job.context) {
    lines.push(
      `Context: ~${job.context.prompt_estimated_tokens.toLocaleString()} tokens, ${job.context.prompt_bytes.toLocaleString()} bytes`
    );
  }
  if (job.error) lines.push(`Error: ${job.error}`);

  return lines.join("\n");
}

type AwaitTurnResult = {
  shouldPoll: boolean;
  exitCode: number;
  message: string | null;
  reason: string | null;
  job: CompactJobJson;
};

function getAwaitTurnResult(job: Job): AwaitTurnResult {
  const compact = buildCompactJobJson(job);
  const fallbackMessage =
    compact.orchestration_state === "COMPLETED" ? "Job completed" : "Turn complete";

  switch (compact.orchestration_state) {
    case "WAITING":
      return {
        shouldPoll: false,
        exitCode: 0,
        message: compact.last_message ?? fallbackMessage,
        reason: null,
        job: compact,
      };
    case "COMPLETED":
      return {
        shouldPoll: false,
        exitCode: 0,
        message: compact.last_message ?? fallbackMessage,
        reason: null,
        job: compact,
      };
    case "BLOCKED":
      return {
        shouldPoll: false,
        exitCode: 2,
        message: null,
        reason: compact.blocker_kind
          ? `Job is blocked: ${compact.blocker_kind}`
          : "Job is blocked",
        job: compact,
      };
    case "FAILED":
      return {
        shouldPoll: false,
        exitCode: 1,
        message: null,
        reason: compact.error ?? "Job failed",
        job: compact,
      };
    case "CANCELLED":
      return {
        shouldPoll: false,
        exitCode: 1,
        message: null,
        reason: "Job was cancelled",
        job: compact,
      };
    case "STALE":
      return {
        shouldPoll: false,
        exitCode: 2,
        message: null,
        reason: "Job is stale",
        job: compact,
      };
    case "PENDING":
    case "STARTING":
    case "WORKING":
      return {
        shouldPoll: true,
        exitCode: 0,
        message: null,
        reason: null,
        job: compact,
      };
  }
}

function printAwaitTurnResult(result: AwaitTurnResult, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          schema_version: result.job.schema_version,
          generated_at: new Date().toISOString(),
          job: result.job,
          outcome: result.exitCode === 0 ? "ready" : "not_ready",
          message: result.message,
          reason: result.reason,
        },
        null,
        2
      )
    );
    return;
  }

  if (result.exitCode === 0) {
    console.log(result.message ?? "Turn complete");
  } else {
    console.error(result.reason ?? "Job cannot be awaited");
  }
}

function markSignalTurnComplete(job: Job, signalMessage: string | null, timestamp: string): Job {
  if (job.turnState !== "idle") {
    job.turnsCompleted = (job.turnsCompleted ?? job.turnCount ?? 0) + 1;
  }
  job.lastTurnCompletedAt = timestamp;
  job.lastAgentMessage = signalMessage;
  job.turnState = "idle";
  saveJob(job);
  return loadJob(job.id) ?? job;
}

async function awaitTurn(jobId: string, json: boolean): Promise<void> {
  const initial = refreshJobStatus(jobId);
  if (!initial) {
    console.error(`Job ${jobId} not found`);
    process.exit(1);
  }

  const existingSignal = getTurnSignal(jobId);
  if (existingSignal) {
    const completedTurn = markSignalTurnComplete(
      initial,
      existingSignal.lastAgentMessage,
      existingSignal.timestamp
    );
    const result = getAwaitTurnResult(completedTurn);
    printAwaitTurnResult(result, json);
    process.exit(result.exitCode);
  }

  const initialResult = getAwaitTurnResult(initial);
  if (!initialResult.shouldPoll) {
    printAwaitTurnResult(initialResult, json);
    process.exit(initialResult.exitCode);
  }

  if (!json) {
    console.error(`Waiting for turn completion... (job: ${jobId})`);
  }

  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });

  let awaitTurnPollCount = 0;
  const contextWindowText = "Codex ran out of room in the model's context window";

  while (!stopped) {
    await sleep(500);
    awaitTurnPollCount += 1;

    const signal = getTurnSignal(jobId);
    if (signal) {
      const current = refreshJobStatus(jobId) ?? loadJob(jobId);
      if (!current) {
        console.error(`Job ${jobId} not found`);
        process.exit(1);
      }
      const completedTurn = markSignalTurnComplete(current, signal.lastAgentMessage, signal.timestamp);
      const result = getAwaitTurnResult(completedTurn);
      printAwaitTurnResult(result, json);
      process.exit(result.exitCode);
    }

    if (awaitTurnPollCount % 5 === 0) {
      const paneOutput = getJobOutput(jobId, 10);
      if (paneOutput && (paneOutput.includes("ran out of room") || paneOutput.includes("context window"))) {
        const current = loadJob(jobId);
        if (current) {
          current.turnState = "context_limit";
          current.blockerKind = "context_limit";
          current.error = contextWindowText;
          saveJob(current);
          const result = getAwaitTurnResult(loadJob(jobId) ?? current);
          printAwaitTurnResult(result, json);
          process.exit(result.exitCode);
        }

        console.error("Agent hit context window limit");
        process.exit(2);
      }
    }

    const current = refreshJobStatus(jobId);
    if (!current) {
      console.error(`Job ${jobId} not found`);
      process.exit(1);
    }

    const result = getAwaitTurnResult(current);
    if (!result.shouldPoll) {
      printAwaitTurnResult(result, json);
      process.exit(result.exitCode);
    }
  }

  console.error("\nStopped waiting");
  process.exit(0);
}

/**
 * The single launch path. Applies the contract, starts the job, and — when waiting —
 * enforces the wall-clock bound and reports the run ledger at the end.
 */
async function launchJob(taskPrompt: string, options: Options): Promise<void> {
  const launch = await prepareLaunch(taskPrompt, options);

  if (options.dryRun) {
    printDryRun(launch.context, { ...options, reasoning: launch.reasoning, sandbox: launch.sandbox });
    console.log("");
    console.log(`Pass: ${launch.passKind} (${PASS_PROFILES[launch.passKind].description})`);
    console.log(`Scoped by stdin: ${launch.scoped ? "yes" : "no"}`);
    console.log(`Wall-clock bound: ${launch.timeoutMinutes}m`);
    process.exit(0);
  }

  if (!isTmuxAvailable()) {
    console.error("Error: tmux is required but not installed");
    console.error("Install with: brew install tmux");
    process.exit(1);
  }

  const job = startJob({
    prompt: launch.context.prompt,
    promptContext: launch.context.accounting,
    model: options.model,
    reasoningEffort: launch.reasoning,
    sandbox: launch.sandbox,
    parentSessionId: options.parentSessionId ?? undefined,
    cwd: options.dir,
    passKind: launch.passKind,
    scoped: launch.scoped,
    timeoutMinutes: launch.timeoutMinutes,
  });

  console.log(`Job started: ${job.id}`);
  console.log(`Model: ${job.model} (${job.reasoningEffort})`);
  console.log(`Pass: ${launch.passKind}  Sandbox: ${launch.sandbox}  Scoped: ${launch.scoped ? "yes" : "no"}  Bound: ${launch.timeoutMinutes}m`);
  console.log(`Working dir: ${job.cwd}`);
  console.log(`tmux session: ${job.tmuxSession}`);
  console.log("");
  console.log("Commands:");
  console.log(`  Capture output:  codex-agent capture ${job.id}`);
  console.log(`  Send message:    codex-agent send ${job.id} "message"`);
  console.log(`  Attach session:  tmux attach -t ${job.tmuxSession}`);

  if (!options.waitForCompletion) return;

  const completed = await waitForJobCompletion(
    job.id,
    launch.timeoutMinutes,
    PASS_PROFILES[launch.passKind].requiresVerdict,
  );
  if (!completed) {
    console.error("Job disappeared while waiting");
    process.exit(1);
  }

  console.log(`\nJob ${completed.id} completed with status: ${completed.status}`);
  if (completed.status === "failed" && completed.error) {
    console.log(`Error: ${completed.error}`);
  }

  const finalOutput = getJobFullOutput(job.id);
  if (finalOutput) {
    console.log("");
    console.log(options.stripAnsi ? cleanTerminalOutput(finalOutput) : finalOutput);
  }

  // Persist the verdict so the ledger does not have to re-derive it later.
  const ledger = getRunLedger(job.id);
  if (ledger) {
    const persisted = loadJob(job.id);
    if (persisted && persisted.verdict !== ledger.verdict) {
      persisted.verdict = ledger.verdict;
      saveJob(persisted);
    }

    console.log("");
    console.log(LEDGER_HEADER);
    console.log(formatLedgerRow(ledger));

    if (!ledger.verdictProduced && PASS_PROFILES[launch.passKind].requiresVerdict) {
      console.log("");
      console.log(
        `contract: this ${launch.passKind} pass produced NO verdict. That is the ` +
          "2026-07-26 failure mode."
      );
      console.log("  Narrow to one property and pipe the diff; do not raise the timeout first.");
    }
  }

  await notifyOnCompletion(completed, options.notifyOnComplete);

  // A verification pass that never concluded is not a success, and must not look
  // like one to a caller checking exit status.
  if (ledger && PASS_PROFILES[launch.passKind].requiresVerdict && !ledger.verdictProduced) {
    process.exit(4);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const { command, positional, options } = parseArgs(args);

  try {
    switch (command) {
      case "health": {
        // Check tmux
        if (!isTmuxAvailable()) {
          console.error("tmux not found");
          console.error("Install with: brew install tmux");
          process.exit(1);
        }
        console.log("tmux: OK");

        // Check codex
        const { execSync } = await import("child_process");
        try {
          const version = execSync("codex --version", { encoding: "utf-8" }).trim();
          console.log(`codex: ${version}`);
        } catch {
          console.error("codex CLI not found");
          console.error("Install with: npm install -g @openai/codex");
          process.exit(1);
        }

        console.log("Status: Ready");
        break;
      }

      case "start": {
        // --property carries the whole question for a verification pass, so a
        // positional prompt is optional when it is present.
        if (positional.length === 0 && !options.property) {
          console.error("Error: No prompt provided");
          console.error('Give a prompt, or --property "<single falsifiable claim>" for a review pass.');
          process.exit(1);
        }

        const taskPrompt = positional.length > 0 ? positional.join(" ") : options.property!;
        await launchJob(taskPrompt, options);
        break;
      }

      case "status": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const job = refreshJobStatus(positional[0]);
        if (!job) {
          console.error(`Job ${positional[0]} not found`);
          process.exit(1);
        }

        const statusPayload = getStatusJson(positional[0]);
        if (!statusPayload) {
          console.error(`Job ${positional[0]} not found`);
          process.exit(1);
        }
        if (options.json) {
          console.log(JSON.stringify(statusPayload, null, 2));
          break;
        }

        console.log(formatHumanStatus(statusPayload.job));
        if (job.tmuxSession) {
          console.log(`tmux session: ${job.tmuxSession}`);
        }
        break;
      }

      case "await-turn": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        await awaitTurn(positional[0], options.json);
        break;
      }

      case "send": {
        if (positional.length < 2) {
          console.error("Error: Usage: codex-agent send <jobId> \"message\"");
          process.exit(1);
        }

        const jobId = positional[0];
        const message = positional.slice(1).join(" ");

        if (sendToJob(jobId, message)) {
          console.log(`Sent to ${jobId}: ${message}`);
        } else {
          console.error(`Could not send to job ${jobId}`);
          console.error("Job may not be running or tmux session not found");
          process.exit(1);
        }
        break;
      }

      case "capture": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const lines = positional[1] ? parseInt(positional[1], 10) : 50;
        let output = getJobOutput(positional[0], lines);

        if (output) {
          if (options.stripAnsi) {
            output = cleanTerminalOutput(output);
          }
          console.log(output);
        } else {
          console.error(`Could not capture output for job ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      case "output": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        let output = getJobFullOutput(positional[0]);
        if (output) {
          if (options.stripAnsi) {
            output = cleanTerminalOutput(output);
          }
          console.log(output);
        } else {
          console.error(`Could not get output for job ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      case "attach": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const attachCmd = getAttachCommand(positional[0]);
        if (attachCmd) {
          console.log(attachCmd);
        } else {
          console.error(`Job ${positional[0]} not found or no tmux session`);
          process.exit(1);
        }
        break;
      }

      case "watch": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const job = loadJob(positional[0]);
        if (!job || !job.tmuxSession) {
          console.error(`Job ${positional[0]} not found or no tmux session`);
          process.exit(1);
        }

        console.error(`Watching ${job.tmuxSession}... (Ctrl+C to stop)`);
        console.error("For interactive mode, use: tmux attach -t " + job.tmuxSession);
        console.error("");

        // Simple polling-based watch
        let lastOutput = "";
        const pollInterval = setInterval(() => {
          const output = getJobOutput(positional[0], 100);
          if (output && output !== lastOutput) {
            // Print only new content
            if (lastOutput) {
              const newPart = output.replace(lastOutput, "");
              if (newPart.trim()) {
                process.stdout.write(newPart);
              }
            } else {
              console.log(output);
            }
            lastOutput = output;
          }

          // Check if job is still running
          const refreshed = refreshJobStatus(positional[0]);
          if (refreshed && refreshed.status !== "running") {
            console.error(`\nJob ${refreshed.status}`);
            clearInterval(pollInterval);
            process.exit(0);
          }
        }, 1000);

        // Handle Ctrl+C
        process.on("SIGINT", () => {
          clearInterval(pollInterval);
          console.error("\nStopped watching");
          process.exit(0);
        });
        break;
      }

      case "jobs": {
        if (options.json) {
          const limit = options.jobsAll ? null : options.jobsLimit;
          const payload = getJobsJson({
            all: options.jobsAll,
            limit,
          });
          console.log(JSON.stringify(payload, null, 2));
          break;
        }

        const limit = options.jobsAll ? null : options.jobsLimit;
        const allJobs = refreshJobsForDisplay(
          listJobs({
            all: options.jobsAll,
            limit,
          })
        );
        const sortedJobs = sortJobsRunningFirst(allJobs);
        const jobs = options.jobsAll ? sortedJobs : applyJobsLimit(sortedJobs, limit);
        if (jobs.length === 0) {
          console.log("No jobs");
        } else {
          console.log("ID        STATUS      ELAPSED   EFFORT  PROMPT");
          console.log("-".repeat(80));
          for (const job of jobs) {
            console.log(formatJobStatus(job));
          }
        }
        break;
      }

      case "sessions": {
        const sessions = listSessions();
        if (sessions.length === 0) {
          console.log("No active codex-agent sessions");
        } else {
          console.log("SESSION NAME                    ATTACHED  CREATED");
          console.log("-".repeat(60));
          for (const session of sessions) {
            const attached = session.attached ? "yes" : "no";
            console.log(
              `${session.name.padEnd(30)}  ${attached.padEnd(8)}  ${session.created}`
            );
          }
        }
        break;
      }

      case "kill": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        if (killJob(positional[0])) {
          console.log(`Killed job: ${positional[0]}`);
        } else {
          console.error(`Could not kill job: ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      case "ledger": {
        const limit = options.jobsAll ? null : options.jobsLimit;
        const ledgers = getRunLedgers({ all: options.jobsAll, limit });

        if (options.json) {
          console.log(
            JSON.stringify(
              { schema_version: "codex-agent.ledger.v1", generated_at: new Date().toISOString(), runs: ledgers },
              null,
              2
            )
          );
          break;
        }

        if (ledgers.length === 0) {
          console.log("No runs");
          break;
        }

        console.log(LEDGER_HEADER);
        console.log("-".repeat(LEDGER_HEADER.length));
        for (const ledger of ledgers) {
          console.log(formatLedgerRow(ledger));
        }

        // Surface the aggregate the 2026-07-26 post-mortem had to reconstruct by hand.
        const verificationRuns = ledgers.filter((entry) => entry.passKind && entry.passKind !== "plan");
        const noVerdict = verificationRuns.filter((entry) => !entry.verdictProduced);
        if (verificationRuns.length > 0) {
          console.log("");
          console.log(
            `${noVerdict.length}/${verificationRuns.length} verification runs produced no verdict.`
          );
        }
        break;
      }

      case "clean": {
        const cleaned = cleanupOldJobs(7);
        console.log(
          `Cleaned ${cleaned.jobsDeleted} old jobs and killed ${cleaned.orphanedSessionsKilled} orphaned tmux sessions`
        );
        // Report the disk actually freed. Previously `clean` archived artifacts into
        // jobs/.trash and reported jobs "cleaned" while freeing nothing, so 699 MB
        // accumulated without any signal that it was happening.
        const freedMb = Math.round((cleaned.bytesFreed ?? 0) / 1_048_576);
        console.log(
          `Expired ${cleaned.archivedPurged ?? 0} archived jobs, freeing ${freedMb} MB`
        );
        break;
      }

      case "delete": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        if (deleteJob(positional[0])) {
          console.log(`Deleted job: ${positional[0]}`);
        } else {
          console.error(`Could not delete job: ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      default:
        // Treat as prompt for start command. Routed through the same launchJob as
        // `start` so the contract cannot be bypassed by omitting the subcommand.
        if (command) {
          await launchJob([command, ...positional].join(" "), options);
        } else {
          console.log(HELP);
        }
    }
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

main();
