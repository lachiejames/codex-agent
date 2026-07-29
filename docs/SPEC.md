# codex-agent — the spec

This file exists because the repo never had one.

`codex-agent` is a hard fork of `Bootoshi/codex-orchestrator`. The fork inherited a
transport (an interactive Codex TUI driven through tmux and scraped with
`capture-pane`) that nobody here chose, and a large amount of machinery whose only
purpose was to compensate for that transport being lossy. The invocation contract in
`src/contract.ts` was written deliberately, from measured failures. Almost nothing else
was.

So this document states the behaviour the tool is **for**. It is the thing every change
is checked against. When code and this file disagree, one of them is wrong and the
disagreement gets resolved rather than absorbed.

---

## The behaviours

### 1. Codex is a read-only brain. Claude is the body.

Codex plans and reviews. It does not write code. Every pass profile is read-only, the
default sandbox is `read-only`, and write access is something a caller opts into with an
explicit `-s workspace-write`. Claude makes the edits.

This removes a whole class of accident: upstream's default let every spawned agent modify
the tree, including the review passes whose entire job is to look.

### 2. Every pass runs the strongest available thinker.

`gpt-5.6-sol` at `xhigh`, always. Reasoning effort is **never** lowered as a cost control.

This is load-bearing, not a preference. `xhigh` is what caught a genuinely subtle
double-post defect — a `postMessage` running under both a client's default ten retries and
a four-retry wrapper, ~44 attempts at an irreversible POST. A pass that silently downgrades
the model is a footgun: you ask for a check and quietly get a worse thinker than every
other pass.

**Bound the question, not the thinking.** If a design points at lowering effort, the design
is wrong.

### 3. The invocation contract holds.

Derived from a measured 1h50m / 115-exec / no-verdict failure on 2026-07-26. See the header
comment in `src/contract.ts`; every rule there traces to that run or to the 51-second run
that answered the same question correctly.

- An unscoped verification pass is **refused**. No diff on stdin, no run.
- A pass enumerating more than its profile's `maxChecks` independent checks is **refused**.
  Fan out instead — one property per call, in parallel.
- A verification pass must end with a machine-checkable `VERDICT: CLEAN|BROKEN` line.
- Bypasses are ratcheted and recorded. An invisible escape hatch is indistinguishable from
  having no contract.
- The ledger reports `SPENT` and `CUM-IN` as separate columns because they are separate
  quantities, and never substitutes one for the other.

There is deliberately **no token ceiling**. Measured over 87 runs: the plan judged
excellent cost 13.7M tokens; the plan judged a catastrophe cost 2.8M. No ceiling separates
them.

There is deliberately **no zero-exec fail-fast**. `execCount: 0` is the *healthy* signature
of a scoped pass, because the shaped prompt tells the agent not to read other files.

### 4. Every invocation carries an explicit timeout. There are no defaults.

`--timeout <minutes>` is **required**. Omitting it is a contract refusal (exit 3).

A default that a machine caller inherits silently is not a bound, it is a habit. Callers
forget defaults exist, and then a 10-minute pass and a 60-minute deep adversarial pass run
under the same accidental number. The right bound for a narrow review of a small diff and
the right bound for planning a large chunk of work differ by an order of magnitude, and only
the caller knows which one this is.

The timeout bounds **one invocation** — one turn of thinking — not the lifetime of a
conversation. See behaviour 6.

The one ceiling that does not require a caller to pick a number is the **runaway stall
backstop**: a hang detector that fires only when every progress signal is flat at once. It
is not a budget. A run that is still emitting events is never stopped by it, however
expensive.

### 5. Parallel fan-out is a first-class use case.

One Claude session routinely runs several independent Codex passes at once — five reviewers
attacking five different properties of one PR. Each is a separate job, a separate thread, a
separate process, with its own event stream, its own bound and its own exit code. Nothing is
shared between them.

This is the *intended* shape of a review, not an edge case. The contract's breadth guard
exists specifically to push callers into it.

