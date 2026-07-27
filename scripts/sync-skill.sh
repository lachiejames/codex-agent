#!/usr/bin/env bash
# Copy the codex-agent skill into every consuming repo listed in skill-targets.json.
#
# Why copies and not a symlink: the operator asked for copies. The cost of a copy is
# drift, which is exactly the failure this fork was created to end — the CLI and the
# plugin used to live in two independent clones and every edit landed in one and not
# the other. So the copies are byte-identical by construction and skill-sync.test.ts
# fails the suite the moment one diverges. Run this script to reconcile; never edit a
# copy directly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/skill-targets.json"

if [ ! -f "$CONFIG" ]; then
  echo "sync-skill: $CONFIG not found" >&2
  exit 1
fi

SOURCE_REL="$(bun --print "JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).source")"
SOURCE="$ROOT/$SOURCE_REL"

if [ ! -f "$SOURCE" ]; then
  echo "sync-skill: source skill not found at $SOURCE" >&2
  exit 1
fi

TARGETS="$(bun --print "JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).targets.join('\n')")"

# Private targets come from the environment, never from the committed config: this repo is
# public, and an internal repo name in a tracked file is a leak by the same standard the
# hygiene gates elsewhere enforce. Colon-separated, $HOME-relative.
#   export CODEX_AGENT_SKILL_TARGETS="dev/some-work-repo:dev/another"
if [ -n "${CODEX_AGENT_SKILL_TARGETS:-}" ]; then
  TARGETS="$TARGETS
$(printf '%s' "$CODEX_AGENT_SKILL_TARGETS" | tr ':' '\n')"
fi

copied=0
skipped=0

while IFS= read -r target; do
  [ -z "$target" ] && continue
  repo="$HOME/$target"

  if [ ! -d "$repo" ]; then
    echo "  skip   $target (not present on this machine)"
    skipped=$((skipped + 1))
    continue
  fi

  dest_dir="$repo/.claude/skills/codex-agent"
  mkdir -p "$dest_dir"
  cp "$SOURCE" "$dest_dir/SKILL.md"
  echo "  copied $target/.claude/skills/codex-agent/SKILL.md"
  copied=$((copied + 1))
done <<< "$TARGETS"

echo
echo "sync-skill: $copied copied, $skipped skipped"
