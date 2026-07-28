# Layered Depth + Motion + Severity Charts — Design

## Context

The dashboard's "Modern SaaS Cards" restyle (2026-07-28) established a flat dark theme:
single-layer `#09090b` background, flat `#18181b` cards, blue `#3b82f6` accent. This
follow-up upgrade systematically deepens that same visual family — rather than replacing
it — using the `ui-ux-pro-max` skill's style/color/typography/motion/chart databases as
reference, plus real GSAP micro-interactions and two new pieces of genuinely useful
severity-distribution data visualization (not purely decorative).

Confirmed during brainstorming (see chat log for the visual-companion comparison the user
approved):
- Keep the existing blue accent `#3b82f6` — do not switch to indigo or another hue.
- Adopt the "layered dark" depth treatment (three-stop gradient background, glass-style
  card borders/background, deeper shadows, 16px radius).
- Add GSAP motion at "standard" intensity: 4px hover-lift + shadow boost on cards, and a
  staggered fade/rise-in on initial mount for card lists.
- Add two severity visualizations: an aggregate distribution bar on the List Page (across
  all tracked PRs), and a per-PR distribution donut on the Detail Page. Both are pure CSS
  (no charting library) since the data is a simple static 4-category proportion, not
  interactive — keeps this a zero-new-runtime-dependency addition for the chart parts, and
  keeps `SeveritySummaryBar`/`SeverityDonut` server-renderable (no `'use client'` needed).
- Keep Geist fonts unchanged (already a modern geometric sans, matches the target
  aesthetic — no reason to introduce a font swap only for this pass).

## Non-Goals

- No new charting library (Recharts/Chart.js/D3) — CSS-only for both visualizations.
- No accent color change, no font change.
- No changes to data model, API routes, poller, or review pipeline — this is a
  presentation-layer-only pass (continuing the same scoping discipline as the 2026-07-28
  restyle: `RecheckButton`'s fetch logic, view-model business logic, and DB layer are all
  out of scope).
- No ScrollTrigger / scroll-triggered reveal — card lists are short enough to reveal on
  mount instead, avoiding the extra GSAP plugin.

## Visual System Changes (`src/app/globals.css` + component-level utility classes)

**Important finding from spec review:** the current dark restyle's card/border colors are
not driven purely by CSS custom properties — `src/app/page.tsx`, `src/app/pr/[number]/page.tsx`,
`src/app/components/FindingCard.tsx`, and `src/app/components/PollStatusBanner.tsx` all use
Tailwind arbitrary-value utilities with **literal hardcoded hex codes**
(e.g. `bg-[#18181B]`, `border-[#27272A]`, `text-[#FAFAFA]`) rather than the semantic
`bg-card`/`border-border`/`text-foreground` token utilities `globals.css` defines. Changing
`--card`/`--border` in `globals.css` alone would therefore have **no visible effect** on
these surfaces. This upgrade must do two things together, not tokens alone:

1. Add new CSS custom properties in `globals.css`'s `:root` block for the glass treatment:
   `--glass-bg: rgba(255,255,255,0.03)`, `--glass-border: rgba(255,255,255,0.08)`,
   `--glass-shadow: 0 8px 24px rgba(0,0,0,0.3)`, `--glass-shadow-hover: 0 12px 32px rgba(0,0,0,0.4)`,
   registered in the `@theme inline` block the same way existing tokens are (so they're
   usable as Tailwind utilities, e.g. `bg-glass`, `border-glass`, `shadow-glass`).
