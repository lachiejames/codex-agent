---
name: codex-agent
description: Use Codex as a read-only brain — three-phase planning and three-phase adversarial review — while Claude does all the writing. Trigger when planning non-trivial work, when a plan needs stress-testing before implementation, or when a diff needs reviewing before it ships. Also on "codex", "spawn codex", "plan this with codex", "review this with codex", "codex-agent", "init codex".
triggers:
  - codex-agent
  - codex-orchestrator
  - spawn codex
  - use codex
  - plan with codex
  - review with codex
  - codex plan
  - codex review
  - stress-test the plan
  - init codex
  - setup codex
---

<!--
  SOURCE OF TRUTH: lachiejames/codex-agent
    plugins/codex-agent/skills/codex-agent/SKILL.md

  THE ONE DOOR. This file is the only place Codex invocation is taught. It loads as a real
  Claude Code plugin via a `claude()` wrapper in ~/.zshrc passing --plugin-dir, which works
  in every directory — branches and worktrees included.

  There is deliberately NO second copy anywhere. Per-repo copies used to exist as a
  "fallback" for `claude` invoked from a script or hook; that scenario was never real, and a
  byte-identical duplicate still shows up as a SECOND skill Claude has to choose between.
-->

# codex-agent

## Codex is the brain. Claude is the body.

**Codex thinks. Claude does.** That division is the whole design, and it is not
negotiable — every pass profile is read-only and the default sandbox is `read-only`.

|         | Codex                                                                               | Claude (you)                                                             |
| ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Role    | brain                                                                               | body                                                                     |
| Access  | **read-only, always**                                                               | full write                                                               |
| Good at | planning a hard problem, stress-testing a plan, finding the subtle defect in a diff | writing code, editing files, running tests, committing, driving the loop |
| Gets    | a bounded question                                                                  | the whole job                                                            |

**You are in control.** Codex is an instrument you point at a question. It hands back a
plan or a verdict; you decide what to do with it and you make every edit yourself.

Why this way round: Codex has demonstrated real value at exactly two things — producing
an excellent plan for a hard problem, and catching a defect a green test suite missed.
It has demonstrated no advantage at typing. Giving a reviewer write access is all risk
and no upside.

### What NOT to do

- **Do not ask Codex to implement anything.** If you catch yourself writing "implement",
  "fix", "add", or "refactor" in a Codex prompt, stop — that is your job.
- **Do not give Codex `-s workspace-write`** unless the user explicitly asks for it.
- **Do not skip Codex for hard problems.** Planning and review are where it earns its
  cost. Skipping it on a gnarly change is the mistake in the other direction.
- **Do not use Codex for trivia.** A one-line change does not need a planning phase.

---

## THE INVOCATION CONTRACT (READ BEFORE WRITING ANY REVIEW PROMPT)

This exists because of a measured failure, and it overrides anything below that
contradicts it.

On 2026-07-26 a single review call packed ~25 checks into one prompt, supplied no diff,
and had no wall-clock bound. It ran **1h50m across 115 exec calls and produced no
verdict** before being killed. It never looped — it made 115 distinct, methodical calls
and simply never converged. It reconstructed context with 50 `nl -ba` and 64 `sed -n`
reads over **9,564 lines of whole files**, when the diff was **5,705**.

The same model at the same effort had produced an excellent planning report 25 minutes
earlier. A third call, narrowed to one property with the diff piped in, answered the
same question correctly in **51 seconds**.

| run      | scope                  | diff supplied?    | result                                |
| -------- | ---------------------- | ----------------- | ------------------------------------- |
| planning | one plan               | no                | 100 execs, ~25 min, excellent verdict |
| review   | ~25 checks in one call | no                | 115 execs, **1h50m, no verdict**      |
| narrow   | **one property**       | **yes, on stdin** | **51s, correct finding**              |

