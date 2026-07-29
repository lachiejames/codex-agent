# codex-agent

CLI tool for running OpenAI Codex as a read-only planning and review brain, supervised, while
Claude does all the writing. Designed for Claude Code orchestration: bounded questions in,
retrievable answers and machine-checkable verdicts out.

Private hard fork of `Bootoshi/codex-orchestrator`, owned by lachiejames. There is
exactly **one tree**: this repo. `~/.codex-orchestrator` is a compatibility symlink to
it, and `.zshrc` puts `./bin` on PATH directly. Previously the CLI and the Claude
plugin lived in two independent clones plus a plugin cache copy, so every edit landed
in one and not the others.

[docs/SPEC.md](docs/SPEC.md) is authoritative: eleven numbered behaviours, and the thing every
change is checked against. When code and that file disagree, one of them is wrong and the
disagreement gets resolved rather than absorbed.

## The invocation contract

The reason this fork exists. `src/contract.ts` refuses unscoped verification passes, caps
answers, requires a machine-checkable `VERDICT:` line, ratchets its own escape hatches, and
reports non-convergence while it is still happening. Read the header comment in that file
before changing any of it — every rule is derived from a measured 1h50m/115-exec/no-verdict
failure on 2026-07-26.

Exit codes: **3** = contract refusal (fix the invocation), **4** = the run is not a usable
result — a verification pass with no verdict, or a run a bound stopped.

`src/bounds.ts` is the second half of the same argument: the contract decides whether a call
may start, the bound decides whether a running turn may continue. It is one pure function
returning `continue | warn | kill`, with two enforcers. Read its header before changing
either — it records which ceilings were deliberately _rejected_ and why.

**Stack**: TypeScript, Bun, OpenAI Codex CLI. **No tmux** — it was the previous transport and
is not a dependency any more.

**Structure**: shell wrapper -> CLI entry point -> contract -> detached supervisor process ->
`codex exec --json` -> run artifacts on disk

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).

## The transport

One `codex exec --json` process **per turn**, owned by one supervisor process per run:

- A **run** is a Codex thread plus everything observed about it, driven by N successive
  processes. It is not a long-lived interactive session. Modelling it as one is what made the
  wall-clock bound measure conversation lifetime instead of thinking time.
- The event stream is **typed JSONL**, one event per line, folded incrementally.
- The answer of record is the file Codex writes via **`--output-last-message`**, never
  anything this tool parses out of the stream.
- Turns are continued with **`codex exec resume <threadId>`**, which is what makes both
  steering and warn-then-kill possible.
- Exactly **one Codex process per thread** at any moment. That is what keeps the event stream
  and the answer file single-writer.

`codex exec` and `codex exec resume` do **not** take the same flags — `--sandbox` and
`-C/--cd` are rejected on resume. See the header of `src/runner.ts` before touching argv
construction; that asymmetry, handled naively, silently drops the read-only sandbox on every
steered or warned turn.

## Development

```bash
# Run directly
bun run src/cli.ts --help

# Or via shell wrapper
./bin/codex-agent --help

# Health check
bun run src/cli.ts health

# See a decision without paying for it: the shaped prompt, the pass, the bound, the cost
bun run src/cli.ts start --pass plan "Design a cache" --timeout 45 --dry-run

bun test           # every module with logic has a table-tested pure core
bun run validate   # lint + format check + typecheck + test
```

Command surface: `start`, `status`, `await` (alias `await-turn`), `send`, `tail` (alias
`capture`), `report`, `runs` (alias `jobs`), `ledger`, `kill`, `clean`, `health`.

`attach`, `watch`, `sessions`, `output` and `delete` are **gone** along with the tmux
transport, as are the `--strip-ansi`/`--clean` flags — there is no pane left to clean. An
unknown subcommand is an error (exit 1); it used to fall through and be launched as a prompt,
so `codex-agent repot abc123` spawned a real Codex run.

## Key Files

| File                    | Purpose                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `src/cli.ts`            | Commands, flags, help. Thin: it parses, applies the contract, and prints              |
| `src/contract.ts`       | Invocation contract: scope rule, breadth guard, bypass ratchet, verdicts, ledger      |
| `src/bounds.ts`         | The bound decision: continue, warn, kill. Pure; one function, two enforcers           |
| `src/supervisor.ts`     | One process per run, awake for its whole life. Spawns Codex, warns, steers, concludes |
| `src/runner.ts`         | Builds `codex exec` argv. Pure. Owns the exec/resume flag asymmetry                   |
| `src/event-stream.ts`   | Parses `codex exec --json` into metrics. Pure: strings in, values out                 |
| `src/run-store.ts`      | The `Run` record and its artifacts under `~/.codex-agent/jobs/`                       |
| `src/run-commands.ts`   | launch / send / refresh / kill. `refreshRun` is the dead-supervisor backstop          |
| `src/answer-store.ts`   | Durable untruncated answers (`<runId>.answer.md`), one block per concluded turn       |
| `src/report.ts`         | `codex-agent report`: what was asked, what came back, why it was judged so            |
| `src/run-report.ts`     | Maps a `Run` onto the ledger row, the report, and the live progress line              |
| `src/prompt-context.ts` | Prompt assembly and token accounting for `--dry-run`                                  |
| `src/files.ts`          | Codebase-map lookup, resolved against real directory entries                          |
| `src/config.ts`         | Model, effort, sandbox, jobs dir. **No timeout default lives here or anywhere**       |
| `plugins/`              | Claude Code plugin (marketplace structure)                                            |

