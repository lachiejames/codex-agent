# codex-agent

Use OpenAI Codex as a **read-only brain** — planning and adversarial review — while Claude does all the
writing. A private hard fork of `Bootoshi/codex-orchestrator` with an enforced invocation contract, and
with the original's brain/body split reversed.

```bash
# Plan (broad by design — it converges on one artifact)
codex-agent start --pass plan --map "Design the retry strategy for the outbound queue" --wait

# Review one property of a diff (bounded; must reach a verdict)
git diff origin/main...HEAD -- src/queue.ts |
  codex-agent start --pass review --property "no message is delivered twice" --wait
```

## Codex is the brain. Claude is the body.

|          | Codex                                                                                | Claude                                                   |
| -------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Role     | brain                                                                                | body                                                     |
| Access   | **read-only, always**                                                                | full write                                               |
| Good at  | planning a hard problem, stress-testing a plan, finding the subtle defect in a diff   | writing code, running tests, committing, driving the loop |

Every pass profile is read-only and the default sandbox is `read-only`. Write access is something you opt
into with an explicit `-s workspace-write`, never something inferred.

Upstream asserted the opposite — _"Codex agents are the default for ALL execution work"_. Codex has
demonstrated value at exactly two things: producing an excellent plan for a hard problem, and catching a
defect a green test suite missed. It has demonstrated no advantage at typing, and giving a reviewer write
access is all risk and no upside.

## The invocation contract

Every rule below comes from one measured failure. On 2026-07-26 a review packing ~25 checks into one
prompt, with no diff and no wall-clock bound, ran **1h50m across 115 exec calls and produced no verdict**.
It never looped — it made 115 distinct, methodical calls and never converged, reconstructing context from
**9,564 lines of whole files** when the diff was 5,705. Scoped to one property with the diff piped in, the
same question was answered correctly in **51 seconds**.

| run      | scope                  | diff?             | result                  |
| -------- | ---------------------- | ----------------- | ----------------------- |
| planning | one plan               | no                | ~25 min, excellent plan |
| review   | ~25 checks in one call | no                | **1h50m, no verdict**   |
| narrow   | **one property**       | **yes, stdin**    | **51s, correct finding** |

**Do not lower the reasoning effort to make review terminate.** `xhigh` is what caught a genuinely subtle
double-post defect — a `postMessage` under both a client's default ten retries _and_ a four-retry wrapper,
~44 attempts at an irreversible POST. Bound the question, not the thinking.

The CLI refuses violations rather than trusting you to remember:

| exit  | meaning                                     |
| ----- | ------------------------------------------- |
| **3** | contract refusal — fix the invocation       |
| **4** | verification pass produced no verdict       |

1. **Pipe the diff.** A review/verify/audit prompt with nothing on stdin is refused.
2. **One property per call.** Past 3 enumerated checks a review is refused; fan out instead.
3. **Every run has a wall-clock bound**, defaulted per pass.
4. **Answers are word-capped**, which forces a verdict instead of exploration.
5. **A verdict is mandatory and machine-checked** — `VERDICT: CLEAN` or `VERDICT: BROKEN`.

## Pass profiles

| pass          | model       | effort | sandbox   | bound | word cap | needs diff | needs verdict |
| ------------- | ----------- | ------ | --------- | ----- | -------- | ---------- | ------------- |
| `plan`        | gpt-5.6-sol | xhigh  | read-only | 45m   | none     | no         | no            |
| `review`      | gpt-5.6-sol | xhigh  | read-only | 10m   | 300      | yes        | yes           |
| `adversarial` | gpt-5.6-sol | xhigh  | read-only | 20m   | 400      | yes        | yes           |
| `mechanical`  | gpt-5.6-sol | xhigh  | read-only | 5m    | 200      | yes        | yes           |

**Every pass runs `gpt-5.6-sol` at `xhigh`.** `buildCodexArgs` passes `-c model=` and
`-c model_reasoning_effort=` explicitly, which _override_ `~/.codex/config.toml` — so this table, not that
file, is what every launched agent actually runs with. A test asserts it.

## The two shapes

**Three-phase planning** — sequential, broad, converges on one artifact:
`P1 recon` → `P2 design` → `P3 stress-test the plan, not the code`.

**Three-phase review** — parallel, narrow, diff-scoped:
`R1 correctness` | `R2 safety` | `R3 house rules`, one property per call.

Full workflow with copy-paste blocks lives in the `codex-agent` skill; see
[docs/prompts.md](docs/prompts.md) for prompts you can paste into a fresh chat.

## Install

```bash
git clone git@github-personal:lachiejames/codex-agent.git ~/dev/personal/codex-agent
cd ~/dev/personal/codex-agent && bun install
echo 'export PATH="$HOME/dev/personal/codex-agent/bin:$PATH"' >> ~/.zshrc
codex-agent health
```