2. Add a shared `@layer components { .card-glass { ... } }` rule in `globals.css` combining
   those tokens (background/border/shadow/16px radius) into one reusable class. `.card-glass`
   is layered *on top of* the shadcn `Card` primitive's own `bg-card`/border/`ring-1`
   defaults (it overrides the background/border/shadow declarations `Card` already applies
   via its own classNames, not duplicates them alongside a second border/shadow) — where
   `Card` is used, callers add `className="card-glass"` and it takes precedence in
   Tailwind's cascade over `Card`'s own `bg-card ring-1` defaults, so there is exactly one
   border/one shadow/one background per card, not two stacked.

   **Explicit file-by-file disposition of every hardcoded-hex utility found in the
   codebase** (this list is exhaustive — nothing hex-literal is left undecided):
   - `src/app/page.tsx`, `src/app/pr/[number]/page.tsx`: replace their `border-[#27272A]
     bg-[#18181B]`-style card-surface classes with `.card-glass`; replace
     `text-[#FAFAFA]`/`text-[#D4D4D8]` literal text-color utilities with the existing
     semantic `text-foreground`/`text-muted-foreground` utilities.
   - `src/app/components/FindingCard.tsx`: replace `border-[#27272A] bg-[#18181B]` (line 27)
     with `.card-glass`; replace `text-[#FAFAFA]` (line 31) with `text-foreground`; replace
     all three `text-[#D4D4D8]` occurrences (lines 36/39/42) with `text-muted-foreground`;
     the inner code-snippet background `bg-[#09090B]` (line 45) is **kept as-is** — it is an
     intentionally-darker nested "well" inside the glass card (a `<pre>` code block), not a
     card surface, and changing it is out of scope for this visual pass.
   - `src/app/components/PollStatusBanner.tsx` (line 18: `border-[#451A03] bg-[#FBBF24]/10
     text-[#FBBF24]`): **kept as-is, unchanged.** This is a status/warning banner, not a
     card surface — its amber hex values are a semantic "warning" color, not a
     card/border/base-text color this glass pass touches. Out of scope for this spec.
   - `src/app/components/VerdictBadge.tsx` (lines 21-24) and
     `src/app/components/SeverityBadge.tsx` (lines 6-9): **kept as-is, unchanged.** These
     are the existing per-verdict/per-severity semantic color gradients (green=approve,
     amber=needs_review, red=needs_fix/critical, etc. — a 2026-07-28 decision). This spec
     does not touch verdict/severity semantic colors — it only restyles card/surface/
     border/base-text colors. The **same hex values already in `SeverityBadge.tsx`** are,
     however, reused (not redefined) as the data source for the new chart tokens below, so
     the chart colors and the existing badge colors are guaranteed to match exactly.

   To make those same severity colors available to the new `SeveritySummaryBar`/
   `SeverityDonut` components without duplicating literals in two places, add four new
   CSS custom properties to `globals.css`'s `:root` (copied verbatim from
   `SeverityBadge.tsx`'s existing `bg-[...]` values, not new colors):
   `--severity-critical: #991B1B`, `--severity-high: #F87171`,
   `--severity-medium: #FBBF24`, `--severity-low: #3F3F46`, registered in `@theme inline`
   the same way as the other `--color-*` tokens (so `bg-severity-critical` etc. become
   available as Tailwind utilities). `SeverityBadge.tsx` itself is **not** refactored to
   consume these new tokens in this pass (it keeps its literal hex classes, per the
   "kept as-is" decision above) — the new tokens exist solely so the chart components have
   a single, token-based source of truth instead of re-hardcoding the same hex values a
   third time.

Additional changes:
- `body`'s background moves from a flat `bg-background` fill to a 3-stop layered gradient.
  Concretely: add a `.app-gradient` utility in `@layer base` — 
  `background-image: linear-gradient(180deg, #0a0a0c 0%, #050506 60%, #020203 100%)` — and
  apply it to `body` in `src/app/layout.tsx` alongside (not replacing) the existing
  `bg-background` class, so `--background` still provides a solid-color fallback (no-JS,
  print, or if the gradient rule fails to load) while the gradient renders on top in normal
  browsers.
- Base `--radius` in `globals.css` increases from `0.75rem` to `1rem` (16px), used by both
  the new `.card-glass` class and every existing consumer of the `--radius-*` scale
  (`Card`/`Badge`/`Button` from shadcn) — no structural change to the scale itself, just
  the base value, so this is a single-line change with a wide, already-tested-elsewhere
  visual effect.
- Accent stays `#3b82f6` (`--primary`/`--accent` unchanged, no new hue). A subtle accent
  glow (`box-shadow: 0 0 12px rgba(59,130,246,0.4)`) is added specifically to the existing
  `approve` gradient in `VerdictBadge.tsx` (appending to its existing className string, not
  changing its colors) and to `HoverLiftCard`'s hover box-shadow (see Motion System below).

## Motion System (new GSAP dependency)

Add `gsap` as a new npm dependency (industry-standard, tree-shakeable animation library).

**Next.js Server/Client Component boundary:** `HoverLiftCard` and `StaggerReveal` are
`'use client'` components, but the `Card` elements (and everything inside them) that they
wrap remain ordinary Server-Component-rendered JSX passed in as `children`. This is a
standard, fully-supported Next.js App Router pattern — a Server Component's rendered output
can be passed as `children`/props into a Client Component; the restriction is only that a
Client Component cannot *import* a Server Component module directly. No page needs to
become a Client Component to use these wrappers.

**Reduced motion:** GSAP tweens are driven by JS (`requestAnimationFrame`), not CSS
transitions, so they are **not** covered by `globals.css`'s existing
`@media (prefers-reduced-motion: reduce)` rule (which only zeroes CSS
animation/transition durations). Both `HoverLiftCard` and `StaggerReveal` must check
`window.matchMedia('(prefers-reduced-motion: reduce)').matches` on mount and, if true, skip
GSAP entirely (render children with no hover/reveal animation, plain static state) rather
than attempting a zero-duration tween.

