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

| | Codex | Claude (you) |
|---|---|---|
| Role | brain | body |
| Access | **read-only, always** | full write |
| Good at | planning a hard problem, stress-testing a plan, finding the subtle defect in a diff | writing code, editing files, running tests, committing, driving the loop |
| Gets | a bounded question | the whole job |

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

| run | scope | diff supplied? | result |
|---|---|---|---|
| planning | one plan | no | 100 execs, ~25 min, excellent verdict |
| review | ~25 checks in one call | no | 115 execs, **1h50m, no verdict** |
| narrow | **one property** | **yes, on stdin** | **51s, correct finding** |

**Do NOT lower the reasoning effort to fix this.** `xhigh` is what caught a genuinely
subtle double-post defect — a `postMessage` running under both a client's default ten
retries *and* a four-retry wrapper, ~44 attempts at an irreversible POST. Lowering
effort to make review terminate trades away the exact capability being paid for.
**Bound the question, not the thinking.**

Verification is N independent investigations with no natural stopping point. Planning
converges on a single artifact. That is the whole difference, and it is why planning is
allowed to be broad and review is not.

### The rules, enforced by the CLI

The CLI refuses violations rather than trusting you to remember:

| exit | meaning | what to do |
|---|---|---|
| **3** | contract refusal | fix the invocation; do not work around it |
| **4** | run is not a usable result (no verdict, or killed by a guard) | narrow the property; do not raise the timeout first |

1. **Pipe the diff.** A review/verify/audit prompt with nothing on stdin is refused.
2. **One property per call.** Past 3 enumerated checks a review is refused; fan out.
3. **Every run has a wall-clock bound**, defaulted per pass, applied on every path.
4. **Answers are word-capped**, which forces a verdict instead of exploration.
5. **A verdict is mandatory and machine-checked** — `VERDICT: CLEAN` or `VERDICT: BROKEN`.
6. **Bypasses are narrow and recorded.** `--allow-unscoped` needs an explicit `--pass` and
   the subject supplied inline (≥200 characters); `--no-contract` is logged too. Both show
   in `codex-agent ledger` under `BYPASS`.

### What is deliberately NOT enforced

**There is no token ceiling, and adding one would be wrong.** Measured over 87 recorded
runs: the plan pass judged excellent cost 13.7M tokens over 25 minutes with 83 exec calls;
the plan pass judged a catastrophe cost 2.8M. The expensive run was the good one, so no
ceiling separates them. Bound the *question*, not the spend.

**There is no zero-exec fail-fast.** `execCount: 0` is the *healthy* signature for a scoped
pass — the shaped prompt says "Do not read other files", so the golden 51-second review
made zero exec calls and answered correctly. A guard on that would kill the best runs.

The runaway backstop that does exist requires the log, the token count **and** the turn
count to be flat simultaneously for 10 minutes. It is a hang detector, not a budget.

### Pass profiles

| pass | effort | sandbox | bound | word cap | needs diff | needs verdict |
|---|---|---|---|---|---|---|
| `plan` | xhigh | read-only | 45m | none | no | no |
| `review` | xhigh | read-only | 10m | 300 | yes | yes |
| `adversarial` | xhigh | read-only | 20m | 400 | yes | yes |
| `mechanical` | xhigh | read-only | 5m | 200 | yes | yes |

**Every pass runs `gpt-5.6-sol` at `xhigh`.** `buildCodexArgs` passes `-c model=` and
`-c model_reasoning_effort=` explicitly, which override `~/.codex/config.toml`, so this
table is what actually reaches Codex. Lower it per call with `-r` if you ever need to —
visibly, never silently.

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
  --map --wait
