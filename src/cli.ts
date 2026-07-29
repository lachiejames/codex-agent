#!/usr/bin/env bun

// codex-agent — Codex as a read-only brain, supervised.
//
// Every command here is thin. The invocation contract lives in contract.ts, the bound decision
// in bounds.ts, and the process that enforces both lives in supervisor.ts. This file parses
// arguments, applies the contract, and prints.
//
// See docs/SPEC.md for the eleven behaviours this implements.

import { config, type SandboxMode } from "./config.ts";
import {
  type BypassKind,
  evaluateContract,
  formatLedgerRow,
  formatViolations,
  isPassKind,
  LEDGER_HEADER,
  MIN_INLINE_SUBJECT_CHARS,
  PASS_KINDS,
  PASS_PROFILES,
  type PassKind,
  resolvePassKind,
  shapeVerificationPrompt,
} from "./contract.ts";
import { type BuiltPromptContext, buildPromptContext } from "./prompt-context.ts";
import { formatRunReport } from "./report.ts";
import { isProcessAlive, killRun, launchRun, refreshRun, sendToRun } from "./run-commands.ts";
import { buildRunLedger, buildRunReport, formatRunProgress } from "./run-report.ts";
import { isRunTerminal, listRuns, loadRun, purgeOldRuns, type Run, readStreamSince } from "./run-store.ts";

const HELP = `
codex-agent — Codex plans and reviews; Claude writes the code.

Usage:
  codex-agent start "prompt" --timeout <min>   Start a run
  codex-agent status <id> [--json]             What it is doing right now
  codex-agent await <id> [--json]              Block until the current turn concludes
  codex-agent send <id> "message"              Steer a running pass, or continue an idle one
  codex-agent tail <id> [n]                    Recent activity from the event stream
  codex-agent report <id> [--json]             What was asked, what came back, and the verdict
  codex-agent runs [--json] [--all]            List runs
  codex-agent ledger [--json]                  duration, tokens, execs, verdict
  codex-agent kill <id>                        Stop a run and its supervisor
  codex-agent clean                            Expire runs older than a week
  codex-agent health                           Check codex availability

--timeout is REQUIRED and has no default:
  A default a machine caller inherits silently is not a bound, it is a habit — a 10-minute
  review and a 60-minute deep pass end up sharing one accidental number. Only the caller
  knows which this is. Omitting it is a contract refusal (exit 3).

  The bound covers ONE turn of thinking, not the life of a conversation. At 85% of it the
  agent is interrupted and told to conclude with what it has; only then is the bound fatal,
  so a nearly-finished good run gets to finish.

Invocation contract:
  On 2026-07-26 a review packing ~25 checks into one call with no diff ran 1h50m across 115
  exec calls and produced no verdict. The same question, scoped to one property with the diff
  piped in, was answered correctly in 51 seconds. So: pipe the diff, ask one thing at a time.

    git diff origin/main...HEAD -- src/a.ts |
      codex-agent start --pass review --timeout 10 --property "postMessage cannot double-post"

  A review/verify/audit prompt with nothing on stdin is REFUSED. --allow-unscoped is the narrow
  exception: it needs an explicit --pass and the subject inline (at least ${MIN_INLINE_SUBJECT_CHARS}
  characters), and every honoured bypass shows up in the ledger.

  Fan out rather than widen. Five reviewers on five properties is the intended shape of a
  review; each is its own run, its own process and its own bound.

The thinker is pinned, not chosen:
  Every pass runs ${config.model} at ${config.reasoningEffort}. There is no flag to lower either,
  because a pass that silently downgrades the model is a footgun — you would ask for a check and
  quietly get a worse thinker than every other pass. Bound the question, not the thinking.

Supervision:
  A supervisor process owns each run for its whole life, so a pass that cannot start says so in
  seconds rather than burning its bound in silence. 'send' interrupts an in-flight turn and
  resumes the thread carrying your message — everything already completed is preserved.

Options:
      --timeout <minutes>    REQUIRED. Bound for one turn of thinking
      --pass <kind>          Pass profile: ${PASS_KINDS.join(", ")} (default: inferred)
      --property <claim>     The single falsifiable claim to attack (shapes the prompt)
      --allow-unscoped       Permit a verification pass with nothing on stdin. Needs an explicit
                             --pass and the subject inline; recorded in the ledger
      --max-checks <n>       Override the enumerated-check limit for this call
      --word-cap <n>         Override the answer word cap (0 disables)
      --no-contract          Disable contract enforcement entirely (escape hatch, recorded)
  -s, --sandbox <mode>       Sandbox (default: ${config.defaultSandbox} — Codex plans, it does not write)
  -w, --wait                 Wait for the run to conclude, printing a running cost line
  -d, --dir <path>           Working directory (default: cwd)
      --map                  Include the codebase map if available (bare flag, takes no value)
      --dry-run              Show the prompt and the decision without executing
      --json                 Machine-readable output
      --limit <n>            Limit runs shown
      --all                  Show all runs
  -h, --help                 Show this help

Exit codes:
  0  usable result
  1  operational failure
  3  contract refusal — fix the invocation, then retry
  4  the run is not a usable result (no verdict, or a guard stopped it)
`;

