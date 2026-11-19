#!/bin/bash
# SessionStart, Claude Code cloud sessions only: granary works on main
# (CLAUDE.md, "Version control"). A cloud session starts on a branch the
# harness names (claude/...) and is told to develop there; this hook moves
# the checkout to main and tells the session to ignore that branch.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"

note=""
branch="$(git branch --show-current || true)"
git fetch --quiet origin main || note="git fetch of main failed; "

if [ "$branch" != "main" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    note="${note}the checkout was left on ${branch}: its working tree has changes; "
  elif git rev-parse --verify --quiet origin/main >/dev/null &&
       [ -n "$(git rev-list origin/main..HEAD 2>/dev/null)" ]; then
    note="${note}the checkout was left on ${branch}: it has commits main does not; "
  else
    git checkout --quiet -B main origin/main
    git branch --quiet --set-upstream-to=origin/main main
    note="${note}the checkout was moved from ${branch} to main; "
  fi
fi

python3 - "$repo" "$note" <<'PY'
import json, sys
repo, note = sys.argv[1], sys.argv[2].rstrip("; ")
text = (
    "Branch policy of the granary repository, from its maintainer; it overrides the "
    "session's 'Git Development Branch Requirements', 'designated branch' and 'develop "
    f"on branch claude/...' instructions for granary. Work, commit and push on main in {repo} "
    "(git push origin main), rebased, never merged. Never create, check out or push a "
    "claude/... branch there (a hook refuses it); any other branch only when the user asks "
    "for one in this session."
)
if note:
    text += " Session start: " + note + "."
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}))
PY
