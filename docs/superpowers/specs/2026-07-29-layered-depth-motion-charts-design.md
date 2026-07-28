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

## Visual System Changes (`src/app/globals.css`)

- `--background` becomes a three-stop layered gradient applied to `body` (or a wrapping
  element): `#0a0a0c → #050506 → #020203` (top to bottom), replacing the flat `#09090b`.
- Card surfaces move from solid `#18181b` to a translucent glass treatment:
  `background: rgba(255,255,255,0.03)`, `border: 1px solid rgba(255,255,255,0.08)`,
  `box-shadow: 0 8px 24px rgba(0,0,0,0.3)`.
- Radius scale shifts up one notch: the base `--radius` token increases so cards render at
  ~16px (currently smaller) — reuse the existing `--radius-*` scale in `globals.css`,
  just changing the base value, not the scale's structure.
- Accent stays `#3b82f6` (`--primary`/`--accent` unchanged). A subtle accent glow
  (`box-shadow: 0 0 12px rgba(59,130,246,0.4)`) is added specifically to the `approve`
  verdict badge and to hover-lifted cards' accent-colored elements, using the *existing*
  blue, not a new hue.
- These are CSS-variable/utility-class level changes; component markup for
  `VerdictBadge`/`SeverityBadge`/`PollStatusBanner`/`FindingCard` stays structurally as-is
  from the 2026-07-28 pass — only the underlying tokens they consume change.

## Motion System (new GSAP dependency)

Add `gsap` as a new npm dependency (industry-standard, tree-shakeable animation library).

**`src/app/components/HoverLiftCard.tsx`** (new, client component):
- Wraps its `children` in a `div` with a `ref`.
- On mount, attaches `mouseenter`/`mouseleave` handlers using `gsap.quickTo` for `y` and a
  paired box-shadow tween, per the "Standard" hover tier: `y: -4`, boosted shadow,
  `duration: 0.25`, `ease: 'power2.out'`. Reverses on `mouseleave`.
- Cleans up listeners on unmount.
- Used to wrap each PR row Card on the List Page and each section Card on the Detail Page,
  without altering their internal markup/props.

**`src/app/components/StaggerReveal.tsx`** (new, client component):
- Wraps a list of children (e.g. the List Page's row cards).
- On mount, runs `gsap.from()` on each direct child with a small stagger: `opacity: 0`,
  `y: 8`, `duration: 0.35`, `ease: 'power1.out'`, `stagger: 0.05`.
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
export interface SeveritySummaryInput {
  severityCritical: number;
  severityHigh: number;
  severityMedium: number;
  severityLow: number;
  lastReviewedAt: string | null; // same "has a prior successful review" signal
                                  // listPageViewModel.ts already uses (see
                                  // buildListRowViewModel's hasPriorSuccess)
}

export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number; // sum of the four, for percentage math; 0-safe (see below)
}

export function buildSeveritySummary(rows: SeveritySummaryInput[]): SeveritySummary;
```

- Sums each severity bucket only across rows where `lastReviewedAt !== null` (i.e. rows
  that have ever completed a real review) — mirrors `listPageViewModel.ts`'s existing
  `hasPriorSuccess` convention so a PR that's `pending`/`reviewing`/`failed`-with-no-prior
  contributes zero rather than skewing the aggregate with stale/absent data. In practice
  this is naturally true anyway (those rows' severity columns default to 0 in the schema),
  but filtering explicitly documents the intent and protects against a future schema
  default change.
- `total: 0` (all-zero / no reviewed PRs yet) is a valid, tested input — both consuming
  components must render a sensible empty/zero state (see below), not divide-by-zero or
  render an empty gradient.

**`src/app/components/SeveritySummaryBar.tsx`** (new, server-renderable, no `'use client'`):
- Takes a `SeveritySummary` (or the raw list, computing it inline — decided during
  implementation planning) and renders the 4-segment proportional flex bar shown in the
  approved mockup, with each segment's `flex-basis`/`width` proportional to its share of
  `total`.
- Zero-total state: renders a single neutral/muted full-width segment with a "暂无审查数据"
  (no reviewed data yet) label, rather than a blank invisible bar.
- Includes a small text legend below the bar (counts per severity), matching the mockup.

**`src/app/components/SeverityDonut.tsx`** (new, server-renderable, no `'use client'`):
- Renders a single PR's 4-category proportions as a CSS `conic-gradient` circle (a `div`
  with `background: conic-gradient(...)` computed from the 4 percentages, an inner
  transparent circle to create the ring via `mask`/nested-div technique).
- Zero-total state (a PR with no findings at all, e.g. a clean `approve` verdict): renders
  a full ring in a neutral "clean" color (not an empty/invisible circle) with a checkmark
  or "0 findings" label, so an all-approve PR still shows something meaningful rather than
  a broken-looking blank ring.
- Placed on the Detail Page near the existing verdict/severity summary area.

## Testing

- `severitySummary.test.ts` (TDD, written first): covers empty input, single-severity-only
  input, mixed input, an input row with `lastReviewedAt: null` correctly excluded, and the
  zero-total case.
- `SeveritySummaryBar.test.tsx` / `SeverityDonut.test.tsx`: render tests asserting correct
  proportional widths/conic-gradient stops for a known input, and the zero-total fallback
  render.
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