**`src/app/components/HoverLiftCard.tsx`** (new, client component):
- Props: `{ children: React.ReactNode; className?: string }`.
- Renders a single unstyled wrapper `div` (`ref`-attached, `className` passed through
  untouched for layout purposes only — e.g. so callers can still control width/flex
  behavior in a flex/grid parent) around `children`. It adds **no** background/border of
  its own — the visual chrome (background, border, base shadow, radius) still comes
  entirely from `.card-glass` on the `Card` it wraps. `HoverLiftCard` only ever animates
  `transform: translateY()` and `box-shadow` on its own wrapper `div`, layered visually
  behind/around the `Card` it contains, so there is no double-shadow or conflicting-radius
  visual artifact.
- On mount (motion allowed), attaches `mouseenter`/`mouseleave` handlers using
  `gsap.quickTo` for `y` and a paired box-shadow tween: `y: -4`,
  `boxShadow: 'var(--glass-shadow-hover)'`, `duration: 0.25`, `ease: 'power2.out'`.
  Reverses to the resting `y: 0` / `var(--glass-shadow)` on `mouseleave`. Cleans up
  listeners on unmount.
- **Must not interfere with the existing List Page full-card-clickable-overlay pattern**
  (established in the 2026-07-28 restyle: an absolutely-positioned `z-0` `Link` under a
  `pointer-events-none z-[1]` content wrapper, with `RecheckButton` at `pointer-events-auto
  z-10`). `HoverLiftCard` wraps the *whole* `Card` (overlay Link, content wrapper, and
  RecheckButton all stay inside it, in their existing relative stacking order) — it does
  not introduce its own `position`/`z-index`/`pointer-events` styling that would shift that
  stack. The implementation plan must include a manual check (or a targeted test) that the
  card is still fully clickable/keyboard-focusable and the RecheckButton still receives
  its own clicks independently after this wrapper is added.

**`src/app/components/StaggerReveal.tsx`** (new, client component):
- Props: `{ children: React.ReactNode; className?: string }`.
- On mount (motion allowed), runs `gsap.from()` on each direct child of its wrapper `div`
  with a small stagger: `opacity: 0`, `y: 8`, `duration: 0.35`, `ease: 'power1.out'`,
  `stagger: 0.05`. If motion is not allowed (reduced-motion), renders children at their
  final state with no animation.
- No `ScrollTrigger` — purely a mount-time reveal, since PR lists are expected to be short
  enough to be visible without scrolling in the common case; this keeps the GSAP bundle
  smaller (no extra plugin import/registration).

Both components are additive wrappers placed around existing JSX in `page.tsx` and
`pr/[number]/page.tsx` — they do not change those pages' data-fetching, view-model calls,
or the internal structure/props of `RecheckButton`, `VerdictBadge`, `SeverityBadge`,
`PollStatusBanner`, or `FindingCard`.

## Severity Visualization

**`src/lib/severitySummary.ts`** (new, pure function, fully unit-tested — TDD):

```ts
import type { PullRequestRow } from '../db/pullRequests';

export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number; // sum of the four, for percentage math; 0-safe (see below)
  reviewedCount: number; // count of input rows with last_reviewed_at !== null;
                          // distinguishes "no reviewed data yet" from "reviewed,
                          // zero findings" — see zero-state logic below
}

// Takes raw PullRequestRow[] directly (snake_case DB fields), matching the
// existing convention in listPageViewModel.ts / page.tsx, where page
// components pass `getOpenPrs(db, repo)`'s result straight into a
// view-model builder without any intermediate camelCase mapping step —
// the mapping happens inside the builder function itself.
export function buildSeveritySummary(rows: PullRequestRow[]): SeveritySummary;
```

