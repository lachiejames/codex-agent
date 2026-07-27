#!/usr/bin/env bash
# End-to-end verification that this machine's codex-agent install is correct.
#
# Checks the things that actually broke or could regress, in dependency order:
# one tree, no drift, contract enforced, read-only by default, no stale plugins.
#
#   bash scripts/verify-install.sh            # fast checks only (~10s)
#   bash scripts/verify-install.sh --skills   # + headless skill-load checks (~1m)
#   bash scripts/verify-install.sh --live     # + a real Codex review run (~1m, needs auth)
#   bash scripts/verify-install.sh --all
#
# Exits non-zero listing every failure. Never fixes anything — this only reports.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
SKIPPED=0
FAILURES=()

DO_SKILLS=0
DO_LIVE=0
for arg in "$@"; do
  case "$arg" in
    --skills) DO_SKILLS=1 ;;
    --live) DO_LIVE=1 ;;
    --all) DO_SKILLS=1; DO_LIVE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

ok()   { PASS=$((PASS+1)); printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILURES+=("$1"); printf '  \033[0;31m✗\033[0m %s\n' "$1"; }
# Not-applicable is distinct from pass and from fail. Counting it as either one makes
# the summary lie.
skip() { SKIPPED=$((SKIPPED+1)); printf '  \033[0;33m–\033[0m %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
section "1. One tree (the drift this fork exists to end)"

# Use a login shell so we test the PATH a NEW terminal gets, not this one's —
# a shell started before .zshrc changed still resolves the old path.
RESOLVED="$(zsh -lic 'command -v codex-agent' 2>/dev/null | tail -1)"
if [ "$RESOLVED" = "$REPO/bin/codex-agent" ]; then
  ok "a fresh login shell resolves codex-agent into this repo"
else
  bad "fresh shell resolves to '${RESOLVED:-nothing}', expected $REPO/bin/codex-agent"
fi

if [ -L "$HOME/.codex-orchestrator" ]; then
  LINK="$(readlink "$HOME/.codex-orchestrator")"
  if [ "$LINK" = "$REPO" ]; then
    ok "~/.codex-orchestrator is a symlink to this repo (no second clone)"
  else
    bad "~/.codex-orchestrator points at $LINK, not $REPO"
  fi
elif [ -e "$HOME/.codex-orchestrator" ]; then
  bad "~/.codex-orchestrator is a REAL DIRECTORY — that is the two-clone drift returning"
else
  ok "~/.codex-orchestrator is absent (fine — nothing references it)"
fi

if git -C "$REPO" remote get-url origin 2>/dev/null | grep -q "lachiejames/codex-agent"; then
  ok "origin points at the private fork, not upstream"
else
  bad "origin is not lachiejames/codex-agent: $(git -C "$REPO" remote get-url origin 2>&1)"
fi

# ---------------------------------------------------------------------------
section "2. Test suite (includes the skill-copy drift guard)"

if (cd "$REPO" && bun test >/tmp/codex-agent-verify-tests.log 2>&1); then
  ok "bun test green ($(grep -oE '[0-9]+ pass' /tmp/codex-agent-verify-tests.log | head -1))"
else
  bad "bun test FAILED — see /tmp/codex-agent-verify-tests.log"
fi

# ---------------------------------------------------------------------------
section "3. Contract enforcement (the 1h50m failure must be unrepresentable)"

CLI=("$REPO/bin/codex-agent")

run_exit() { "${CLI[@]}" "$@" >/dev/null 2>&1; echo $?; }

code=$(run_exit start "Review the auth changes for security issues" --dry-run </dev/null)
[ "$code" = "3" ] && ok "unscoped review REFUSED (exit 3)" \
                  || bad "unscoped review should exit 3, got $code"

code=$(printf 'diff --git a/x b/x\n+line\n' | run_exit start "Review:
- a
- b
- c
- d
- e" --dry-run)
[ "$code" = "3" ] && ok "over-broad review REFUSED (exit 3)" \
                  || bad "5-check review should exit 3, got $code"

code=$(printf 'diff --git a/x b/x\n+line\n' | run_exit start "Review this" --dry-run)
[ "$code" = "0" ] && ok "scoped review ACCEPTED (exit 0)" \
                  || bad "scoped review should exit 0, got $code"

code=$(run_exit start "Design a caching layer" --dry-run </dev/null)
[ "$code" = "0" ] && ok "unscoped PLAN accepted — planning is allowed to be broad" \
                  || bad "plan should exit 0, got $code"

# ---------------------------------------------------------------------------
section "4. Codex is the brain, not the hands (read-only default)"

for pass in plan review mechanical adversarial; do
  out=$(printf 'diff --git a/x b/x\n+line\n' | "${CLI[@]}" start --pass "$pass" \
        --property "x holds" --dry-run --allow-unscoped 2>/dev/null)
  if grep -q "Sandbox: read-only" <<<"$out"; then
    ok "--pass $pass runs read-only"
  else
    bad "--pass $pass is NOT read-only: $(grep -o 'Sandbox: .*' <<<"$out")"
  fi
done

out=$("${CLI[@]}" start --pass plan "Design a cache" -s workspace-write --dry-run 2>/dev/null </dev/null)
grep -q "Sandbox: workspace-write" <<<"$out" \
  && ok "an explicit -s workspace-write is still honoured" \
  || bad "explicit -s override did not take effect"

# ---------------------------------------------------------------------------
section "5. No stale Claude Code plugins"

plugins=$(claude plugin list 2>&1)
if grep -q "failed to load" <<<"$plugins"; then
  bad "a plugin is failing to load:"
  grep -B2 "failed to load" <<<"$plugins" | sed 's/^/      /'
else
  ok "no plugin is in a failed-to-load state"
fi

if grep -qE "codex-orchestrator|cartographer" <<<"$plugins"; then
  bad "a removed plugin is still installed (codex-orchestrator / cartographer)"
else
  ok "the removed plugins are gone"
fi

# ---------------------------------------------------------------------------
if [ "$DO_SKILLS" = "1" ]; then
  section "6. The skill loads where it is supposed to (slow)"
  targets=$(bun --print "JSON.parse(require('fs').readFileSync('$REPO/skill-targets.json','utf8')).targets.join('\n')")
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    [ -d "$HOME/$t" ] || continue
    answer=$(cd "$HOME/$t" && timeout 200 claude -p \
      "Do you have a skill named codex-agent available? Answer only YES or NO." 2>/dev/null | tail -1)
    [ "$answer" = "YES" ] && ok "$t loads the codex-agent skill" \
                          || bad "$t did NOT load the skill (answered: ${answer:-nothing})"
  done <<<"$targets"

  # slopweaver carries its own native version, and it lives on a branch until the PR
  # merges. Checking out main legitimately removes the file, so absence is "not here
  # yet", not a failure — reporting it as broken would train you to ignore this script.
  SW="$HOME/dev/personal/slopweaver"
  if [ ! -d "$SW" ]; then
    :
  elif [ ! -f "$SW/skills/codex-orchestration/SKILL.md" ]; then
    skip "slopweaver: skill not on the checked-out branch ($(git -C "$SW" branch --show-current)) — it is on feat/codex-orchestration"
  else
    answer=$(cd "$SW" && timeout 200 claude --plugin-dir . -p \
      "Do you have a skill named codex-orchestration available? Answer only YES or NO." 2>/dev/null | tail -1)
    [ "$answer" = "YES" ] && ok "slopweaver ships codex-orchestration as a plugin skill" \
                          || bad "slopweaver plugin skill present but NOT loaded (answered: ${answer:-nothing})"
  fi
fi

# ---------------------------------------------------------------------------
if [ "$DO_LIVE" = "1" ]; then
  section "7. A real review reaches a verdict inside its bound (slow, needs Codex auth)"
  scope=$(mktemp)
  # Diff the most recent commit that actually touched src/, so the property below is
  # asked about TypeScript. HEAD~1 is often a docs- or scripts-only commit, and asking
  # about return types in a shell diff is a meaningless test of a real capability.
  src_commit=$(git -C "$REPO" log -1 --format=%H -- src/)
  git -C "$REPO" diff "${src_commit}~1" "$src_commit" -- src/ > "$scope" 2>/dev/null

  if [ ! -s "$scope" ]; then
    bad "could not build a src/ diff to review"
  else
    started=$(date +%s)
    out=$("${CLI[@]}" start --pass review \
      --property "every exported function in the diff has an explicit return type" \
      --timeout 6 --wait --strip-ansi < "$scope" 2>&1)
    elapsed=$(( $(date +%s) - started ))
    verdict=$(grep -oE 'VERDICT: (CLEAN|BROKEN)' <<<"$out" | tail -1)

    if [ -n "$verdict" ]; then
      ok "reached $verdict in ${elapsed}s (bound was 6m)"
    else
      bad "no verdict in ${elapsed}s — check: codex-agent ledger"
    fi

    if grep -q "BLOCKED" <<<"$out"; then
      bad "agent was blocked on an interactive prompt — is this dir trusted in ~/.codex/config.toml?"
    fi
  fi
  rm -f "$scope"
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m%s\033[0m\n' "Result: $PASS passed, $FAIL failed, $SKIPPED not applicable"
if [ "$FAIL" -gt 0 ]; then
  printf '\nFailures:\n'
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
printf 'Install verified.\n'
