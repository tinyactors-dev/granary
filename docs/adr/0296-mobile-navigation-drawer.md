# 296. Mobile navigation is a drawer; scrollers show they scroll

Date: 2026-09-29 · Status: accepted

## Context
On phones the app had two stacked horizontally scrolling bars — the main nav
in the top bar and the section's sub-nav (Ops, Policy, Settings) below it —
with nothing showing that either scrolled, and filter tabs cut off mid-word
("Clo…"). `/admin/load` scrolled the whole page sideways (a chart sized
itself from its own width).

## Decision
- Below `lg` the top bar shows a menu button, the logo and the current
  section's name. The button opens a left drawer (`MobileNav`, bits-ui
  Dialog) with the same entries as the desktop sidebar: the main nav, or
  under `/admin` its grouped areas plus "Back to app". Navigating closes it.
  The second scrolling bar is gone.
- Section sub-navs stay one horizontal scroller, with an edge fade
  (`.scroll-fade-x`, removed once scrolled to the end) and the active item
  scrolled into view (`scrollFade` action).
- Filter tabs wrap onto a second line on phones instead of scrolling, so
  every option is visible.
- Grid children that contain charts are `min-w-0`, and charts are capped at
  their container's width, so nothing forces page-level horizontal scroll.
- Large status heroes (Ops "Sleeping is fine"/"Needs you") shrink on phones
  so the first screen still shows content.

## Consequences
One navigation pattern per breakpoint: sidebar on desktop, drawer on phones
and tablets. Verified with agent-browser (drawer opens, closes on
navigation; no page overflows at 390, 768, 1440 px).