/**
 * Flags that existed and deliberately do not any more, with the reason.
 *
 * A removed flag that reports "unknown option" teaches nothing; a caller retries with a
 * variation. Saying WHY it went stops the next attempt.
 */
const RETIRED_FLAGS: Record<string, string> = {
  "--clean": "There is no terminal output to clean any more. Use `codex-agent tail <id>` for the event stream.",
  "--model": "The model is pinned to the strongest available and is not selectable. See docs/SPEC.md behaviour 2.",
  "--reasoning": "Reasoning effort is pinned to xhigh and is not selectable — bound the question, not the thinking.",
  "--strip-ansi": "There is no terminal output to strip any more. Use `codex-agent tail <id>`.",
  "-m": "The model is pinned to the strongest available and is not selectable. See docs/SPEC.md behaviour 2.",
  "-r": "Reasoning effort is pinned to xhigh and is not selectable — bound the question, not the thinking.",
};

interface Options {
  sandbox: SandboxMode;
  wait: boolean;
  dir: string;
  includeMap: boolean;
  dryRun: boolean;
  json: boolean;
  limit: number | null;
  all: boolean;
  passKind: PassKind | null;
  property: string | null;
  /** null means --timeout was never given. There is no default to fall back to. */
  timeoutMinutes: number | null;
  allowUnscoped: boolean;
  maxChecks: number | null;
  /** undefined defers to the profile, null means no cap, a number caps explicitly. */
  wordCap: number | null | undefined;
  contractEnabled: boolean;
  sandboxExplicit: boolean;
}

