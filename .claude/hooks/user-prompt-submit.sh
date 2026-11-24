#!/bin/bash
# UserPromptSubmit: every prompt carries the rule that a change to what
# granary does starts with the fakes-first skill (CLAUDE.md, process rule 5).
# A short request ("add an icon that…", "make it so that…") is exactly the
# one that gets built straight away without it, so the reminder comes with
# each prompt, not once per session.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"

python3 - "$repo" <<'PY'
import json, sys
repo = sys.argv[1]
text = (
    f"granary ({repo}) rule, from its maintainer: if this request changes what granary does "
    "(a feature, an action, a button or icon, a page, a behaviour, anything touching GitHub), "
    "however small or casually phrased, your first step is the Skill tool with skill "
    "\"fakes-first\", before reading code, planning or editing; then follow its steps "
    "(GitHub's docs, the fake GitHub first, tests through the running system including "
    "restarts, the /admin playground, a browser check, separate commits). Questions, reviews, "
    "and docs-only or other-repository work do not need it."
)
print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}}))
PY