### 6. Claude supervises. A running pass is visible and steerable.

A job is a **thread** with N invocations, not one long-lived session.

- Claude can see what a running pass is doing: which commands it has run, how many, what it
  has spent, whether it has answered.
- Claude can **steer a pass mid-flight**: `send` interrupts the running invocation and
  resumes the thread carrying a new instruction. Interruption preserves everything the agent
  had already completed — verified: a turn killed after three of ten tool calls resumed and
  correctly reported all three results.
- Steering is **deterministic**. It happens at a boundary the supervisor chooses, not
  whenever a keystroke happens to land. The previous transport typed into a TUI input box and
  the message landed mid-turn or at the next turn depending on how much work remained — a
  race nobody could see.

Exactly one Codex process runs per thread at a time. That is what makes the answer file and
the event stream single-writer, and it is the same mechanism that makes steering work.

### 7. Warn, then kill. A nearly-finished good run is not shot.

When an invocation approaches its bound, the supervisor interrupts it and resumes with an
instruction to conclude now. Only if that fails does the bound become fatal.

The old behaviour was kill-at-bound, which made every timeout a gamble: too tight and you
lose good work seconds from completion, too loose and a stray run burns an hour. Warn-then-kill
removes the gamble instead of retuning it.

An answered run is **never** a breach. A run that has concluded goes idle by definition, so
its signals flat-line — recording that as a stall or a timeout corrupts the exact signal the
ledger exists to report.

### 8. Nothing fails silently, and nothing fails slowly.

A pass that cannot start must say so in seconds, not hours.

The failure this exists to prevent: a Codex agent blocked on a directory-trust prompt,
burning its entire bound in silence, while the human waits hours before asking and is told
"oh, it never started." Under this transport an untrusted directory is an immediate non-zero
exit with a one-line reason, captured and recorded the moment it happens.

Every terminal-bad state is recorded on the job the instant it is observed, with the reason,
so that whoever next looks — human or Claude — is told what happened rather than left to
infer it from silence.

### 9. A result is durable and retrievable.

`codex-agent report <id>` returns what was asked, the answer untruncated, the ledger row, and
why the run was judged as it was — read from files, long after the process is gone.

The answer's source of truth is the file Codex itself writes (`--output-last-message`), not
anything this tool parses out of a stream. Event-stream items are an implementation detail
that can change shape between versions; the last-message file is Codex's own contract for
"this is the final answer".

A verdict that exists only in a live process is not a verdict.

### 10. Exit codes are load-bearing.

| Code | Meaning |
|------|---------|
| 0 | usable result |
| 1 | operational failure (bad arguments, job not found) |
| 3 | **contract refusal** — fix the invocation, then retry |
| 4 | **the run is not a usable result** — a verification pass with no verdict, or a run a guard stopped |

A verification pass that never concluded must not look like a success to a caller checking
exit status.

### 11. One door, one tree.

There is exactly one copy of this tool and exactly one skill that teaches it. `bin/` is on
`PATH` directly; `~/.codex-orchestrator` is a compatibility symlink into the same tree. No
per-repo copies, no plugin-cache duplicates, no rival Codex-teaching skill anywhere.

This is enforced by `scripts/verify-install.sh`, which asserts it by asking a real Claude
session what it can see. That assertion must never be weakened into a proxy — "no rival
skill files exist on disk" is a different and weaker claim than "Claude loads exactly one
door".

A broken change here removes Codex access for every project on the machine. The gate runs
before and after anything that touches the transport.

---

## Measuring against this spec

`bash scripts/verify-install.sh --all` is the instrument. It asserts behaviours 1, 3, 4, 10
and 11 mechanically, and 2, 6, 7, 8 and 9 through a live Codex run.

The gate must also be able to detect **its own metrics dying**. `extractSessionId` silently
stopped matching when Codex 0.145.0 stopped printing a session id, and took the exec count
with it; nothing went red, because nothing asserted that the numbers were still arriving.
A gate that cannot notice its own instruments failing is how that survived.
