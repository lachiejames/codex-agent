#!/usr/bin/env bash
# Behaviour verification — the paths verify-install.sh does NOT cover.
#
#   bash scripts/verify-behaviours.sh      # ~6 minutes, spends real Codex tokens
#
# verify-install.sh proves the INSTALL is correct: one tree, contract enforced, read-only by
# default, one door, and one live review that reaches a verdict. This proves the BEHAVIOURS in
# docs/SPEC.md that only show up across multiple turns, across process death, or on paths a
# single happy-path run never touches.
#
# Every check here exists because it was not covered and something was wrong. The multi-turn
# section found two real defects on its first run:
#
#   * the supervisor hardcoded `resume = false`, so `send` on an idle run silently began a
#     SECOND Codex thread — context gone, and the record still naming the first thread; and
#   * the one-thread invariant added to catch that counted thread.started ANNOUNCEMENTS, but
#     `codex exec resume` re-announces the same id, so it killed every healthy second turn.
#
# Neither was visible from a green suite, a green gate, or a run that looked correct.
set -uo pipefail
cd ~/dev/personal/codex-agent
CLI=./bin/codex-agent
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[0;31m✗\033[0m %s\n' "$1"; }

settle(){ # runId maxSeconds
  local id="$1" max="$2" i=0
  while [ $i -lt "$max" ]; do
    s=$($CLI status "$id" 2>/dev/null | awk '/^Status:/{print $2}')
    [ "$s" != "running" ] && [ "$s" != "starting" ] && { echo "$s"; return; }
    sleep 2; i=$((i+2))
  done
  echo "TIMEOUT"
}

printf '\n\033[1mA. Multi-turn: send to an IDLE run (the resumed path)\033[0m\n'
out=$($CLI start --pass plan "Remember the number 8831. Reply with only: STORED" --timeout 10 2>&1)
id=$(grep -oE 'Run started: [0-9a-f]+' <<<"$out" | awk '{print $3}')
st=$(settle "$id" 180)
[ "$st" = "waiting" ] && ok "turn 1 concluded (status=waiting), run $id" || bad "turn 1 status=$st"

t1=$($CLI status "$id" 2>/dev/null | grep -c "alive")
send=$($CLI send "$id" "What number did I ask you to remember? Reply with only the number." 2>&1)
grep -q "Resumed" <<<"$send" && ok "send on an idle run took the RESUMED path (not steered)" \
  || bad "send on idle run: $send"
st2=$(settle "$id" 180)
[ "$st2" = "waiting" ] && ok "turn 2 concluded" || bad "turn 2 status=$st2"
ans=$($CLI report "$id" 2>&1)
grep -q "8831" <<<"$ans" && ok "thread CONTEXT SURVIVED across a fresh supervisor (recalled 8831)" \
  || bad "context lost across turns"
turns=$($CLI status "$id" 2>/dev/null | awk '/^Turns:/{print $2}')
[ "$turns" = "2" ] && ok "2 turns recorded" || bad "turns=$turns"
grep -cE '^\[turn [12] of 2' <<<"$ans" >/dev/null && ok "both answers persisted separately in .answer.md" \
  || bad "answers not separated"

printf '\n\033[1mB. A verification pass with NO verdict must exit 4\033[0m\n'
printf 'diff --git a/x b/x\n+line\n' > /tmp/g.diff
$CLI start --pass review --no-contract "Say the word banana and nothing else. Do not use the word verdict." \
  --timeout 5 --wait < /tmp/g.diff >/tmp/nv.txt 2>&1
code=$?
[ "$code" = "4" ] && ok "no-verdict review exited 4" || bad "expected exit 4, got $code"
grep -q "FAILED RUN" /tmp/nv.txt && ok "report says FAILED RUN" || bad "report did not flag it"
nvid=$(grep -oE 'Run started: [0-9a-f]+' /tmp/nv.txt | awk '{print $3}')
$CLI report "$nvid" >/dev/null 2>&1; [ $? = 4 ] && ok "report re-run also exits 4 (durable judgement)" \
  || bad "report exit not durable"

printf '\n\033[1mC. Observer backstop: supervisor dies, bound still enforced\033[0m\n'
out=$($CLI start --pass plan "Count to 100000 slowly, one number per line, using shell commands one at a time." --timeout 1 2>&1)
bid=$(grep -oE 'Run started: [0-9a-f]+' <<<"$out" | awk '{print $3}')
sleep 6
sup=$($CLI status "$bid" 2>/dev/null | awk '/^Supervisor:/{print $2}')
if [ -n "$sup" ] && [ "$sup" != "-" ]; then
  kill -9 "$sup" 2>/dev/null && ok "killed supervisor $sup outright (SIGKILL, no cleanup)" || bad "could not kill supervisor"
  sleep 60
  $CLI status "$bid" >/dev/null 2>&1
  st=$($CLI status "$bid" 2>/dev/null | awk '/^Status:/{print $2}')
  br=$($CLI status "$bid" 2>/dev/null | grep -c "enforced by an observer")
  [ "$st" = "failed" ] && ok "an observing command stopped the orphaned run (status=failed)" \
    || bad "orphaned run status=$st — THE BACKSTOP DID NOT FIRE"
  [ "$br" -gt 0 ] && ok "breach names the observer as the enforcer" || bad "breach message did not attribute"
  cpid=$($CLI status "$bid" --json 2>/dev/null | grep -oE '"codexPid": [0-9]+' | grep -oE '[0-9]+')
  if [ -n "$cpid" ] && kill -0 "$cpid" 2>/dev/null; then bad "orphaned codex process $cpid STILL RUNNING"; else ok "the orphaned codex process was reaped too"; fi
else
  bad "no supervisor pid recorded"
fi

printf '\n\033[1mD. --map through the real CLI\033[0m\n'
mo=$($CLI start --pass plan "Design a thing" --timeout 45 --map --dry-run </dev/null 2>&1)
grep -q "Included codebase map: .*CODEBASE_MAP.md" <<<"$mo" && ok "--map resolved and NAMED the file it used" \
  || bad "--map did not report a path: $(grep -i map <<<"$mo" | head -1)"
grep -qE "Would send ~[0-9,]{4,}" <<<"$mo" && ok "map cost is accounted in the prompt estimate" || bad "no accounting"

printf '\n\033[1mE. clean is bounded and honest\033[0m\n'
before=$($CLI runs --all 2>/dev/null | grep -cE '^[0-9a-f]{8} ')
cl=$($CLI clean 2>&1)
after=$($CLI runs --all 2>/dev/null | grep -cE '^[0-9a-f]{8} ')
grep -qE "Removed [0-9]+ runs older than 7 days, freeing [0-9]+ MB" <<<"$cl" && ok "clean reports what it did: $cl" || bad "clean output: $cl"
[ "$before" = "$after" ] && ok "clean did NOT touch runs inside the retention window ($before runs before and after)" \
  || bad "clean removed recent runs: $before -> $after"

printf '\n\033[1mF. Every observing command tolerates a nonexistent id\033[0m\n'
for cmd in status report tail kill; do
  o=$($CLI "$cmd" doesnotexist1 2>&1); c=$?
  [ "$c" = "1" ] && ok "$cmd on a missing run exits 1 cleanly" || bad "$cmd exit=$c ($o)"
done

printf '\n\033[1m%s\033[0m\n' "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
