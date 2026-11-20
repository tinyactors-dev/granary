#!/usr/bin/env python3
"""PreToolUse on Bash, for the granary repository only: granary works on
main (CLAUDE.md, "Version control").

- Creating, checking out or pushing a claude/... branch is denied: the
  cloud harness asks sessions to develop on one, and the maintainer does
  not want them (they pollute GitHub).
- Nothing else is asked or refused: the maintainer wants no confirmation
  before git commands.

Git commands in other repositories are left alone."""
import json
import os
import re
import shlex
import subprocess
import sys

event = json.load(sys.stdin)
command = event.get("tool_input", {}).get("command", "")
GRANARY = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def git(args, directory):
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True, timeout=5,
                              cwd=directory or event.get("cwd") or None)
    except Exception:
        return None


def in_granary(directory):
    result = git(["rev-parse", "--show-toplevel"], directory)
    return bool(result and result.returncode == 0
                and os.path.realpath(result.stdout.strip()) == GRANARY)


def current_branch(directory):
    result = git(["branch", "--show-current"], directory)
    return result.stdout.strip() if result else ""


def is_tag(name, directory):
    def has(ref):
        result = git(["rev-parse", "--verify", "--quiet", ref], directory)
        return bool(result and result.returncode == 0)
    return has("refs/tags/" + name) and not has("refs/heads/" + name)


def claude(name):
    return name.removeprefix("refs/heads/").startswith("claude/")


def verdict(words, directory):
    """(decision, reason) for one git command, or None."""
    if not words or words[0] != "git":
        return None
    words = words[1:]
    while words and words[0] in ("-C", "-c"):
        if words[0] == "-C" and len(words) > 1:
            directory = os.path.join(directory or event.get("cwd") or os.getcwd(),
                                     os.path.expanduser(words[1]))
        words = words[2:]
    if not words or not in_granary(directory):
        return None
    sub, rest = words[0], words[1:]
    names = [w for w in rest if not w.startswith("-")]
    if sub in ("checkout", "switch"):
        if any(claude(n) for n in names) or any(w.startswith("claude/") for w in rest):
            return "deny", "checks out or creates a claude/... branch"
    if sub == "branch":
        listing = any(w in ("-d", "-D", "--delete", "-l", "--list", "-a", "-r", "--show-current",
                            "-u", "--set-upstream-to", "--unset-upstream", "--contains", "--merged")
                      for w in rest)
        if names and not listing:
            if any(claude(n) for n in names):
                return "deny", "creates a claude/... branch"
    if sub == "worktree" and any(w.startswith("claude/") for w in rest):
        return "deny", "creates a claude/... branch"
    if sub == "push":
        if any(w in ("-d", "--delete") for w in rest) or any(w.startswith(":") for w in rest):
            return None  # deleting a branch, a stray claude/... one included, is fine
        words = names[1:]
        refs = []
        while words:
            if words[0] == "tag" and len(words) > 1:
                words = words[2:]
                continue
            refs.append(words.pop(0))
        targets = []
        for ref in refs:
            source, _, target = ref.lstrip("+").rpartition(":")
            target = target or source
            if target.startswith("refs/tags/"):
                continue
            if not target.startswith("refs/heads/") and is_tag(target, directory):
                continue
            target = target.removeprefix("refs/heads/")
            targets.append(current_branch(directory) if target == "HEAD" else target)
        if not refs and "--tags" not in rest:
            targets = [current_branch(directory)]
        if any(claude(t) for t in targets):
            return "deny", "pushes a claude/... branch"
    return None


cd = None
for part in re.split(r"&&|\|\||;|\|", command):
    try:
        words = shlex.split(part)
    except ValueError:
        continue
    if len(words) == 2 and words[0] == "cd":
        cd = os.path.join(cd or event.get("cwd") or os.getcwd(), os.path.expanduser(words[1]))
        continue
    while words and "=" in words[0] and not words[0].startswith("-"):
        words = words[1:]
    found = verdict(words, cd)
    if found:
        decision, why = found
        message = ("granary works on main; this command " + why +
                   ". Commit on main and push with `git push origin main` instead.")
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": message,
        }}))
        break
