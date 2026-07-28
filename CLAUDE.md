# codex-agent

CLI tool for delegating tasks to GPT Codex agents via tmux sessions. Designed for Claude Code orchestration with bidirectional communication.

Private hard fork of `Bootoshi/codex-orchestrator`, owned by lachiejames. There is
exactly **one tree**: this repo. `~/.codex-orchestrator` is a compatibility symlink to
it, and `.zshrc` puts `./bin` on PATH directly. Previously the CLI and the Claude
plugin lived in two independent clones plus a plugin cache copy, so every edit landed
in one and not the others.

## The invocation contract

The reason this fork exists. `src/contract.ts` refuses unscoped verification passes,
bounds every run by wall clock, caps answers, requires a machine-checkable
`VERDICT:` line, counts exec calls, and reports non-convergence while it is still
happening. Read the header comment in that file before changing any of it — every rule
is derived from a measured 1h50m/115-exec/no-verdict failure on 2026-07-26.

Exit codes: **3** = contract refusal (fix the invocation), **4** = the run is not a usable
result — a verification pass with no verdict, or a run a guard stopped.

`src/guards.ts` is the second half of the same argument: the contract decides whether a
call may start, the guards decide whether a running call may continue. Read its header
before changing either — it records which guards were deliberately *rejected* and why.

**Stack**: TypeScript, Bun, tmux, OpenAI Codex CLI

**Structure**: Shell wrapper -> CLI entry point -> Job management -> tmux sessions

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).

## Development

```bash
# Run directly
bun run src/cli.ts --help

# Or via shell wrapper
./bin/codex-agent --help

# Health check
bun run src/cli.ts health
```

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI commands and argument parsing |
| `src/contract.ts` | Invocation contract: scope rule, breadth guard, bypass ratchet, verdicts, ledger |
| `src/guards.ts` | Run guards: wall clock, runaway backstop, blocked-prompt kill, reap-when-answered. Pure; applied on every path |
| `src/answer-store.ts` | Durable untruncated answers (`<jobId>.answer.md`), written by the turn hook |
| `src/report.ts` | `codex-agent report`: what was asked, what came back, why it was judged so |
| `src/jobs.ts` | Job lifecycle and persistence |
| `src/tmux.ts` | tmux session management |
| `src/config.ts` | Configuration constants |
| `src/files.ts` | File loading for context injection |
| `src/session-parser.ts` | Parse Codex session files for metadata |
| `plugins/` | Claude Code plugin (marketplace structure) |

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

- **Runtime**: Bun, tmux, codex CLI
- **NPM**: glob (file matching)

## Notes

- Jobs stored in `~/.codex-agent/jobs/`
- Uses `script` command for output logging
- Completion detected via marker string in output
- Bun is the TypeScript runtime - never use npm/yarn/pnpm for running

## Claude Orchestration Pattern (Persisted)

- Prefer `--wait` for any pass that must conclude: it reaps the session as soon as the
  agent has answered, and prints a running cost line meanwhile.
- `codex-agent start "<task>"` without `--wait` is still correct for a conversation you
  intend to continue with `send`. **The bounds apply either way** — see below.
- Track job IDs immediately.
- Use `codex-agent status <id>` to check running/completed state.
- Use `codex-agent capture <id> [n]` for incremental tails while running.
- Use **`codex-agent report <id>`** to read the result: what was asked, the answer
  untruncated, the ledger row, and whether the run is usable. Exit 4 means it is not.
- `codex-agent output <id>` is the raw tmux transcript — for debugging Codex itself, not
  for retrieving an answer.

### The bounds are not tied to `--wait`

This used to be false, and it was the worst defect in the tool. The wall-clock bound, the
runaway backstop and the blocking-prompt kill all lived inside the `--wait` loop in
`cli.ts`, while this very section told callers to start jobs in the background — so the
documented default path had nothing bounding it but a 60-minute log-inactivity check that
only fired if someone happened to call `status`.

They now live in `src/guards.ts` and are applied by `enforceRunGuards`, which
`refreshJobStatus` calls — so every observing command enforces them. A job past its bound
is stopped by whoever next looks at it. A contract that holds on one invocation shape is
not a contract.

### No token ceiling, by decision

Measured over 87 recorded runs on 2026-07-29: the plan pass judged excellent cost 13.7M
tokens (25m, 83 execs); the plan pass judged a catastrophe cost 2.8M. The expensive one was
the good one, so no ceiling separates them. And the field anyone would have built a ceiling
on was ambiguous — `usage.total` for 42 runs, cumulative *input* tokens for 37, reading
4.4x apart on near-identical jobs. The ledger now reports `SPENT` and `CUM-IN` separately
and never substitutes one for the other. Bound the question, not the thinking.

Likewise there is **no zero-exec fail-fast**: `execCount: 0` is the healthy signature of a
scoped pass, because the shaped prompt tells the agent not to read other files.