- Sums each severity bucket (`row.severity_critical`, `.severity_high`, `.severity_medium`,
  `.severity_low`) only across rows where `row.last_reviewed_at !== null` (i.e. rows that
  have ever completed a real review) — mirrors `listPageViewModel.ts`'s existing
  `hasPriorSuccess` convention (`buildListRowViewModel`'s `hasPriorSuccess = input.lastReviewedAt !== null`)
  so a PR that's `pending`/`reviewing`/`failed`-with-no-prior contributes zero rather than
  skewing the aggregate. In practice this is naturally true anyway (those rows' severity
  columns default to `0` in the schema), but filtering explicitly documents the intent and
  protects against a future schema default change. `reviewedCount` is the count of rows
  that passed this same `last_reviewed_at !== null` filter (independent of whether their
  severity counts were all zero).
- `total: 0` is a valid, tested output in two distinct scenarios, disambiguated by
  `reviewedCount`, and consumers must render different copy for each:
  - `reviewedCount === 0` ("no reviewed data yet" — every input row is still
    `pending`/`reviewing`/never successfully reviewed).
  - `reviewedCount > 0 && total === 0` ("reviewed, and clean" — one or more rows have
    completed a review and every severity bucket summed to zero findings).
- The **same function and type** serve both consumers: the List Page calls
  `buildSeveritySummary(getOpenPrs(db, repo))` for the cross-PR aggregate; the Detail Page
  calls `buildSeveritySummary([theSinglePrRow])` for that one PR's own donut — no separate
  single-PR type or function is needed.

**`src/app/components/SeveritySummaryBar.tsx`** (new, server-renderable, no `'use client'`):
- Props: `{ summary: SeveritySummary }` — the page computes `buildSeveritySummary(...)`
  server-side and passes the resulting plain object down; the component itself does no
  aggregation and has no knowledge of `PullRequestRow`.
- Renders the 4-segment proportional flex bar shown in the approved mockup, with each
  segment's `flex-basis` proportional to its share of `summary.total`, plus a small text
  legend below the bar showing the raw counts per severity (e.g. "Critical 3 · High 5 ·
  Medium 8 · Low 4").
- Zero-total state (`summary.total === 0`) renders a single neutral/muted full-width
  segment instead of the 4-color bar + legend, with copy chosen by `reviewedCount`:
  - `reviewedCount === 0`: "No reviewed data yet".
  - `reviewedCount > 0`: "No findings across N reviewed PRs" (N = `reviewedCount`) — a
    genuinely clean result, not an absence of data.

**`src/app/components/SeverityDonut.tsx`** (new, server-renderable, no `'use client'`):
- Props: `{ summary: SeveritySummary }` — same shape and same "page computes it, component
  just renders it" contract as `SeveritySummaryBar`.
- Renders the 4-category proportions as a CSS `conic-gradient` ring: an outer `div` with
  `background: conic-gradient(...)` computed from the 4 percentages of `summary.total` (in
  Critical → High → Medium → Low order, matching the bar's segment order and the new
  `--severity-*` color tokens defined above), with an inner same-background circle (via a
  nested absolutely-positioned `div`, not a CSS `mask`, to avoid a browser-support
  conditional path) to punch the visual ring hole.
- Zero-total state (`summary.total === 0`), copy chosen by `reviewedCount` (the Detail
  Page always calls this with a single-element array, so `reviewedCount` is either 0 or 1
  here): renders a full ring in the existing muted/neutral token color with a center label:
  - `reviewedCount === 0` (this PR hasn't completed a review yet): center label "Not yet
    reviewed" — the donut itself is not rendered on the Detail Page in this state to begin
    with (see below), but the component still defines this state for completeness/testing.
  - `reviewedCount === 1` (this PR has been reviewed and found clean): center label
    "0 findings".
- Placed on the Detail Page near the existing verdict/severity summary area, and only
  rendered when the current PR's `last_reviewed_at !== null` (i.e. the Detail Page itself
  gates on having a completed review before mounting `SeverityDonut` at all, using the
  same `hasPriorSuccess` signal `listPageViewModel.ts` already computes) — a PR still
  awaiting its first review shows the existing pending/in-progress status UI instead of an
  empty donut.

## Testing

- `severitySummary.test.ts` (TDD, written first): covers empty array input, a single-row
  input, mixed multi-row input, a row with `last_reviewed_at: null` correctly excluded
  from the sums (and correctly excluded from `reviewedCount`), the "no reviewed data yet"
  zero-total case (`reviewedCount === 0`), and the "reviewed but clean" zero-total case
  (`reviewedCount > 0`, `total === 0`).
- `SeveritySummaryBar.test.tsx` / `SeverityDonut.test.tsx`: render tests asserting correct
  proportional widths/conic-gradient stops for a known `SeveritySummary` input, and both
  distinct zero-state renders (`reviewedCount === 0` vs. `reviewedCount > 0 && total === 0`)
- `HoverLiftCard.test.tsx` / `StaggerReveal.test.tsx`: mock `gsap` (same pattern already
  used for `child_process` mocks elsewhere in this codebase) and assert only that children
  render correctly and that the expected `gsap` methods are invoked with the documented
  tween parameters — not real animation timing, which jsdom can't meaningfully verify.
- All existing 120 tests must continue passing unchanged; `VerdictBadge`/`SeverityBadge`/
  `PollStatusBanner`/`FindingCard`/`RecheckButton`/page component tests are not expected to
  need any changes since their props/behavior are untouched — only the CSS tokens they
  render against change.
- `npm run lint` / `npm run build` must stay clean, same as every prior chunk in this
  session.

## Rollout

Implemented as a new set of TDD chunks (final breakdown decided by `writing-plans`),
following the same isolated-worktree + subagent-driven-development + code-review pattern
used for the 2026-07-28 restyle and the review-runner bugfixes.
