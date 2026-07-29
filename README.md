# codex-agent

Use OpenAI Codex as a **read-only brain** — planning and adversarial review — while Claude does all the
writing. A private hard fork of `Bootoshi/codex-orchestrator` with an enforced invocation contract, and
with the original's brain/body split reversed.

```bash
# Plan (broad by design — it converges on one artifact)
# The prompt is a positional; --map and --wait are bare flags that consume nothing.
codex-agent start --pass plan "Design the retry strategy for the outbound queue" \
  --timeout 45 --map --wait

# Review one property of a diff (scoped; must reach a verdict)
git diff origin/main...HEAD -- src/queue.ts |
  codex-agent start --pass review --property "no message is delivered twice" --timeout 10 --wait
```

`--timeout <minutes>` is **required on every launch** and has no default anywhere. Omitting it
is a contract refusal, exit 3.

## Codex is the brain. Claude is the body.

|         | Codex                                                                               | Claude                                                    |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Role    | brain                                                                               | body                                                      |
| Access  | **read-only, always**                                                               | full write                                                |
| Good at | planning a hard problem, stress-testing a plan, finding the subtle defect in a diff | writing code, running tests, committing, driving the loop |

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

| run      | scope                  | diff?          | result                   |
| -------- | ---------------------- | -------------- | ------------------------ |
| planning | one plan               | no             | ~25 min, excellent plan  |
| review   | ~25 checks in one call | no             | **1h50m, no verdict**    |
| narrow   | **one property**       | **yes, stdin** | **51s, correct finding** |

**Do not lower the reasoning effort to make review terminate.** `xhigh` is what caught a genuinely subtle
double-post defect — a `postMessage` under both a client's default ten retries _and_ a four-retry wrapper,
~44 attempts at an irreversible POST. Bound the question, not the thinking.

The CLI refuses violations rather than trusting you to remember:

| exit  | meaning                                                                             |
| ----- | ----------------------------------------------------------------------------------- |
| **3** | contract refusal — fix the invocation                                               |
| **4** | not a usable result — a verification pass with no verdict, or a run a bound stopped |

1. **Pipe the diff.** A review/verify/audit prompt with nothing on stdin is refused.
2. **One property per call.** Past 3 enumerated checks a review is refused; fan out instead.
3. **`--timeout <minutes>` is required**, on every launch, with no default anywhere.
4. **Answers are word-capped**, which forces a verdict instead of exploration.
5. **A verdict is mandatory and machine-checked** — `VERDICT: CLEAN` or `VERDICT: BROKEN`.
6. **Bypasses are ratcheted and recorded.** `--allow-unscoped` needs an explicit `--pass` and the
   subject inline (≥200 chars); `--no-contract` is recorded too. Both show in the ledger.

## The bound is yours to state, and it warns before it kills

`--timeout` has no default because a default a machine caller inherits silently is not a bound, it is a
habit. Callers forget defaults exist, and then a 10-minute review of a small diff and a 60-minute deep
adversarial pass run under the same accidental number. Every per-pass profile timeout and both config
defaults were deleted.

It bounds **one turn of thinking**, not the life of a conversation.

At **85%** of the bound the supervisor interrupts the agent and resumes it asking for a conclusion with
what it already has; only then is the bound fatal. Kill-at-bound made every timeout a gamble — too tight
and a good run is shot seconds from its verdict, too loose and a stray run burns an hour. Verified live: a
4-minute-bounded run at 18 exec calls was interrupted, resumed, and produced `VERDICT: CLEAN` instead of
dying with nothing. The warn does not extend the deadline: a 10-minute bound is still 10 minutes.

## Pass profiles