Requires `tmux`, [Bun](https://bun.sh), the [Codex CLI](https://github.com/openai/codex), and
`codex --login`.

**Trust the directory.** Codex matches project trust by _exact path_, so trusting a parent does not cover a
new checkout. Without this, runs block forever on an interactive prompt with zero exec calls:

```toml
# ~/.codex/config.toml
[projects."/absolute/path/to/repo"]
trust_level = "trusted"
```

There is exactly **one tree**: this repo. `~/.codex-orchestrator` survives only as a compatibility symlink.
Upstream's layout put the CLI and the Claude plugin in two independent clones plus a plugin-cache copy, so
every edit landed in one and not the others.

## The Claude-side skill

An enterprise policy blocks the marketplace route from every source — `dir:`, arbitrary GitHub repos, and
`~/.claude/skills` — enforced at load time, not just on add. `--plugin-dir` still works but is session-only
with no settings key, so a `claude` shell wrapper in `~/.zshrc` supplies it:

```bash
claude() { command claude --plugin-dir "$HOME/dev/personal/codex-agent/plugins/codex-agent" "$@"; }
```

That loads it as a real plugin in every session and every directory — branches and worktrees included.
`--plugin-dir` is additive and repeatable, so passing it again yourself adds to this rather than replacing
it, and `--resume`/`--continue`/subcommands are unaffected.

A shell function does not exist for `claude` invoked from a script or hook, so per-repo **copies** remain as
a fallback:

```bash
bash scripts/sync-skill.sh      # byte-identical copies to every repo in skill-targets.json
bun test                        # fails loudly if a copy has drifted
```

Never edit a copy — edit `plugins/codex-agent/skills/codex-agent/SKILL.md` and re-sync.

## Verify and maintain

```bash
bash scripts/verify-install.sh --all    # one tree, contract, read-only, skills, a real bounded run
bash scripts/cleanup-legacy.sh          # dry run; --delete to apply
codex-agent ledger                      # duration, tokens, execs, scoped, verdict per run
codex-agent clean                       # reap job logs + orphaned tmux sessions
```

The ledger is what makes non-convergence measurable rather than anecdotal. A healthy scoped review looks
like _25s / ~22k tokens / 0 execs / BROKEN_. An unscoped one looks like _341k tokens / 22 execs / NONE_.
Treat any `NONE` as a failed run, not a pass.

## Commands

```
codex-agent start "prompt" [options]   Spawn an agent
codex-agent ledger [--json]            Run ledger
codex-agent status <jobId> [--json]    Job status
codex-agent await-turn <jobId>         Block until the agent finishes a turn
codex-agent send <jobId> "message"     Steer a running agent
codex-agent capture <jobId> [n]        Recent output (--clean strips TUI noise)
codex-agent output <jobId>             Full transcript
codex-agent jobs [--json] [--all]      List jobs
codex-agent kill <jobId>               Stop a job
codex-agent clean                      Reap old jobs + orphaned sessions
codex-agent health                     Check tmux + codex
```

| Flag               | Values                                          | Notes                                    |
| ------------------ | ----------------------------------------------- | ---------------------------------------- |
| `--pass`           | plan, review, mechanical, adversarial           | Sets effort, sandbox, bound, caps        |
| `--property`       | string                                          | The single falsifiable claim to attack   |
| `--timeout`        | minutes                                         | Wall-clock bound                         |
| `--allow-unscoped` | flag                                            | Permit a verification pass with no stdin |
| `--max-checks`     | n                                               | Override the enumerated-check limit      |
| `--word-cap`       | n                                               | Override the answer cap (0 disables)     |
| `--no-contract`    | flag                                            | Disable enforcement (escape hatch)       |
| `-s`, `--sandbox`  | read-only, workspace-write, danger-full-access  | Default `read-only`                      |
| `-r`, `--reasoning`| low, medium, high, xhigh                        | Overrides the profile                    |
| `--map`            | flag                                            | Include `docs/CODEBASE_MAP.md`           |
| `-w`, `--wait`     | flag                                            | Apply the bound; return on verdict       |
| `--dry-run`        | flag                                            | Show the shaped prompt without executing |

There is no `-f`/`--file` flag — it was removed upstream. **stdin is the scope channel.**

## How it works

Each job runs `codex` inside its own tmux session, wrapped in `script` so the full transcript is captured to
`~/.codex-agent/jobs/<id>.log`. A per-job notify hook writes a signal file on turn completion. Job state
lives in `<id>.json`; metrics are read back from the Codex session transcript under `~/.codex/sessions/`,
located by working directory, time window, and prompt content — Codex 0.145.0 never prints a session id, so
the id-based lookup upstream relied on always failed silently.

Architecture: [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).

## License

MIT. `Copyright (c) 2025 Bootoshi` is retained as the original licence requires; fork changes are
`Copyright (c) 2026 Lachie James`. See [LICENSE](LICENSE).
