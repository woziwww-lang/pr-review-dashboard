# PR Review Dashboard — UI/UX Visual & Interaction Polish

## Status

Approved by user (via visual-companion brainstorming session). Ready for implementation planning.

## Goal

Give the existing PR Review Dashboard (List Page + Detail Page) a polished,
"silky" (丝滑) dark-mode-only visual and interaction treatment, while
**preserving all existing functionality and data logic exactly as-is**. This
is a pure presentation-layer upgrade — no new features, no changes to
polling, review pipeline, API contracts, or view-model shapes.

## Non-Goals (explicitly out of scope)

- No new functional features (no search/filter/sort on the PR list, no
  pagination). Confirmed with the user: keep the spacious card style even
  with 20+ PRs; scrolling is acceptable. (One small, intentional
  navigational addition: a "← Back to list" link on the Detail Page,
  which does not exist today. This is a pure navigation affordance with
  no new data/logic — it links to the existing List Page route `/` — but
  is called out explicitly here since it is technically new markup, not
  a restyle of something pre-existing.)
- No light mode / theme toggle. Dark mode only.
- No changes to `src/lib/*ViewModel.ts` data shapes, API routes, DB schema,
  or the poll/review pipeline. Anything under `src/lib`, `src/db`,
  `src/instrumentation*.ts` is untouched by this work. (One exception,
  scoped narrowly: the "Re-check now" *client-side submission mechanism*
  changes from a native HTML form POST to a `fetch()` call, purely to fix
  a real interaction gap — see `RecheckButton` below. This does not touch
  `/api/recheck/[number]`'s method, URL, request, or response contract at
  all.)
- No changes to the 106 existing lib/API/view-model tests' assertions on
  data — they must continue to pass unmodified except where a component
  test's DOM-structure assertions need updating to match new markup (see
  Testing Strategy).

## Background / Current State

The dashboard currently renders with create-next-app's default global CSS
(Arial font, minimal styling, native HTML `<table>` for the PR list, plain
divs for the detail page sections). No CSS framework is installed. The app
already ships `Geist` and `Geist Mono` via `next/font/google` in
`src/app/layout.tsx` — no additional font downloads are needed for this
redesign.

## Chosen Design Direction

Selected via a visual-companion brainstorming round (3 options presented,
user picked **Option C: "Modern SaaS Cards"**), then confirmed to keep the
spacious variant even for repos with many open PRs, and confirmed motion
(subtle, 150–250ms) + typography (existing Geist fonts) defaults.

### Visual Design System

- **Style**: Modern SaaS Cards — card-based list rows (replacing the native
  `<table>`), rounded corners, gradient status badges, generous whitespace.
- **Mode**: Dark mode only, no toggle, no `prefers-color-scheme` fallback to
  light.
- **Palette** (from ui-ux-pro-max design-system generation, Option C
  direction):
  - Background: `#09090B`
  - Card surface: `#18181B`
  - Card border: `#27272A`
  - Primary text: `#FAFAFA`
  - Secondary/muted text: `#71717A` / `#A1A1AA`
  - Verdict badge full mapping (`VerdictBadge`'s `BadgeVerdict` type has 4
    values — all 4 must be styled, not just approve/needs_review):
    - `approve` → success gradient `#22C55E → #16A34A`
    - `needs_review` → warning gradient `#FBBF24 → #F59E0B`
    - `needs_fix` → danger gradient `#F87171 → #DC2626` (distinct from
      `failed` — this is a real review outcome, not an error state)
    - `failed` → neutral/muted gray `#3F3F46` background, `#A1A1AA` text
      (this means the review process itself errored, not a code-quality
      verdict — must look visually distinct from `needs_fix`)
  - Severity badge full mapping (`SeverityBadge`'s `Severity` type has 4
    values — all 4 must be styled):
    - `CRITICAL` → solid `#991B1B` background, `#FECACA` text (most
      alarming, deliberately not a gradient — reserve gradients for
      verdict badges so severity vs. verdict remain visually distinguishable
      at a glance)
    - `HIGH` → solid `#F87171` background, `#450A0A` text
    - `MEDIUM` → solid `#FBBF24` background, `#451A03` text
    - `LOW` → solid `#3F3F46` background, `#D4D4D8` text
  - In-progress row state (`ListPageRowViewModel.isInProgress`, true when
    `review_status` is `'pending'` or `'reviewing'` — this is the only
    signal the view model exposes; it does not distinguish pending vs.
    reviewing, so the UI uses a single generic label, matching today's
    actual List Page behavior at `src/app/page.tsx:69`
    (`row.isInProgress ? 'Reviewing…' : <VerdictBadge .../>`)): rendered as
    a de-emphasized card (reduced opacity ~0.7 on the verdict/severity
    area) with a small pulsing dot + "Reviewing…" label in place of the
    verdict badge. The `RecheckButton` (below) is disabled for
    in-progress rows/PRs.
  - Accent (primary actions, e.g. "Re-check now" button): blue gradient
    `#3B82F6 → #2563EB`