// max-lines-exempt: one flag-dispatch switch, being extracted in this series. Its length is the
// number of flags, not nested logic. Decomposed in a later commit on this branch.
function parseArgs(args: string[]): { command: string; positional: string[]; options: Options } {
  const options: Options = {
    all: false,
    allowUnscoped: false,
    contractEnabled: true,
    dir: process.cwd(),
    dryRun: false,
    includeMap: false,
    json: false,
    limit: config.runsListLimit,
    maxChecks: null,
    passKind: null,
    property: null,
    sandbox: config.defaultSandbox,
    sandboxExplicit: false,
    timeoutMinutes: null,
    wait: false,
    wordCap: undefined,
  };

  const positional: string[] = [];
  let command = "";

  function requireNumber(raw: string | undefined, label: string, minimum: number): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < minimum) {
      console.error(`Invalid ${label}: ${raw}`);
      process.exit(1);
    }
    return parsed;
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "-s" || arg === "--sandbox") {
      const mode = args[++index] as SandboxMode;
      if (!config.sandboxModes.includes(mode)) {
        console.error(`Invalid sandbox mode: ${mode}`);
        console.error(`Valid options: ${config.sandboxModes.join(", ")}`);
        process.exit(1);
      }
      options.sandbox = mode;
      options.sandboxExplicit = true;
    } else if (arg === "-w" || arg === "--wait") {
      options.wait = true;
    } else if (arg === "-d" || arg === "--dir") {
      options.dir = args[++index] ?? process.cwd();
    } else if (arg === "--map") {
      options.includeMap = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--limit") {
      options.limit = Math.floor(requireNumber(args[++index], "limit", 1));
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--pass") {
      const kind = args[++index];
      if (!kind || !isPassKind(kind)) {
        console.error(`Invalid pass kind: ${kind}`);
        console.error(`Valid options: ${PASS_KINDS.join(", ")}`);
        process.exit(1);
      }
      options.passKind = kind;
    } else if (arg === "--property") {
      options.property = args[++index] ?? null;
    } else if (arg === "--timeout") {
      options.timeoutMinutes = requireNumber(args[++index], "timeout (minutes)", 1);
    } else if (arg === "--allow-unscoped") {
      options.allowUnscoped = true;
    } else if (arg === "--max-checks") {
      options.maxChecks = Math.floor(requireNumber(args[++index], "max-checks", 0));
    } else if (arg === "--word-cap") {
      const parsed = Math.floor(requireNumber(args[++index], "word-cap", 0));
      options.wordCap = parsed === 0 ? null : parsed;
    } else if (arg === "--no-contract") {
      options.contractEnabled = false;
    } else if (arg !== undefined && arg.startsWith("-")) {
      // An unrecognised flag is an ERROR, never ignored.
      //
      // The parser used to fall through on anything it did not recognise, which was harmless
      // while every flag existed. It stopped being harmless the moment `-r` and `-m` were
      // removed: `-r low` would have dropped the flag AND appended "low" to the prompt as a
      // positional, silently corrupting the question being asked.
      const retired = RETIRED_FLAGS[arg];
      console.error(retired ? `${arg} was removed. ${retired}` : `Unknown option: ${arg}`);
      console.error("Run `codex-agent --help` for the current flags.");
      process.exit(1);
    } else if (arg !== undefined) {
      if (command) positional.push(arg);
      else command = arg;
    }
  }

  return { command, options, positional };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Read scope (normally a diff) from stdin.
 *
 * An interactive terminal has no piped scope; an explicitly empty pipe (`< /dev/null`) also
 * counts as none, so `--allow-unscoped` stays the only way to say "the whole tree" on purpose
 * rather than by accident.
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
  sandbox: SandboxMode;
  timeoutMinutes: number;
  requiresVerdict: boolean;
  scoped: boolean;
  bypass: BypassKind | null;
}

/**
 * Apply the invocation contract and shape the prompt.
 *
 * The single launch path, so there is no way to reach Codex while skipping the gate.
 */
// max-lines-exempt: the single launch path, so there is deliberately no second route to Codex
// that could skip the gate. Extracting parts of it creates exactly the bypass its comment says
// must not exist. The ordering of contract -> bound -> prompt assembly is the safety property.
async function prepareLaunch(taskPrompt: string, options: Options): Promise<PreparedLaunch> {
  // THE BOUND IS REQUIRED. Checked first, so the refusal is the same whether or not the rest of
  // the invocation is well formed. Exit 3 because it is a contract refusal — fix the invocation
  // and retry — not a crash.
  if (options.timeoutMinutes === null) {
    console.error(
      "contract: --timeout <minutes> is required and has no default.\n\n" +
        "  A default that a machine caller inherits silently is not a bound, it is a habit — a\n" +
        "  10-minute review and a 60-minute deep pass end up sharing one accidental number.\n" +
        "  Only the caller knows which this is, so the caller states it.\n\n" +
        "  The bound covers one turn of thinking, and at 85% the agent is interrupted and asked\n" +
        "  to conclude — so pick a number generous enough to finish, not a defensive one:\n" +
        "    narrow review of a small diff      --timeout 10\n" +
        "    deep adversarial pass              --timeout 20\n" +
        "    planning a large chunk of work     --timeout 60",
    );
    process.exit(3);
  }

  const scopeText = await readStdinScope();
  const passKind = resolvePassKind(taskPrompt, options.passKind);
  const profile = PASS_PROFILES[passKind];

  let bypass: BypassKind | null = options.contractEnabled ? null : "no-contract";

  if (options.contractEnabled) {
    const decision = evaluateContract({
      allowUnscoped: options.allowUnscoped,
      maxChecks: options.maxChecks,
      passKind: options.passKind,
      prompt: taskPrompt,
      scopeText,
    });

    if (!decision.ok) {
      console.error(formatViolations(decision.violations));
      process.exit(3);
    }

    bypass = decision.bypass;
    if (bypass) {
      console.error(
        "contract: running unscoped by explicit request. Recorded as a bypass — it will show in `codex-agent ledger`.",
      );
    }
  } else {
    console.error(
      "contract: --no-contract given; every guard in contract.ts is off for this run. Recorded as a bypass.",
    );
  }

  const sandbox = options.sandboxExplicit ? options.sandbox : profile.sandbox;

  let finalPrompt: string;
  if (options.contractEnabled && (options.property || profile.requiresVerdict)) {
    finalPrompt = shapeVerificationPrompt({
      profile,
      property: options.property ?? taskPrompt,
      scopeText,
      wordCap: options.wordCap === undefined ? profile.wordCap : options.wordCap,
    });
  } else if (scopeText) {
    finalPrompt = `${taskPrompt}\n\n=== DIFF ===\n${scopeText.trimEnd()}`;
  } else {
    finalPrompt = taskPrompt;
  }

  const context = await buildPromptContext({
    cwd: options.dir,
    includeMap: options.includeMap,
    taskPrompt: finalPrompt,
  });

  if (options.includeMap) {
    const map = context.accounting.map;
    if (map.included) {
      console.error(
        `Included codebase map: ${map.path} (~${map.estimatedTokens.toLocaleString()} tokens, ${map.bytes.toLocaleString()} bytes)`,
      );
      for (const other of map.ambiguousWith) {
        console.error(`  warning: ${other} also exists and differs only by case — it was NOT used.`);
      }
    } else {
      console.error(`No codebase map found under ${options.dir} (looked for docs/CODEBASE_MAP.md, CODEBASE_MAP.md)`);
    }
  }

  return {
    bypass,
    context,
    passKind,
    requiresVerdict: profile.requiresVerdict,
    sandbox,
    scoped: Boolean(scopeText),
    timeoutMinutes: options.timeoutMinutes,
  };
}