**Do NOT lower the reasoning effort to fix this.** `xhigh` is what caught a genuinely
subtle double-post defect — a `postMessage` running under both a client's default ten
retries _and_ a four-retry wrapper, ~44 attempts at an irreversible POST. Lowering
effort to make review terminate trades away the exact capability being paid for.
**Bound the question, not the thinking.**

Verification is N independent investigations with no natural stopping point. Planning
converges on a single artifact. That is the whole difference, and it is why planning is
allowed to be broad and review is not.

### The rules, enforced by the CLI

The CLI refuses violations rather than trusting you to remember:

| exit  | meaning                                                        | what to do                                          |
| ----- | -------------------------------------------------------------- | --------------------------------------------------- |
| **3** | contract refusal                                               | fix the invocation; do not work around it           |
| **4** | run is not a usable result (no verdict, or a bound stopped it) | narrow the property; do not raise the timeout first |

1. **Pipe the diff.** A review/verify/audit prompt with nothing on stdin is refused.
2. **One property per call.** Past 3 enumerated checks a review is refused; fan out.
3. **`--timeout <minutes>` is required on every launch and has no default.** Omitting it is
   a refusal, exit 3. See below — this is the rule you will trip over first.
4. **Answers are word-capped**, which forces a verdict instead of exploration.
5. **A verdict is mandatory and machine-checked** — `VERDICT: CLEAN` or `VERDICT: BROKEN`.
6. **Bypasses are narrow and recorded.** `--allow-unscoped` needs an explicit `--pass` and
   the subject supplied inline (≥200 characters); `--no-contract` is logged too. Both show
   in `codex-agent ledger` under `BYPASS`.

### `--timeout` is required. There is no default anywhere

```bash
codex-agent start --pass plan "Design the retry strategy" --timeout 45 --map --wait
#                                                          ^^^^^^^^^^^^ without this: exit 3
```

A default that a machine caller inherits silently is not a bound, it is a habit. Callers
forget defaults exist, and then a 10-minute review of a small diff and a 60-minute deep
adversarial pass run under the same accidental number. Only you know which this is, so you
state it. Every per-pass default and both config defaults were deleted; there is nothing to
fall back to.

**The bound covers ONE turn of thinking, not the life of the conversation.** Pick a number
generous enough to finish, not a defensive one:

| shape                          | `--timeout` |
| ------------------------------ | ----------- |
| mechanical/house-rule check    | 5           |
| narrow review of a small diff  | 10          |
| deep adversarial pass          | 20          |
| planning a large chunk of work | 45–60       |

The bound you set at launch is also the bound for every later turn on that thread, including
ones you start with `send`.

**A nearly-finished good run is not shot.** At 85% of the bound the agent is interrupted and
resumed with "you have N left, stop investigating, answer with what you have, end with a
VERDICT line". Only if that fails is the bound fatal. Verified: a 4-minute-bounded run at 18
exec calls was interrupted, resumed, and produced `VERDICT: CLEAN` instead of dying with
nothing. So a slightly-too-tight timeout costs depth, not the whole run — and the warn does
not extend the deadline, so a 10-minute bound is still 10 minutes.

### What is deliberately NOT enforced

**There is no token ceiling, and adding one would be wrong.** Measured over 87 recorded
runs: the plan pass judged excellent cost 13.7M tokens over 25 minutes with 83 exec calls;
the plan pass judged a catastrophe cost 2.8M. The expensive run was the good one, so no
ceiling separates them. Bound the _question_, not the spend.

**There is no zero-exec fail-fast.** `execCount: 0` is the _healthy_ signature for a scoped
pass — the shaped prompt says "Do not read other files", so the golden 51-second review
made zero exec calls and answered correctly. A guard on that would kill the best runs.

The runaway backstop that does exist requires the event stream, the token count **and** the
turn count to be flat simultaneously for 10 minutes. It is a hang detector, not a budget: a
run still emitting events is never stopped by it, however expensive.

### Pass profiles