- **Typography**: `Geist Sans` for UI text/headings, `Geist Mono` for
  PR numbers, SHAs, file paths, and other code-like tokens (already
  configured in `layout.tsx` as CSS variables `--font-geist-sans` /
  `--font-geist-mono` — reuse via Tailwind's `fontFamily` config, do not
  add new `next/font` imports).
- **Spacing/density**: Generous card padding (~14-16px), ~8-10px gaps
  between stacked cards. No compact/dense mode, no pagination — list simply
  scrolls for repos with many PRs (confirmed acceptable by user).
- **Motion**: Subtle only — 150–250ms `ease-out` transitions on
  hover/press/loading-state changes. Maximum 1-2 animated elements per view
  (e.g., a button's loading spinner, a card's hover elevation) — no
  page-level or decorative animation. Must respect
  `prefers-reduced-motion: reduce` (disable/shorten transitions when set).

### Tech Stack Additions

- **Tailwind CSS v4** (via `@tailwindcss/postcss` — Next.js 16 supported
  integration path) — replaces ad hoc global CSS for layout/spacing/color
  utilities.
- **shadcn/ui** components, initialized via its CLI (`components.json`,
  dark-only theme in `globals.css` using CSS variables) — install only the
  primitives actually used: `Button`, `Card`, `Badge`. No other shadcn
  primitives are installed for this change (no `Skeleton`/`Separator` —
  nothing in this spec calls for a loading-skeleton placeholder or a
  divider component; add them later only if a concrete need arises).
- **lucide-react** for icons (per ui-ux-pro-max's anti-pattern guidance:
  no emoji-as-icon). Only icons actually needed: `ArrowLeft` (Detail
  Page's "← Back to list" link), `Loader2` (spinner, used by the shared
  recheck button described below), `CircleCheck` (approve verdict),
  `TriangleAlert` (needs_review / needs_fix / failed verdicts and
  error banners).
- No new state-management, animation, or data-fetching libraries — this is
  a pure styling/markup change.

## Component-Level Changes

All changes are presentation-only. Existing component **props interfaces
must not change** (so the 106 existing tests that exercise data/logic
continue to pass without modification).

1. **`src/app/page.tsx` (List Page)**
   - Header: repo name + `PollStatusBanner` rendered as a small pill/banner
     at the top (unchanged data, restyled).
   - PR list: replace the native `<table>` with a vertically stacked list
     of card rows (one `shadcn Card` per PR), each showing: PR number
     (mono font), title, branch, author, verdict badge (gradient pill) or
     the in-progress treatment described above when `isInProgress` is
     true, severity count, last-reviewed timestamp, and the shared
     "Re-check now" button (see `RecheckButton` below) — all fields
     sourced from the same `buildListPageViewModel` output as today.

2. **`src/app/pr/[number]/page.tsx` (Detail Page)**
   - Executive Summary: a `Card` with the verdict badge + summary text.
   - Top Risks: a `Card` containing a `FindingCard` per finding, with a
     left color-bar (via `border-left`) keyed to severity, matching the
     mockup shown in brainstorming.
   - Medium/Low: same `FindingCard`-based treatment, visually de-emphasized
     (smaller text/muted color) relative to Top Risks.
   - Raw report: kept as a collapsible/`<details>`-style section, restyled
     but behaviorally unchanged.
   - "Re-check now" button: the shared `RecheckButton` component (see
     below), restyled as a primary gradient button.
   - "← Back to list" link: restyled with the `ArrowLeft` lucide icon.