```

The prompt is a **positional argument**. `--map` and `--wait` are bare booleans that consume
nothing, so keep them after the prompt — writing `--map "<prompt>"` also works, but it reads
as though `--map` takes the prompt as its value, and that misreading is how map injection got
switched on by accident in places nobody intended.

Read the output. **You** decide what is true and what the agent misread.

### P2 — Design: what should we do?

Feed P1's findings back in. Ask for one recommended approach plus the alternatives it
rejected and why — a design with no discarded options has not been thought about.

```bash
codex-agent start --pass plan \
  "Given this recon: <paste P1 conclusions>

   Design the change to <goal>. Give ONE recommended approach, then the alternatives you
   rejected and why. Call out every assumption that, if wrong, changes the answer." \
  --map --wait
```

### P3 — Stress-test: how does this plan fail?

The highest-value phase and the one most often skipped. Point Codex at your *plan*, not
your code, and tell it to break it.

```bash
codex-agent start --pass adversarial --allow-unscoped \
  --property "This plan survives contact with production: <paste the plan>" \
  --wait
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
  codex-agent start --pass review --property "$p" --wait < /tmp/review.diff &
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
  codex-agent start --pass adversarial --property "$p" --wait < /tmp/review.diff &
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
  codex-agent start --pass mechanical --property "$p" --wait < /tmp/review.diff &
done; wait
```

### After the reviews

```bash
codex-agent ledger
```

- Treat any `NONE` verdict as a **failed run**, not a pass.
- `0` execs with no verdict means the agent was **blocked on a prompt**, not thinking.
- A large exec count with no verdict means the **property was too broad**.
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
3. `docs/ARCHITECTURE.md`

Two things to know, both learned the hard way:

- **Candidate 3 is a fallback, and it will match a plain architecture document.** A repo with
  no map but a `docs/architecture.md` gets that injected. That is often not what you wanted.
- **The CLI now prints which file it resolved**, with its size, plus a warning if another
  file differs from it only by case. Read that line. The lookup used to report a path that
  did not exist — it asked for `docs/ARCHITECTURE.md`, macOS opened `docs/architecture.md`,
  and the same command on Linux injected nothing at all, silently either way.

```
Included codebase map: /repo/docs/CODEBASE_MAP.md (~2,400 tokens, 9,612 bytes)
No codebase map found under /repo (looked for docs/CODEBASE_MAP.md, CODEBASE_MAP.md,
  docs/ARCHITECTURE.md; case-insensitive)
```

**You generate the map** — it is body work, no separate tool needed:

> Read the repo structure and write `docs/CODEBASE_MAP.md`: per-directory purpose, the
> key modules and what each owns, data flow between them, external dependencies, and a
> "where do I change X" navigation section. Add a `last_mapped` timestamp. Refresh only
> the sections whose files changed since that timestamp.

Regenerate it when the architecture moves, not on every change.

---

## Driving the loop

### Standard cycle

**1. Spawn** (returns a job ID immediately)

```bash
codex-agent start --pass plan "..." --map
```

**2. Wait.** For anything that must conclude, prefer `--wait`. It returns the moment the
pass has answered — a verdict for a verification pass, a completed turn for a plan — and
it shows a running cost line while it waits.

For a conversation you intend to continue, use `await-turn` in a background Bash task:

```bash
codex-agent await-turn "$JOB_ID"
codex-agent status "$JOB_ID"
```

**The bounds apply either way.** The wall-clock bound, the runaway backstop and the
blocking-prompt kill live in `guards.ts` and are applied by every path that observes a
job, including `status`, `jobs` and `await-turn`. They used to live inside the `--wait`
loop, so a job started in the background had no ceiling at all — that gap is closed.

What `--wait` still adds is *reaping*: it closes a session as soon as it has answered.
A background job is deliberately left open so you can `send` it another turn, so close
those yourself with `send <id> "/quit"` when you are done.

**3. React.** Follow up with `send`, or close with `send <id> "/quit"`.

**4. Read the result with `report`, not `output`.**

```bash
codex-agent report "$JOB_ID"
```

`report` prints what was asked, the agent's answer **untruncated**, the ledger row, and a
judgement of whether the run is usable. It reads persisted files, so it still works after
the tmux session — or the whole tmux server — has gone away. It exits **4** when the run
is not a usable result.

`output` is the raw session transcript and is for debugging Codex itself. Do not reach for
it to find an answer: it returns terminal scrollback, and a caller who did that once
concluded a perfectly good 18-minute plan was unrecoverable when it was sitting in the
job record the whole time.

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
codex-agent status <jobId>
codex-agent capture <jobId> 40 --clean
codex-agent send <jobId> "..."      # steer it
codex-agent kill <jobId>            # last resort
```