| pass          | effort | sandbox   | word cap | max checks | needs diff | needs verdict |
| ------------- | ------ | --------- | -------- | ---------- | ---------- | ------------- |
| `plan`        | xhigh  | read-only | none     | ∞          | no         | no            |
| `review`      | xhigh  | read-only | 300      | 3          | yes        | yes           |
| `adversarial` | xhigh  | read-only | 400      | 1          | yes        | yes           |
| `mechanical`  | xhigh  | read-only | 200      | 10         | yes        | yes           |

**No profile carries a timeout.** It used to, which is exactly how the bound became something
nobody chose. You pass `--timeout` on every call.

**Every pass runs `gpt-5.6-sol` at `xhigh`.** The model and effort are passed as `-c model=`
and `-c model_reasoning_effort=`, which _override_ `~/.codex/config.toml` — so `src/config.ts`
and this table, not that file, are what actually reaches Codex. Lower it per call with `-r` if
you ever need to: visibly, never silently.

---

## The pipeline

```
        ┌─────────── CODEX (brain, read-only) ───────────┐
USER ──▶│  P1 recon  →  P2 design  →  P3 stress-test     │──▶ plan
        └────────────────────────────────────────────────┘
                              │
                    CLAUDE (body) implements
                              │
        ┌─────────── CODEX (brain, read-only) ───────────┐
        │  R1 correctness │ R2 safety │ R3 house rules   │──▶ verdicts
        └────────────────────────────────────────────────┘
                              │
                    CLAUDE (body) fixes, tests, commits
```

Codex owns P1–P3 and R1–R3. You own everything between and after.

---

## Three-phase planning (Codex, read-only)

Planning is the one place Codex is allowed to be broad, because it converges on a single
artifact. Run the phases in sequence — each takes the previous one's output.

### P1 — Recon: what is actually there?

```bash
codex-agent start --pass plan \
  "Map how <subsystem> works today. Cover: entry points, data flow, where state lives,
   what already handles the concern I am about to change, and what would break if it
   changed. Do not propose solutions yet." \
  --timeout 45 --map --wait
```

The prompt is a **positional argument**. `--map` and `--wait` are bare booleans that consume
nothing, so keep them after the prompt — writing `--map "<prompt>"` also works, but it reads
as though `--map` takes the prompt as its value, and that misreading is how map injection got
switched on by accident in places nobody intended. `--timeout` **does** take a value.

Read the output. **You** decide what is true and what the agent misread.

### P2 — Design: what should we do?

Feed P1's findings back in. Ask for one recommended approach plus the alternatives it
rejected and why — a design with no discarded options has not been thought about.

```bash
codex-agent start --pass plan \
  "Given this recon: <paste P1 conclusions>

   Design the change to <goal>. Give ONE recommended approach, then the alternatives you
   rejected and why. Call out every assumption that, if wrong, changes the answer." \
  --timeout 45 --map --wait
```

### P3 — Stress-test: how does this plan fail?

The highest-value phase and the one most often skipped. Point Codex at your _plan_, not
your code, and tell it to break it.

```bash
codex-agent start --pass adversarial --allow-unscoped \
  --property "This plan survives contact with production: <paste the plan>" \
  --timeout 20 --wait
```

`--allow-unscoped` is correct here — the subject is a plan you are supplying inline, not
a diff. This is the one legitimate use of that flag, and the CLI now enforces exactly that
shape: an explicit `--pass` plus a real inline subject. Pasting the actual plan is what
makes it pass; `--property "stress-test my plan"` is refused with exit 3.

Then **you** write the plan up (`docs/prds/<name>.md` if the repo uses that), get the
user's agreement, and **you** implement it.

---

## Three-phase review (Codex, read-only, diff-scoped)

Now invert the shape completely. Reviews are **narrow, parallel, and diff-scoped**.

Capture the scope once:

```bash
git diff origin/main...HEAD -- src/ > /tmp/review.diff
```

Then run the three phases. Every property must be **falsifiable by a concrete input** —
"review for data integrity" is not; "no migration is destructive to existing rows" is.

### R1 — Correctness: does it do the thing?

