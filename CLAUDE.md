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

Exit codes: **3** = contract refusal (fix the invocation), **4** = verification pass
produced no verdict.

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
| `src/contract.ts` | Invocation contract: scope rule, breadth guard, bounds, verdicts, ledger |
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

- Use `codex-agent start "<task>"` without `--wait` for background orchestration.
- Track job IDs immediately.
- Use `codex-agent status <id>` to check running/completed state.
- Use `codex-agent capture <id> [n]` for incremental tails while running.
- Use `codex-agent output <id>` for final transcript after completion.
