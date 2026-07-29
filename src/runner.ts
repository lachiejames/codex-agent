// Building the `codex exec` command line.
//
// Pure: these functions return argv arrays. Nothing here spawns anything — `supervisor.ts`
// does that. Keeping argv construction separate is what makes the sandbox rule below
// testable, and the sandbox rule is the sharpest edge in this whole transport.
//
// ---------------------------------------------------------------------------
// THE FLAG ASYMMETRY, verified against codex-cli 0.145.0
// ---------------------------------------------------------------------------
//
// `codex exec` and `codex exec resume` do NOT take the same flags:
//
//   flag                     exec    exec resume
//   --sandbox <mode>         yes     NO — "error: unexpected argument '--sandbox' found"
//   -C / --cd <dir>          yes     NO
//   -o, --json, -m, -c       yes     yes
//
// So a resumed turn cannot be told its sandbox the way a first turn is. If that difference is
// handled by simply dropping the flag on resume — the obvious fix when the CLI rejects it —
// then every steered or warned turn silently runs under whatever `~/.codex/config.toml` says,
// rather than under the read-only sandbox its pass profile mandates. A review pass would gain
// write access halfway through, invisibly.
//
// The rule this file enforces: sandbox is ALWAYS passed as `-c sandbox_mode=...`, on both
// invocation shapes, and `--sandbox` is never used at all. One form, no divergence to forget.
// Working directory is likewise never a flag — it is the spawned process's cwd, which both
// shapes honour.

import type { ReasoningEffort, SandboxMode } from "./config.ts";

/**
 * Codex accepts arbitrary strings here and this value reaches a subprocess argv, so it is
 * constrained to the shape a model name actually takes. Inherited from the tmux transport,
 * where it guarded against shell injection; kept because validating input at the boundary is
 * right even now that there is no shell to inject into.
 */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Codex thread ids are UUIDs. Anything else would be a corrupt job record. */
const THREAD_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

export interface CodexInvocation {
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  /** Where `--output-last-message` writes the final answer. The answer of record. */
  lastMessagePath: string;
  /** The prompt for this turn. Passed as argv, never through a shell. */
  prompt: string;
  /** Resume an existing thread instead of starting a new one. */
  threadId?: string | undefined;
  /** Allow running outside a git repository. */
  skipGitRepoCheck?: boolean | undefined;
}

export function validateModelName(model: string): string {
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new Error(`Invalid Codex model name: ${JSON.stringify(model)}`);
  }
  return model;
}

export function validateThreadId(threadId: string): string {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new Error(`Invalid Codex thread id: ${JSON.stringify(threadId)}`);
  }
  return threadId;
}

/**
 * Config overrides shared by both invocation shapes.
 *
 * `sandbox_mode` lives here rather than as a `--sandbox` flag precisely so that the resumed
 * shape cannot silently lose it. See the header.
 */
function sharedConfigArgs(invocation: CodexInvocation): string[] {
  return [
    "-c",
    `model="${validateModelName(invocation.model)}"`,
    "-c",
    `model_reasoning_effort="${invocation.reasoningEffort}"`,
    "-c",
    `sandbox_mode="${invocation.sandbox}"`,
    "-c",
    "skip_update_check=true",
  ];
}

/**
 * Build argv for `codex`.
 *
 * The prompt is the final positional argument. Under the tmux transport it was interpolated
 * into a shell string as `"$(cat promptfile)"`; here the process is spawned directly with an
 * argv array, so there is no shell and therefore no quoting to get wrong.
 */
export function buildCodexArgv(invocation: CodexInvocation): string[] {
  const argv = invocation.threadId ? ["exec", "resume", validateThreadId(invocation.threadId)] : ["exec"];

  argv.push("--json", ...sharedConfigArgs(invocation), "-o", invocation.lastMessagePath);

  if (invocation.skipGitRepoCheck) argv.push("--skip-git-repo-check");

  argv.push(invocation.prompt);
  return argv;
}

/** True when this argv resumes a thread rather than starting one. */
export function isResumeArgv(argv: readonly string[]): boolean {
  return argv[0] === "exec" && argv[1] === "resume";
}

/**
 * Read the sandbox back out of an argv.
 *
 * Exists so the supervisor can assert, at spawn time, that the command it is about to run
 * carries the sandbox its pass profile requires — a belt-and-braces check on the one property
 * whose silent loss would be a security regression rather than a bug.
 */
export function readSandboxFromArgv(argv: readonly string[]): SandboxMode | null {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== "-c") continue;
    const match = /^sandbox_mode="(.+)"$/.exec(argv[index + 1] ?? "");
    if (match?.[1]) return match[1] as SandboxMode;
  }
  return null;
}