```bash
for p in \
  "no value is silently dropped on the error path" \
  "the retry cannot deliver the same message twice" \
  "concurrent callers cannot observe a partially-written record" \
; do
  codex-agent start --pass review --property "$p" --timeout 10 --wait < /tmp/review.diff &
done; wait
```

### R2 — Safety: what can an adversary or an accident do?

Use `--pass adversarial` — it is narrowed to exactly one property and gets the longest
leash of any scoped pass.

```bash
for p in \
  "no user input reaches a query without parameterisation" \
  "no code path bypasses the authorization check" \
  "no irreversible side effect can run more than once" \
; do
  codex-agent start --pass adversarial --property "$p" --timeout 20 --wait < /tmp/review.diff &
done; wait
```

### R3 — House rules: does it match this repo?

Mechanical pattern-matching. Still `xhigh` — a pass that silently thinks less than every
other pass is a footgun, and these checks are cheap because the diff is small, not because
the model is weaker.

```bash
for p in \
  "every new exported function has an explicit return type" \
  "no test asserts on a truthy value instead of an exact one" \
  "no absolute home path appears in any committed file" \
; do
  codex-agent start --pass mechanical --property "$p" --timeout 5 --wait < /tmp/review.diff &
done; wait
```

### After the reviews

```bash
codex-agent ledger
```

- Treat any `NONE` verdict as a **failed run**, not a pass.
- A large exec count with no verdict means the **property was too broad**. Narrow it; do not
  raise the timeout first.
- `killed:wall_clock` means the warn at 85% also failed to get a conclusion out of it. Same
  remedy: narrow the question.
- `killed:stalled` is different — it hung. Read `codex-agent tail <id>` and the run's
  `.stderr`, then re-run.
- A run that could not start does not sit there silently any more; it fails in seconds with
  the real reason on the record. `codex-agent report <id>` prints it.
- Then **you** fix what is real, discount what is not, and say which is which.

Filtering matters. Codex will sometimes flag a real defect, sometimes over-engineer, and
sometimes misread the codebase. Reporting its output verbatim is not review — judging it
is. When it contradicts itself, investigate rather than picking a side.

---

## The codebase map

`--map` injects a codebase map if present, which is worth it for **planning** passes. It is
not a substitute for a diff on review passes — that substitution is exactly what the 1h50m
run did.

It looks for these, **case-insensitively**, and takes the first that exists:

1. `docs/CODEBASE_MAP.md`
2. `CODEBASE_MAP.md`

`docs/ARCHITECTURE.md` used to be a third fallback and is **gone**. A repo with no map but
any architecture document had that document — a different artifact, written for a different
audience, at whatever token cost it happened to carry — silently injected into every planning
prompt. `--map` now means the codebase map or nothing.

**The CLI prints which file it resolved**, with its size, plus a warning if another file
differs from it only by case. Read that line. The lookup used to report a path that did not
exist: it asked for `docs/ARCHITECTURE.md`, macOS opened `docs/architecture.md`, and the same
command on Linux injected nothing at all — silently either way.

```
Included codebase map: /repo/docs/CODEBASE_MAP.md (~5,727 tokens, 23,223 bytes)
No codebase map found under /repo (looked for docs/CODEBASE_MAP.md, CODEBASE_MAP.md)
```

Because the map is injected **verbatim**, a stale map is worse than no map: it actively
misleads the pass you are paying most for. Check the reported byte count against what you
expect before trusting a plan built on it.

**You generate the map** — it is body work, no separate tool needed:

> Read the repo structure and write `docs/CODEBASE_MAP.md`: per-directory purpose, the
> key modules and what each owns, data flow between them, external dependencies, and a
> "where do I change X" navigation section. Add a `last_mapped` timestamp. Refresh only
> the sections whose files changed since that timestamp.

Regenerate it when the architecture moves, not on every change.

---

## Driving the loop

### Standard cycle

**1. Spawn** (returns a run ID immediately)

```bash
codex-agent start --pass plan "..." --timeout 45 --map
```

