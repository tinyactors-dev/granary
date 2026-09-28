# 177. Committing from parallel forks without a shared-index race

Date: 2026-09-28 · Status: accepted

## Context
Parallel forks share one working tree and one git index. A bare
`git commit` after `git add` sweeps up whatever other forks staged (this
happened twice during E1–E5), and files touched by several forks contain
hunks from more than one fork.

## Decision
Forks commit through a **private index**: `GIT_INDEX_FILE=<tmp> git
read-tree HEAD`, add only their own paths (for shared files, a blob built by
replaying only their own hunks onto HEAD), type-check that exact tree in a
scratch checkout, `GIT_INDEX_FILE=<tmp> git commit`, then `git reset --
<their paths>` on the shared index. `git commit --only <paths>` is the
simpler alternative when a file contains only one fork's changes.
