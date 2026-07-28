# Paste-able prompts

Self-contained prompts for a **fresh** Claude Code chat. Each one carries the context it needs, so
none of them depend on a previous conversation.

The rule they all encode: **Codex is the brain, Claude is the body.** Codex plans and reviews,
read-only. Claude writes everything.

---

## A. Verify and clean up this machine

Use after any change to the install, or when something feels off.

```text
Work in ~/dev/personal/codex-agent (private fork of Bootoshi/codex-orchestrator).

1. Run: bash scripts/verify-install.sh --all
   This checks: one tree (fresh login shell), the test suite including the skill-copy drift
   guard, the contract's refusal exit codes (3 = refusal, 4 = no verdict), read-only on every
   pass profile, no plugin stuck in failed-to-load, the skill loading in each target repo, and
   a real bounded Codex review reaching a verdict.

2. If anything fails, diagnose and fix it. Do not weaken a check to get a green — the whole
   point of the script is that it fails loudly. If a check is genuinely not applicable, make it
   report "not applicable" rather than pass.

3. Then run: bash scripts/cleanup-legacy.sh
   Read the dry-run output to me with the reason for each target. Do NOT delete yet.

4. Ask me whether to delete. If I say yes, run it with --delete and then re-run
   verify-install.sh to prove nothing broke.

Notes:
- ~/.codex-orchestrator is a SYMLINK into the repo. Do not delete it and do not let it become a
  real directory again — two independent clones is the exact drift this fork exists to end.
- ~/.codex-agent holds tmux job logs and can reach hundreds of MB. Reap it with
  `codex-agent clean`, never a bare rm, because clean also kills orphaned tmux sessions.
- An enterprise policy blocks loading this as a Claude Code plugin from any source. The skill is
  delivered as per-repo COPIES listed in skill-targets.json; `bash scripts/sync-skill.sh`
  reconciles them and `bun test` fails if one has drifted. Never edit a copy.

Report what you actually ran and what it actually said, including anything you could not verify.
```

---

## B. Plan a change with Codex (three phases)

Use before writing code for anything non-trivial. Skip it for one-liners.

```text
Use Codex as a read-only planning brain for this. You do all the writing; Codex never edits
anything. `codex-agent` is on PATH. Defaults are gpt-5.6-sol at xhigh — do not pass -m or -r,
and do NOT lower the reasoning effort to make a run finish faster.

GOAL: <describe what you want built or changed>

Run three phases in sequence, reading and judging each output before starting the next. Every
run is read-only by default; leave it that way.

P1 — Recon. What is actually there?
  codex-agent start --pass plan "Map how <subsystem> works today: entry points,
  data flow, where state lives, what already handles <the concern>, and what would break if it
  changed. Do not propose solutions yet." --map --wait

P2 — Design. Feed P1's conclusions back in. Demand the rejected alternatives — a design with no
discarded options has not been thought about.
  codex-agent start --pass plan "Given this recon: <paste P1>. Design the change to
  <goal>. Give ONE recommended approach, then the alternatives you rejected and why. Call out
  every assumption that, if wrong, changes the answer." --map --wait

P3 — Stress-test THE PLAN, not the code. This is the highest-value phase and the one people
skip. A design flaw caught here costs a paragraph; caught after implementation it costs the
branch.
  codex-agent start --pass adversarial --allow-unscoped --wait --property "This plan survives
  contact with production: <paste the plan>"

Then:
- Tell me which findings are real, which are over-engineering, and which are the model
  misreading the codebase. Judging the output is the job; relaying it is not.
- Write the plan up and get my agreement BEFORE implementing.
- Then YOU implement it. Never ask Codex to write code.

If a run produces no verdict, that is a failed run, not a cautious one — narrow the question.
Check `codex-agent ledger`: zero exec calls means it was blocked on a prompt, not thinking.
```

---

## C. Review a diff with Codex (three phases)

Use before shipping. This is the shape that answers in seconds instead of not converging.

```text
Review my current branch using Codex as a read-only reviewer. `codex-agent` is on PATH.

The CLI enforces an invocation contract, and it will refuse you if you get the shape wrong:
  exit 3 = contract refusal (fix the invocation, do not work around it)
  exit 4 = the pass produced no verdict
This is because one unbounded review once ran 1h50m across 115 exec calls with no verdict, while
the same question scoped to ONE property with the diff piped in was answered correctly in 51
seconds. So: pipe the diff, one property per call, never bundle checks.

1. Capture the scope once:
     git diff origin/main...HEAD -- <paths> > /tmp/review.diff
   Show me the file list and line count first so I can confirm the scope.

2. Propose 6–9 properties across three phases, and show me the list BEFORE running anything.
   Each must be FALSIFIABLE BY A CONCRETE INPUT. "Review for data integrity" is not; "no
   migration is destructive to existing rows" is.
     R1 correctness  — dropped values, double delivery, partial writes, off-by-one
     R2 safety       — injection, authorization bypass, irreversible effects running twice
     R3 house rules  — this repo's conventions from CLAUDE.md / AGENTS.md

3. Run them in PARALLEL, one property per call, diff on stdin:
     for p in "..." "..." ; do
       codex-agent start --pass review --property "$p" --wait < /tmp/review.diff &
     done; wait
   Use --pass adversarial for R2 and --pass mechanical for R3.

4. Show me `codex-agent ledger`. Treat any NONE verdict as a FAILED RUN, not a pass — narrow
   that property and re-run it before concluding.

5. For each BROKEN verdict: reproduce it before fixing it. Then tell me plainly which findings
   were real, which were over-engineering, and which were the model misreading the code.

6. YOU write the fixes. Codex never edits anything.
```

---

## D. Set up on a new machine

```text
Set up my codex-agent install from scratch on this machine.

1. Clone the private repo to ~/dev/personal/codex-agent:
     git clone git@github-personal:lachiejames/codex-agent.git ~/dev/personal/codex-agent
   It uses my personal GitHub identity: .envrc sets GH_CONFIG_DIR=~/.config/gh-personal, and
   ~/.gitconfig includeIf rules scope commit identity under ~/dev/personal. Verify with
   `git config user.email` inside the repo — it must NOT be my work address.

2. bun install, then put ./bin on PATH in ~/.zshrc (the repo directly, NOT a second clone).

3. Requires tmux, Bun, the OpenAI Codex CLI, and `codex --login`. Verify: codex-agent health

4. Trust the repo directory for Codex — trust is matched by EXACT path, so trusting a parent
   does not cover it. Add to ~/.codex/config.toml:
     [projects."<absolute path to the repo>"]
     trust_level = "trusted"
   Without this, runs block forever on an interactive prompt with zero exec calls.

5. Copy the skill into each consuming repo: bash scripts/sync-skill.sh
   (Copies, not symlinks. `bun test` fails if a copy drifts. Never edit a copy.)
   An enterprise policy blocks the Claude plugin marketplace, which is why this is per-repo
   project skills rather than a plugin.

6. Prove it: bash scripts/verify-install.sh --all

Report anything you could not verify rather than assuming it worked.
```