A supervisor process takes ownership of the run for its whole life, so a pass that cannot
start says so in seconds rather than burning its bound in silence. An untrusted directory now
fails in **4 seconds** with the real reason on the record.

**2. Wait.** For anything that must conclude, prefer `--wait`. It returns the moment the turn
concludes and prints a running cost line every 20 seconds meanwhile.

For a conversation you intend to continue, use `await` (alias `await-turn`) in a background
Bash task:

```bash
codex-agent await "$RUN_ID"
codex-agent status "$RUN_ID"
```

**The bound applies either way.** It lives in `src/bounds.ts` as one pure function with two
enforcers: the supervisor, which can warn as well as kill, and every observing command
(`status`, `await`, `report`, `runs`, `ledger`), which re-derives the run from its files and
kills a run whose supervisor died holding it open. There is no invocation shape with nothing
bounding it — a contract that holds on one shape is not a contract.

**3. React.** Follow up with `send`. There is nothing to close: when a turn concludes the
Codex process exits and the run sits in `waiting`, resumable but costing nothing. `clean`
deletes runs after a week.

```bash
codex-agent send "$RUN_ID" "You concluded X. Now check whether Y still holds under it."
```

`send` **interrupts the in-flight turn and resumes the thread carrying your message**, which
makes steering deterministic — it happens at a boundary the supervisor chooses. Everything the
agent already completed is preserved across the interrupt: verified, a turn killed after 3 of
10 tool calls resumed and correctly reported all three results. A steer is treated as a new
question, so it starts a new turn with a fresh copy of the same bound.

**4. Read the result with `report`.**

```bash
codex-agent report "$RUN_ID"
```

`report` prints what was asked, the agent's answer **untruncated**, the ledger row, and a
judgement of whether the run is usable. The answer comes from the file Codex itself wrote via
`--output-last-message`, so it survives the process being gone, and it exits **4** when the
run is not a usable result.

`codex-agent tail` is the raw JSONL event stream — one typed event per line, including full
command output. It is for watching what a run is doing or diagnosing a Codex-side failure,
never for retrieving an answer.

### Parallelism

Spawn all agents in one message (multiple Bash calls), then await them all in one
message with `run_in_background: true`. Each notifies you independently.

The properties in R1–R3 are independent by construction, which is what makes them
parallelisable — and is the same reason they must not share a call.

### Patience, correctly scoped

A **planning** pass legitimately takes 10–40 minutes. Let it run.

A **review** pass should conclude in seconds to a couple of minutes. If it has not, it
is not being thorough — it is unscoped. Check the ledger rather than waiting.

### When an agent seems stuck

```bash
codex-agent status <runId>          # status, elapsed, execs, spend, last command, warned?
codex-agent tail <runId> 40         # the last 40 raw events
codex-agent send <runId> "..."      # interrupt and steer it
codex-agent kill <runId>            # last resort
```

`status` tells you what it is doing right now — the last command it ran, whether it has been
warned, and whether its supervisor is still alive. A `running` run whose supervisor reads
`(gone)` is unowned: the command you just ran will stop it if it is past its bound, and leave
it alone if it is not, in case the supervisor is mid-restart.

A run that never started is now a **fast, loud failure** rather than a silent stall: Codex
exits non-zero in about a second and the reason is captured on the run record. Directory trust
is still matched by **exact path**, so trusting a parent does not cover a new repo — but the
symptom is now `Not inside a trusted directory` in `codex-agent report`, in seconds, instead of
a run sitting on a prompt burning its whole bound.

```toml
# ~/.codex/config.toml
[projects."/absolute/path/to/repo"]
trust_level = "trusted"
```

---

## Prerequisites

`Bun`, the OpenAI Codex CLI, and `codex --login`. **tmux is not used and is not required** —
the transport is `codex exec --json`, one process per turn.

```bash
codex-agent health
```

