#!/usr/bin/env bash
# Remove the legacy artifacts left behind by the fork from Bootoshi/codex-orchestrator.
#
# DRY RUN BY DEFAULT — prints what it would delete and why, and touches nothing.
#
#   bash scripts/cleanup-legacy.sh            # show what would go
#   bash scripts/cleanup-legacy.sh --delete   # actually delete it
#   bash scripts/cleanup-legacy.sh --delete --keep-backups
#
# Deliberately NOT deleted:
#   ~/.codex-orchestrator  — the symlink into this repo. Harmless, and shells started
#                            before .zshrc changed still resolve through it.
#   ~/.codex/config.toml   — live config, including the project trust entries.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DELETE=0
KEEP_BACKUPS=0
for arg in "$@"; do
  case "$arg" in
    --delete) DELETE=1 ;;
    --keep-backups) KEEP_BACKUPS=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

TOTAL_KB=0

# Report one target, then delete it if --delete was passed.
consider() {
  local path="$1" why="$2"
  [ -e "$path" ] || return 0

  local kb
  kb=$(du -sk "$path" 2>/dev/null | cut -f1)
  kb=${kb:-0}
  TOTAL_KB=$((TOTAL_KB + kb))

  printf '  %-58s %6s MB  %s\n' "${path/#$HOME/~}" "$((kb / 1024))" "$why"
  if [ "$DELETE" = "1" ]; then
    rm -rf "$path" && printf '    \033[0;32mdeleted\033[0m\n' || printf '    \033[0;31mFAILED\033[0m\n'
  fi
}

printf '\n\033[1mLegacy trees\033[0m\n'
# The pre-fork clone. Its tree hash was verified identical to the fork and its two local
# commits are preserved there, so this is pure duplication now.
for d in "$HOME"/.codex-orchestrator.old-*; do
  consider "$d" "pre-fork clone, superseded by this repo"
done
# A third full copy, from an earlier delete-to-Trash. Trash is not emptied automatically,
# so this stays a live grep hit and a live "which install is real?" question until removed.
consider "$HOME/.Trash/.codex-orchestrator" "third copy sitting in Trash"
# Claude Code's own copy of the old plugin. The marketplace and plugin are both
# uninstalled, so nothing reads this.
consider "$HOME/.claude/plugins/cache/codex-orchestrator-marketplace" "old plugin cache, uninstalled"
consider "$HOME/.claude/plugins/cache/cartographer-marketplace" "cartographer cache, uninstalled"
consider "$HOME/.claude/plugins/marketplaces/cartographer-marketplace" "cartographer marketplace, removed"

printf '\n\033[1mAbandoned plugin-install temp dirs\033[0m\n'
for d in "$HOME"/.claude/plugins/cache/temp_git_*; do
  consider "$d" "interrupted plugin install"
done

if [ "$KEEP_BACKUPS" = "0" ]; then
  printf '\n\033[1mBackups taken during the migration\033[0m\n'
  printf '  (pass --keep-backups to retain these; delete only once you trust the new state)\n'
  # Globbed, not hardcoded: the original timestamps only ever matched one machine, and
  # publishing them told the world nothing except when the author ran a migration.
  for f in "$HOME"/.claude/settings.json.bak-*; do
    consider "$f" "pre-migration Claude settings backup"
  done
  for f in "$HOME"/.zshrc.bak-*; do
    consider "$f" "pre-PATH-change shell backup"
  done
  for f in "$HOME"/.codex/config.toml.bak-*; do
    consider "$f" "pre-change codex config backup"
  done
fi

printf '\n\033[1mTotal: %s MB\033[0m\n' "$((TOTAL_KB / 1024))"

# ---------------------------------------------------------------------------
# Job logs are handled by the CLI's own retention, not by rm — it also reaps
# orphaned tmux sessions, which a bare delete would leave running.
printf '\n\033[1mJob logs (handled separately)\033[0m\n'
jobs_kb=$(du -sk "$HOME/.codex-agent" 2>/dev/null | cut -f1)
old_count=$(find "$HOME/.codex-agent/jobs" -type f -mtime +7 2>/dev/null | wc -l | tr -d ' ')
printf '  ~/.codex-agent is %s MB; %s files older than 7 days.\n' "$(( ${jobs_kb:-0} / 1024 ))" "$old_count"
printf '  Reap with the CLI (also kills orphaned tmux sessions):\n'
printf '    codex-agent clean\n'
if [ "$DELETE" = "1" ]; then
  printf '\n  Running it now...\n'
  "$REPO/bin/codex-agent" clean 2>&1 | sed 's/^/    /'
fi

if [ "$DELETE" = "0" ]; then
  printf '\n\033[1mDry run — nothing was deleted.\033[0m Re-run with --delete to apply.\n'
else
  printf '\n\033[1mDone.\033[0m Now re-verify: bash scripts/verify-install.sh\n'
fi