## Plugin Structure

This repo doubles as a Claude Code plugin marketplace:

```
.claude-plugin/marketplace.json     # marketplace registry
plugins/codex-agent/                # the plugin
  .claude-plugin/plugin.json        # plugin metadata
  skills/codex-agent/               # the orchestration skill
    SKILL.md                        # skill instructions
  scripts/install.sh                # dependency installer
```

NOTE: as of 2026-07-27 an enterprise policy on this machine restricts plugin
marketplaces to an allowlist that this repo is not on, so the plugin cannot currently
be loaded by Claude Code through any source (directory, GitHub, or `~/.claude/skills`).
The CLI is unaffected. See the repo's git history for the investigation.

## Dependencies

- **Runtime**: Bun, codex CLI. That is all — no tmux, no `script(1)`.
- **NPM**: none. `package.json` has an empty `dependencies`.

## Notes

- Run artifacts live in `~/.codex-agent/jobs/`: `.run.json`, `.jsonl`, `.last.txt`,
  `.answer.md`, `.stderr`, `.steer`, `.supervisor.log`
- Turn completion is the Codex process exiting, plus a non-empty `--output-last-message` file.
  Both are checked: pointing `-o` at an unwritable path warns on stderr and **still exits 0**
- Bun is the TypeScript runtime - never use npm/yarn/pnpm for running
- `bash scripts/verify-install.sh --all` is the gate. It asserts the spec on this machine,
  including that its own metrics are still arriving

## Claude Orchestration Pattern (Persisted)

- **`--timeout <minutes>` is required on every launch.** No default exists anywhere; omitting
  it is exit 3. See below.
- Prefer `--wait` for any pass that must conclude: it returns the moment the turn concludes
  and prints a running cost line every 20 seconds meanwhile.
- `codex-agent start "<task>" --timeout <min>` without `--wait` is still correct for a
  conversation you intend to continue with `send`. **The bound applies either way.**
- Track run IDs immediately.
- Use `codex-agent status <id>` for what it is doing right now — last command, execs, spend,
  whether it has been warned, whether its supervisor is alive.
- Use `codex-agent tail <id> [n]` for the raw event stream while running.
- Use **`codex-agent report <id>`** to read the result: what was asked, the answer
  untruncated, the ledger row, and whether the run is usable. Exit 4 means it is not.
- `codex-agent send <id> "message"` interrupts the in-flight turn and resumes the thread
  carrying the message. Everything already completed is preserved.
- There is nothing to close. A concluded turn leaves the run `waiting` with no process
  running; `clean` deletes runs after a week.

### `--timeout` is required, and it bounds one turn

A default that a machine caller inherits silently is not a bound, it is a habit — a 10-minute
review and a 60-minute deep pass end up sharing one accidental number. Only the caller knows
which this is. So every per-pass profile timeout and both config defaults were deleted, and
`prepareLaunch` checks for the flag **first**, before anything else about the invocation, so
the refusal is identical whether or not the rest is well formed.

The bound covers one turn of thinking, not the life of a conversation. A steer starts a new
turn with a fresh copy of the same bound; a warn-and-resume continues the same turn under the
same deadline, deliberately — resetting it there would turn a 10-minute bound into 18.5.

### Warn, then kill

At 85% of the bound the supervisor interrupts the agent and resumes it asking for a conclusion
now. Only then is the bound fatal. Kill-at-bound made every timeout a gamble: too tight and a
good run is shot seconds from its verdict, too loose and a stray run burns an hour. Verified
live: a 4-minute-bounded run at 18 exec calls was interrupted, resumed, and produced
`VERDICT: CLEAN` instead of dying with nothing.

An answered run is **never** a breach. A concluded run goes idle by definition, so its signals
flat-line, and scoring that as a stall corrupts the exact number the ledger exists to report.

### The bound is not tied to `--wait`

This used to be false, and it was the worst defect in the tool: the bounds lived inside the
`--wait` loop in `cli.ts` while this very section told callers to start jobs in the background,
so the documented default path had nothing bounding it.

The decision now lives in `src/bounds.ts` and has two enforcers. The supervisor acts on all
three outcomes. Every observing command — `status`, `await`, `report`, `runs`, `ledger` — calls
`refreshRun`, which re-derives the run from its files and applies the same function; it cannot
warn, since that needs a live process holding the child, but it can and does kill a run whose
supervisor died holding it open. A contract that holds on one invocation shape is not a
contract.

### No token ceiling, by decision

Measured over 87 recorded runs on 2026-07-29: the plan pass judged excellent cost 13.7M
tokens (25m, 83 execs); the plan pass judged a catastrophe cost 2.8M. The expensive one was
the good one, so no ceiling separates them. And the field anyone would have built a ceiling
on was ambiguous — `usage.total` for 42 runs, cumulative _input_ tokens for 37, reading
4.4x apart on near-identical jobs. The ledger now reports `SPENT` and `CUM-IN` separately
and never substitutes one for the other. Bound the question, not the thinking.

Likewise there is **no zero-exec fail-fast**: `execCount: 0` is the healthy signature of a
scoped pass, because the shaped prompt tells the agent not to read other files.