If `codex-agent` is missing, run the installer:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
# or, without a plugin root:
bash ~/dev/personal/codex-agent/plugins/codex-agent/scripts/install.sh
```

Model and effort come from `src/config.ts` (`gpt-5.6-sol`, `xhigh`) and are passed as `-c`
overrides, so they beat `~/.codex/config.toml` and `-m`/`-r` are almost never needed.

---

## CLI reference

```bash
codex-agent start "prompt" --timeout <min> [options]   # --timeout is REQUIRED
codex-agent report <runId> [--json]      # asked / answered / judged — read this one
codex-agent ledger [--json] [--all]      # duration, SPENT, CUM-IN, execs, scoped, bypass, outcome
codex-agent status <runId> [--json]      # what it is doing right now
codex-agent await <runId> [--json]       # block until the turn concludes (alias: await-turn)
codex-agent send <runId> "message"       # interrupt and steer, or resume an idle run
codex-agent tail <runId> [lines]         # raw JSONL events, default 40 (alias: capture)
codex-agent runs [--json] [--all]        # list runs (alias: jobs)
codex-agent kill <runId>                 # stop the run and its supervisor
codex-agent clean                        # delete runs older than 7 days
codex-agent health                       # codex --version
```

**These commands no longer exist**: `attach`, `watch`, `sessions`, `output`, `delete`, and the
`--strip-ansi`/`--clean` flags. There is no pane to attach to and none to clean. An unknown
subcommand is now an **error** (exit 1) — it used to fall through and be launched as a prompt,
so a typo like `codex-agent repot abc123` spawned a real Codex run and cost money.

The ledger has **two** token columns and they are not interchangeable:

| column   | meaning                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- |
| `SPENT`  | input + output, summed over completed turns. `-` means Codex never reported usage.          |
| `CUM-IN` | cumulative _input_ tokens only — excludes output, re-counts context every turn. Not a cost. |

They used to be one column fed by whichever was available, which is why the same run could
appear to cost 253k or 1.1M. If you need a cost, read `SPENT` and treat `-` as unknown — never
substitute `CUM-IN` for it.

| Flag               | Values                                         | Description                                                                                                           |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--timeout`        | minutes                                        | **REQUIRED, no default.** Bounds one turn of thinking. Omitting it is exit 3                                          |
| `--pass`           | plan, review, mechanical, adversarial          | Pass profile: effort, sandbox, word cap, check limit                                                                  |
| `--property`       | string                                         | The single falsifiable claim to attack                                                                                |
| `--allow-unscoped` | flag                                           | Permit a verification pass with no stdin. Needs explicit `--pass` + inline subject (≥200 chars); recorded as a bypass |
| `--max-checks`     | n                                              | Override the enumerated-check limit                                                                                   |
| `--word-cap`       | n                                              | Override the answer cap (0 disables)                                                                                  |
| `--no-contract`    | flag                                           | Disable enforcement (escape hatch); recorded as a bypass                                                              |
| `-s`, `--sandbox`  | read-only, workspace-write, danger-full-access | Default `read-only`                                                                                                   |
| `-d`, `--dir`      | path                                           | Working directory (default: cwd)                                                                                      |
| `--map`            | flag (takes no value)                          | Include the codebase map; the resolved path is printed                                                                |
| `-w`, `--wait`     | flag                                           | Return once the turn concludes, printing a cost line. The bound applies with or without it                            |
| `--dry-run`        | flag                                           | Show the shaped prompt and the decision without executing                                                             |
| `--json`           | flag                                           | Machine-readable output                                                                                               |
| `--all`            | flag                                           | `runs`/`ledger`: show every run, not the newest 20                                                                    |

There is no `-f`/`--file` flag — it was removed upstream. **stdin is the scope channel.**

---

## Recording what happened

If the repo keeps an `agents.log`, append the run ID, pass kind, property, timeout, and verdict
per run, plus your synthesis. The ledger has the numbers; the log has the judgement.

After a context compaction: read `agents.log`, run `codex-agent runs --json` and
`codex-agent ledger`, then resume.