/** Ticks between running-cost lines. At a 1s poll this is one line every 20 seconds. */
const COST_REPORT_TICKS = 20;

async function waitForRun(runId: string): Promise<Run | null> {
  let ticks = 0;

  for (;;) {
    const run = refreshRun(runId);
    if (!run) return null;
    if (run.status === "waiting" || isRunTerminal(run)) return run;

    ticks += 1;
    // Visible running cost. Invisible spend with no meter is the same defect class as an
    // invisible ceiling: by the time anyone knows the number, it has been paid.
    if (ticks % COST_REPORT_TICKS === 0) console.error(`  ${formatRunProgress(run)}`);

    await sleep(1000);
  }
}

// max-lines-exempt: 4 lines over, and it is a straight sequence — prepare, spawn, print, maybe
// wait. Cutting it to satisfy the count would add an indirection worth less than the 4 lines.
async function launch(taskPrompt: string, options: Options): Promise<void> {
  const prepared = await prepareLaunch(taskPrompt, options);

  if (options.dryRun) {
    const accounting = prepared.context.accounting;
    console.log(
      `Would send ~${accounting.estimatedTokens.toLocaleString()} tokens (${accounting.bytes.toLocaleString()} bytes)`,
    );
    console.log(`Model: ${config.model}`);
    console.log(`Reasoning: ${config.reasoningEffort}`);
    console.log(`Sandbox: ${prepared.sandbox}`);
    console.log(`Pass: ${prepared.passKind} (${PASS_PROFILES[prepared.passKind].description})`);
    console.log(`Scoped by stdin: ${prepared.scoped ? "yes" : "no"}`);
    console.log(`Bypass: ${prepared.bypass ?? "none"}`);
    console.log(`Bound: ${prepared.timeoutMinutes}m per turn`);
    console.log("\n--- Prompt Preview ---\n");
    console.log(prepared.context.prompt.slice(0, 3000));
    if (prepared.context.prompt.length > 3000) {
      console.log(`\n... (${prepared.context.prompt.length - 3000} more characters)`);
    }
    process.exit(0);
  }

  const run = launchRun({
    bypass: prepared.bypass,
    cwd: options.dir,
    model: config.model,
    passKind: prepared.passKind,
    prompt: prepared.context.prompt,
    reasoningEffort: config.reasoningEffort,
    requiresVerdict: prepared.requiresVerdict,
    sandbox: prepared.sandbox,
    scoped: prepared.scoped,
    timeoutMinutes: prepared.timeoutMinutes,
  });

  console.log(`Run started: ${run.id}`);
  console.log(`Model: ${run.model} (${run.reasoningEffort})`);
  console.log(
    `Pass: ${run.passKind}  Sandbox: ${run.sandbox}  Scoped: ${run.scoped ? "yes" : "no"}  Bound: ${run.timeoutMinutes}m` +
      (run.bypass ? `  Bypass: ${run.bypass}` : ""),
  );
  console.log("");
  console.log("Commands:");
  console.log(`  Watch:  codex-agent status ${run.id}`);
  console.log(`  Steer:  codex-agent send ${run.id} "message"`);
  console.log(`  Read:   codex-agent report ${run.id}`);

  if (!options.wait) return;

  const finished = await waitForRun(run.id);
  if (!finished) {
    console.error("Run disappeared while waiting");
    process.exit(1);
  }

  const report = buildRunReport(finished);
  console.log("");
  console.log(formatRunReport(report));

  // A verification pass that never concluded is not a success, and must not look like one to a
  // caller checking exit status.
  if (report.judgement.failed) process.exit(4);
}