3. **New shared component: `RecheckButton`** (`src/app/components/
   RecheckButton.tsx`) — a single **Client Component** (`'use client'`)
   used by *both* the List Page's per-row action and the Detail Page's
   header action, so the fetch/loading-state logic is implemented once,
   not duplicated:
   - Props: `prNumber: number` and `disabled: boolean` (computed by the
     *parent Server Component* from data it already has in scope — see
     below — and passed down; `RecheckButton` itself does not know about
     `review_status`/`isInProgress` and needs no new view-model fields).
   - **Behavior change from today (in scope, not a new feature — a
     interaction-correctness fix needed to make this "silky"):**
     currently both pages render a plain `<form method="post"
     action="/api/recheck/[number]">`. Submitting that form causes the
     browser to navigate to `/api/recheck/[number]` and render its raw
     JSON response as the new page — there is no inline loading state or
     staying on the dashboard page today. `RecheckButton` replaces this
     with a client-side `fetch('/api/recheck/' + prNumber, { method:
     'POST' })` call (same endpoint, same method, zero API changes),
     handled as:
     - While the request is in flight: button shows `Loader2` spinner +
       "Re-checking…" text, and is disabled to prevent double-submits.
     - `202` response (`status: 'started'` or `status: 'queued'`): on
       success, call `router.refresh()` (from `next/navigation`) so the
       enclosing Server Component re-fetches DB state and the row/page
       flips to its in-progress visual treatment; briefly show a success
       micro-state (e.g. checkmark flash) before the refresh completes.
     - `409` (`already-in-progress`): no-op path in practice since the
       button is `disabled` whenever the parent already knows the PR is
       in progress, but if a race still produces 409, show a brief inline
       "Already in progress" message instead of an error.
     - `404` / `502` / `400` / `500`: show a brief inline error message
       (e.g. "Re-check failed: <error text from response body>") near the
       button; button returns to its normal (non-loading) state so the
       user can retry.
   - `disabled` prop wiring: List Page passes `row.isInProgress` (already
     computed by `buildListRowViewModel`, no changes needed there); Detail
     Page computes `pr.review_status === 'pending' || pr.review_status
     === 'reviewing'` directly in `page.tsx` from the `PullRequestRow`
     it already fetches via `getByNumber` — this is a page-level
     presentational computation, not an addition to
     `DetailPageViewModel`'s shape (which the spec's Non-Goals require to
     stay unchanged).

4. **Existing shared components** (`src/app/components/`):
   - `VerdictBadge.tsx`, `SeverityBadge.tsx`: re-implemented using shadcn's
     `Badge` component with custom gradient/solid variants per the full
     4-value mappings above; same props (`verdict` / `severity` enums in,
     JSX out) — existing unit tests' assertions on rendered text/labels
     continue to hold; only class-name/DOM-structure assertions may need
     updating.
   - `PollStatusBanner.tsx`: restyled as a small pill banner; same props.
   - `FindingCard.tsx`: restyled with the severity-colored left border
     described above; same props.

## Error Handling

No new *data/business-logic* error states are introduced — the polling
pipeline, review pipeline, and API contracts are unchanged. The one
addition is purely transient, client-side UI feedback around the
`RecheckButton` fetch call described above (loading spinner, brief
success flash, inline "already in progress" note on a `409`, inline
error text on `404`/`502`/`400`/`500`) — these are ephemeral UI states
tied to a single button interaction, not new persisted error states or
new failure modes in the underlying system. Existing error/edge-case
rendering (e.g., "no successful review yet" banner, `(not configured)` repo
fallback, failed-review warning banner) keeps its current conditional
logic — only its visual treatment changes (e.g., rendered as a
warning-colored `Card`/banner instead of plain text).

## Testing Strategy

- **Untouched**: all `src/lib/*.test.ts`, `src/db/*.test.ts`,
  `src/app/api/**/*.test.ts` — these test data/logic, not markup, and must
  continue to pass with zero modifications.
- **Updated as needed**: `src/app/components/*.test.tsx` — these may need
  DOM-query updates (e.g., a `getByRole('button')` selector or a class-name
  assertion) to match new shadcn-based markup, but the underlying
  assertions (what text/labels/states are shown for a given prop) must not
  change.
- **New**: `src/app/components/RecheckButton.test.tsx` — this is new
  client-side interaction logic (the fetch-based submit/loading/error
  handling described above), not just markup, so it needs real test
  coverage: mock `fetch` and `next/navigation`'s `useRouter().refresh`,
  and assert the loading/success/error-message states for `202`, `409`,
  and error status codes, plus that the button renders `disabled` when
  the `disabled` prop is true.
- No new automated visual-regression tooling is being introduced (out of
  scope) — visual verification is manual: `npm run build` (confirms no
  build breakage from the Tailwind/shadcn addition) + `npm run dev` against
  real seeded/live data (reusing the manual-verification pattern already
  established in Chunk 5/6/7 of the original implementation) to visually
  confirm List Page, Detail Page, and the Re-check loading state.
- Full suite (currently 106 tests) must remain green after the redesign,
  accounting for any component-test updates and the new `RecheckButton`
  tests described above.

## Rollout

This work happens directly on `main` (no long-lived feature branch
required per user's established workflow for this repo, but implementation
planning may still recommend a short-lived branch/worktree per the
`using-git-worktrees` convention already used for the original 7-chunk
build — to be decided in the implementation plan). No remote/CI
considerations apply (this repo currently has a single `origin` remote
under the user's own private GitHub account, pushed at the end of the
original build).
