# 1. Record architecture decisions

Date: 2026-09-28 · Status: accepted

## Context
Several agents and humans build granary in parallel; decisions must be visible.

## Decision
Every architectural decision is recorded as one Markdown file in `docs/adr/`,
named `NNNN-kebab-title.md`, with Context / Decision / Consequences. Numbers
are allocated sequentially; when working in parallel, claim the ranges
assigned in the task (0001–0019 foundation, 0020–0029 repo setup, 0030–0039
protocols, 0040–0049 actor system, 0050–0059 UI, 0060–0069 fake GitHub &
tests). Superseded ADRs are kept and marked `Superseded by N`.

## Consequences
Numbering gaps are expected.