| pass          | model       | effort | sandbox   | word cap | max checks | needs diff | needs verdict |
| ------------- | ----------- | ------ | --------- | -------- | ---------- | ---------- | ------------- |
| `plan`        | gpt-5.6-sol | xhigh  | read-only | none     | ∞          | no         | no            |
| `review`      | gpt-5.6-sol | xhigh  | read-only | 300      | 3          | yes        | yes           |
| `adversarial` | gpt-5.6-sol | xhigh  | read-only | 400      | 1          | yes        | yes           |
| `mechanical`  | gpt-5.6-sol | xhigh  | read-only | 200      | 10         | yes        | yes           |

No profile carries a timeout. That column existed and was deleted, because a bound nobody chose is how the
tool ended up with one nobody could defend.

**Every pass runs `gpt-5.6-sol` at `xhigh`.** `buildCodexArgv` passes `-c model=` and
`-c model_reasoning_effort=` explicitly, which _override_ `~/.codex/config.toml` — so this table, not that
file, is what every launched agent actually runs with. A test asserts it. The sandbox travels the same way,
as `-c sandbox_mode=`, because `codex exec resume` rejects `--sandbox` outright and dropping the flag there
would silently give a resumed review pass write access.

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

Requires [Bun](https://bun.sh), the [Codex CLI](https://github.com/openai/codex), and `codex --login`.
**tmux is no longer a dependency** — it was the previous transport.

**Trust the directory.** Codex matches project trust by _exact path_, so trusting a parent does not cover a
new checkout. An untrusted directory now fails in about 4 seconds with `Not inside a trusted directory` on
the run record; under the old transport the same condition sat on an interactive prompt and burned the
whole bound in silence.

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

There is deliberately **no second copy**. One skill, one file, one door — a byte-identical duplicate is
still a second skill Claude has to choose between, and it needs machinery to stay honest.

## Verify and maintain

```bash
bash scripts/verify-install.sh --all    # one tree, contract, read-only, skills, a real bounded run
codex-agent ledger                      # duration, SPENT, CUM-IN, execs, scoped, bypass, outcome
codex-agent clean                       # delete runs older than 7 days, and say how much that freed
```

The ledger is what makes non-convergence measurable rather than anecdotal. A healthy scoped review looks
like _25s / ~22k spent / 0 execs / BROKEN_ — note that **0 execs is health**, not spinning: the shaped
prompt tells the agent not to read other files. Treat any `NONE` on a verification pass as a failed run.

`SPENT` and `CUM-IN` are two different quantities, both read off `turn.completed.usage` in the event
stream. `SPENT` is input + output summed across completed turns; `CUM-IN` is cumulative _input_ only, which
excludes output and re-counts context every turn. Either reads `-` when Codex reported no usage, and `-`
means not measured, never zero. They were one column until they were caught reporting the same run as 253k
and 1.1M, so never substitute one for the other.

`clean` **deletes**. The old version moved artifacts to `jobs/.trash/` for recoverability and nothing ever
emptied it: 699 MB across 964 files, while `clean` reported jobs "cleaned" and freed nothing at all.
Recoverability nobody expires is a leak with a nicer name, and a week is long enough to have read the
report.

## Commands

```
codex-agent start "prompt" --timeout <min>   Start a run (--timeout is REQUIRED)
codex-agent report <runId> [--json]          Asked / answered / judged — how to read a result
codex-agent ledger [--json] [--all]          Run ledger
codex-agent status <runId> [--json]          What it is doing right now
codex-agent await <runId> [--json]           Block until the turn concludes (alias: await-turn)
codex-agent send <runId> "message"           Interrupt and steer, or resume an idle run
codex-agent tail <runId> [n]                 Recent raw JSONL events (alias: capture)
codex-agent runs [--json] [--all]            List runs (alias: jobs)
codex-agent kill <runId>                     Stop a run and its supervisor
codex-agent clean                            Delete runs older than 7 days
codex-agent health                           Check codex
```

`attach`, `watch`, `sessions`, `output` and `delete` went with the tmux transport, as did the
`--strip-ansi`/`--clean` flags — there is no pane left to clean. An unknown subcommand is now an error; it
used to fall through and be launched as a prompt, so `codex-agent repot abc123` spawned a real Codex run.

`report` is the one to reach for. The answer comes from the file Codex itself writes via
`--output-last-message`, so it survives the process being gone, and it exits **4** when the run is not a
usable result. `tail` is the raw event stream — for watching a run or diagnosing Codex, never for
retrieving an answer.

| Flag               | Values                                         | Notes                                                                                               |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--timeout`        | minutes                                        | **Required, no default.** Bounds one turn of thinking; omitting it is exit 3                        |
| `--pass`           | plan, review, mechanical, adversarial          | Sets effort, sandbox, word cap, check limit                                                         |
| `--property`       | string                                         | The single falsifiable claim to attack                                                              |
| `--allow-unscoped` | flag                                           | No stdin, by exception: needs explicit `--pass` + inline subject (≥200 chars); recorded as a bypass |
| `--max-checks`     | n                                              | Override the enumerated-check limit                                                                 |
| `--word-cap`       | n                                              | Override the answer cap (0 disables)                                                                |
| `--no-contract`    | flag                                           | Disable enforcement; recorded as a bypass                                                           |
| `-s`, `--sandbox`  | read-only, workspace-write, danger-full-access | Default `read-only`                                                                                 |
| `-d`, `--dir`      | path                                           | Working directory (default: cwd)                                                                    |
| `--map`            | flag (takes no value)                          | Include the codebase map; prints the resolved path                                                  |
| `-w`, `--wait`     | flag                                           | Return once the turn concludes, printing a cost line. The bound applies either way                  |
| `--dry-run`        | flag                                           | Show the shaped prompt and the decision without executing                                           |

There is no `-f`/`--file` flag — it was removed upstream. **stdin is the scope channel.**

## How it works

A **run** is one Codex thread driven by N successive `codex exec --json` processes. A detached supervisor
process owns it for its whole life:

- `codex exec --json` emits a **typed JSONL event per line** into `<id>.jsonl`, which the supervisor folds
  incrementally into exec count, token totals, turn counts and a liveness counter. There is no terminal to
  scrape, so the three modules that existed only to reverse-engineer one — a session-file parser, a
  `script(1)` log regex, and 187 lines of guessing which terminal glyphs were noise — are all gone.
- The answer of record is **`--output-last-message`**, the file Codex itself writes. Event-stream items can
  change shape between versions; that file is Codex's own contract for "this is the final answer". It is
  copied into `<id>.answer.md`, untruncated, one block per concluded turn.
- Turns are continued with **`codex exec resume <threadId>`**. That is what makes `send` interrupt an
  in-flight turn and resume carrying your message, deterministically, at a boundary the supervisor chooses
  — and everything already completed is preserved: verified, a turn killed after 3 of 10 tool calls resumed
  and correctly reported all three results. The old transport typed into a TUI input box, so a message
  landed mid-turn or at the next turn depending on how much work remained, a race nobody could see.
- Exactly **one Codex process per thread** at a time, which is what keeps the event stream and the answer
  file single-writer.
- A **failure to start is fast and loud.** Codex exits non-zero in about a second with the reason on
  stderr, and the supervisor records it the moment it happens — including skipping the two known benign
  progress lines, because the first line of an untrusted-directory failure is
  `Reading additional input from stdin...` and reporting that as the cause sends you after the wrong
  problem.

The bound decision lives in `src/bounds.ts` as one pure function with two enforcers: the supervisor, which
can warn as well as kill, and every observing command, which re-derives the run from its files and kills one
whose supervisor died holding it open. It is not tied to `--wait`. Leaving a run unbounded on one path is
this repo's original sin and the new design does not get to reintroduce it.

Architecture: [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md). Behaviours: [docs/SPEC.md](docs/SPEC.md).

## License

MIT. `Copyright (c) 2025 Bootoshi` is retained as the original licence requires; fork changes are
`Copyright (c) 2026 Lachie James`. See [LICENSE](LICENSE).