function requireRunId(positional: string[]): string {
  const runId = positional[0];
  if (runId === undefined) {
    console.error("Error: No run id provided");
    process.exit(1);
  }
  return runId;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

// max-lines-exempt: the command dispatcher. Its body is one branch per subcommand, each a few
// lines, so the length measures the SIZE OF THE COMMAND SURFACE rather than complexity. It also
// owns the process-wide exit-code taxonomy (1 / 3 / 4), which docs/SPEC.md pins and which must
// stay visible in one place. Restructuring it is a behaviour risk this style branch declines.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const { command, positional, options } = parseArgs(args);

  switch (command) {
    case "health": {
      const { execSync } = await import("node:child_process");
      try {
        console.log(`codex: ${execSync("codex --version", { encoding: "utf-8" }).trim()}`);
      } catch {
        console.error("codex CLI not found");
        console.error("Install with: npm install -g @openai/codex");
        process.exit(1);
      }
      console.log("Status: Ready");
      break;
    }

    case "start": {
      if (positional.length === 0 && !options.property) {
        console.error("Error: No prompt provided");
        console.error('Give a prompt, or --property "<single falsifiable claim>" for a verification pass.');
        process.exit(1);
      }
      await launch(positional.length > 0 ? positional.join(" ") : (options.property ?? ""), options);
      break;
    }

    case "status": {
      const runId = requireRunId(positional);
      const run = refreshRun(runId);
      if (!run) {
        console.error(`Run ${runId} not found`);
        process.exit(1);
      }

      if (options.json) {
        printJson({ generated_at: new Date().toISOString(), run, schema_version: run.schemaVersion });
        break;
      }

      console.log(`Run:        ${run.id}`);
      console.log(`Status:     ${run.status}`);
      console.log(`Progress:   ${formatRunProgress(run)}`);
      console.log(
        `Bound:      ${run.timeoutMinutes}m per turn${run.warned ? " (warned)" : ""}` +
          (run.boundRearmedCount > 0 ? `, re-armed ${run.boundRearmedCount}x by steers` : ""),
      );
      console.log(`Thread:     ${run.threadId ?? "-"}`);
      console.log(
        `Supervisor: ${run.supervisorPid ?? "-"}${isProcessAlive(run.supervisorPid) ? " (alive)" : " (gone)"}`,
      );
      console.log(`Turns:      ${run.metrics.turnsCompleted} completed, ${run.invocations.length} invocations`);
      if (run.error) console.log(`Error:      ${run.error}`);
      if (run.breachMessage) console.log(`Stopped:    ${run.breachMessage}`);
      break;
    }

    case "await":
    case "await-turn": {
      const runId = requireRunId(positional);
      const run = await waitForRun(runId);
      if (!run) {
        console.error(`Run ${runId} not found`);
        process.exit(1);
      }

      if (options.json) printJson({ generated_at: new Date().toISOString(), run });
      else console.log(formatRunProgress(run));

      if (run.status === "failed") process.exit(4);
      break;
    }

    case "send": {
      const runId = requireRunId(positional);
      if (positional.length < 2) {
        console.error('Error: Usage: codex-agent send <id> "message"');
        process.exit(1);
      }

      const outcome = sendToRun(runId, positional.slice(1).join(" "));
      if (!outcome.ok) {
        console.error(`Could not send to ${runId}: ${outcome.reason}`);
        process.exit(1);
      }
      console.log(
        outcome.delivery === "steered"
          ? `Steered ${runId} — the in-flight turn is interrupted and resumed with your message.`
          : `Resumed ${runId} with your message.`,
      );
      break;
    }

    case "tail":
    case "capture": {
      const runId = requireRunId(positional);
      const lines = positional[1] ? Number.parseInt(positional[1], 10) : 40;
      const chunk = readStreamSince(runId, 0);
      if (!chunk) {
        console.error(`No event stream for ${runId}`);
        process.exit(1);
      }
      const all = chunk.text.split("\n").filter((line) => line.trim());
      console.log(all.slice(-Math.max(1, lines)).join("\n"));
      break;
    }

    case "report": {
      const runId = requireRunId(positional);
      const run = refreshRun(runId) ?? loadRun(runId);
      if (!run) {
        console.error(`Run ${runId} not found`);
        process.exit(1);
      }

      const report = buildRunReport(run);
      if (options.json) {
        printJson({ generated_at: new Date().toISOString(), report, schema_version: "codex-agent.report.v2" });
      } else {
        console.log(formatRunReport(report));
      }

      if (report.judgement.failed) process.exit(4);
      break;
    }

    case "runs":
    case "jobs": {
      const runs = listRuns({ all: options.all, limit: options.limit });
      if (options.json) {
        printJson({ generated_at: new Date().toISOString(), runs, schema_version: "codex-agent.runs.v1" });
        break;
      }

      if (runs.length === 0) {
        console.log("No runs");
        break;
      }
      console.log("ID        STATUS     PASS          EXECS  VERDICT   PROMPT");
      console.log("-".repeat(90));
      for (const run of runs) {
        console.log(
          [
            run.id.padEnd(9),
            run.status.padEnd(10),
            (run.passKind ?? "-").padEnd(13),
            String(run.metrics.execCount).padStart(5),
            (run.verdict ?? "-").padEnd(9),
            run.prompt.replaceAll("\n", " ").slice(0, 40),
          ].join(" "),
        );
      }
      break;
    }

    case "ledger": {
      const ledgers = listRuns({ all: options.all, limit: options.limit }).map(buildRunLedger);
      if (options.json) {
        printJson({ generated_at: new Date().toISOString(), runs: ledgers, schema_version: "codex-agent.ledger.v3" });
        break;
      }

      if (ledgers.length === 0) {
        console.log("No runs");
        break;
      }
      console.log(LEDGER_HEADER);
      console.log("-".repeat(LEDGER_HEADER.length));
      for (const ledger of ledgers) console.log(formatLedgerRow(ledger));

      const verification = ledgers.filter((entry) => entry.passKind && entry.passKind !== "plan");
      if (verification.length > 0) {
        const noVerdict = verification.filter((entry) => !entry.verdictProduced);
        console.log("");
        console.log(`${noVerdict.length}/${verification.length} verification runs produced no verdict.`);
      }
      break;
    }

    case "kill": {
      const runId = requireRunId(positional);
      if (!killRun(runId)) {
        console.error(`Could not kill run: ${runId}`);
        process.exit(1);
      }
      console.log(`Killed run: ${runId}`);
      break;
    }

    case "clean": {
      const purged = purgeOldRuns(7);
      console.log(
        `Removed ${purged.runsRemoved} runs older than 7 days, freeing ${Math.round(purged.bytesFreed / 1_048_576)} MB`,
      );
      break;
    }

    default: {
      // An unknown subcommand used to fall through and be launched as a prompt, so a typo like
      // `codex-agent repot abc123` spawned a real Codex run. It is an error now: the cost of a
      // typo should be a message, not a bounded-but-real spend.
      if (command) {
        console.error(`Unknown command: ${command}`);
        console.error(
          'Run `codex-agent --help` for usage. To start a run: codex-agent start "<prompt>" --timeout <min>',
        );
        process.exit(1);
      }
      console.log(HELP);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