Use `codex-agent send`, never raw `tmux send-keys` — `send` handles escaping and timing.

A blocked agent is usually waiting on an interactive Codex prompt. Directory trust is
matched by **exact path**, so trusting a parent does not cover a new repo:

```toml
# ~/.codex/config.toml
[projects."/absolute/path/to/repo"]
trust_level = "trusted"
```

---

## Prerequisites

`tmux`, `Bun`, the OpenAI Codex CLI, and `codex --login`.

```bash
codex-agent health
```

If `codex-agent` is missing, run the installer:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
# or, without a plugin root:
bash ~/dev/personal/codex-agent/plugins/codex-agent/scripts/install.sh
```

Defaults come from `~/.codex/config.toml` (`gpt-5.6-sol`, `xhigh`), so `-m`/`-r` are
almost never needed.

---

## CLI reference

```bash
codex-agent start "prompt" [options]   # spawn (see flags below)
codex-agent report <jobId> [--json]    # asked / answered / judged — read this one
codex-agent ledger [--json]            # duration, SPENT, CUM-IN, execs, scoped, bypass, outcome
codex-agent status <jobId> [--json]
codex-agent await-turn <jobId> [--json]
codex-agent send <jobId> "message"
codex-agent capture <jobId> [lines] [--clean]
codex-agent output <jobId> [--clean]   # raw transcript; for debugging Codex, not for answers
codex-agent jobs [--json] [--all]
codex-agent kill <jobId>
codex-agent clean
codex-agent health
```

The ledger has **two** token columns and they are not interchangeable:

| column | meaning |
|---|---|
| `SPENT` | what Codex reported spending. `-` means it never reported it. |
| `CUM-IN` | cumulative *input* tokens from the session file — excludes output, counts re-sent context every turn. Not a cost. |

They used to be one column fed by whichever was available, which is why the same run could
appear to cost 253k or 1.1M. If you need a cost, read `SPENT` and treat `-` as unknown —
never substitute `CUM-IN` for it.

| Flag | Values | Description |
|---|---|---|
| `--pass` | plan, review, mechanical, adversarial | Pass profile: effort, sandbox, bound, caps |
| `--property` | string | The single falsifiable claim to attack |
| `--timeout` | minutes | Wall-clock bound (default: per pass) |
| `--allow-unscoped` | flag | Permit a verification pass with no stdin. Needs explicit `--pass` + inline subject (≥200 chars); recorded as a bypass |
| `--max-checks` | n | Override the enumerated-check limit |
| `--word-cap` | n | Override the answer cap (0 disables) |
| `--no-contract` | flag | Disable enforcement (escape hatch); recorded as a bypass |
| `-s`, `--sandbox` | read-only, workspace-write, danger-full-access | Default `read-only` |
| `-r`, `--reasoning` | low, medium, high, xhigh | Overrides the pass profile |
| `--map` | flag (takes no value) | Include the codebase map; the resolved path is printed |
| `-w`, `--wait` | flag | Return once answered, and reap the session. Bounds apply with or without it |
| `--dry-run` | flag | Show the shaped prompt without executing |

There is no `-f`/`--file` flag — it was removed upstream. **stdin is the scope channel.**

---

## Recording what happened

If the repo keeps an `agents.log`, append the job ID, pass kind, property, and verdict
per run, plus your synthesis. The ledger has the numbers; the log has the judgement.

After a context compaction: read `agents.log`, run `codex-agent jobs --json` and
`codex-agent ledger`, then resume.
