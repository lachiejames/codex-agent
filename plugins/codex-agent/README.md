# codex-agent — Claude Code plugin

Gives Claude a **read-only second brain**: Codex plans and reviews, Claude writes.

## What it does

- **Three-phase planning** (`P1 recon` → `P2 design` → `P3 stress-test the plan`) — broad by design,
  because planning converges on a single artifact.
- **Three-phase review** (`R1 correctness` | `R2 safety` | `R3 house rules`) — narrow, parallel and
  diff-scoped, one falsifiable property per call, each ending in `VERDICT: CLEAN` or `VERDICT: BROKEN`.
- **An enforced invocation contract** that refuses the shapes which do not converge, rather than trusting
  you to remember them.
- **A run ledger** — duration, tokens, exec count, whether scope was supplied, whether a verdict was
  produced — so non-convergence is measurable rather than anecdotal.

Codex never edits anything. Every pass is `read-only`; write access requires an explicit
`-s workspace-write`. Claude makes all the changes.

## Installation

An enterprise policy on this machine blocks plugin marketplaces from every source — local directory,
GitHub, and `~/.claude/skills` — enforced at load time, not just on add. So it loads from disk instead,
via a `claude()` wrapper in `~/.zshrc`:

```bash
claude() { command claude --plugin-dir "$HOME/dev/personal/codex-agent/plugins/codex-agent" "$@"; }
```

`--plugin-dir` is additive and repeatable, so passing it yourself adds to this. That covers every
directory, so there are no per-repo copies to keep in sync.

The CLI itself is independent of all of that:

```bash
cd ~/dev/personal/codex-agent && bun install
echo 'export PATH="$HOME/dev/personal/codex-agent/bin:$PATH"' >> ~/.zshrc
codex-agent health
```

Requires `tmux`, Bun, the OpenAI Codex CLI, and `codex --login`. Also add a trust entry for each repo you
run in — Codex matches project trust by **exact path**, so trusting a parent does not cover a new checkout,
and without it runs block forever on a prompt with zero exec calls:

```toml
# ~/.codex/config.toml
[projects."/absolute/path/to/repo"]
trust_level = "trusted"
```

## Usage

```bash
# Plan — the prompt is a positional; --map and --wait are bare flags taking no value
codex-agent start --pass plan "Design the retry strategy" --map --wait

# Stress-test the plan before writing any of it — the highest-value phase
codex-agent start --pass adversarial --allow-unscoped --wait \
  --property "This plan survives contact with production: <plan>"

# Review: one property per call, diff on stdin, in parallel
git diff origin/main...HEAD -- src/ > /tmp/review.diff
for p in "no value is dropped on the error path" "no request escapes authorization"; do
  codex-agent start --pass review --property "$p" --wait < /tmp/review.diff &
done; wait

codex-agent ledger   # any NONE verdict is a failed run, not a pass
```

Exit codes: **3** = contract refusal (fix the invocation), **4** = no verdict produced.

Every pass runs `gpt-5.6-sol` at `xhigh`. Full rationale and the measured evidence behind each rule are in
the skill and in the repo README.

## License

MIT. `Copyright (c) 2025 Bootoshi` is retained as the original licence requires; fork changes are
`Copyright (c) 2026 Lachie James`.
