# Layered Depth + Motion + Severity Charts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the dashboard's existing dark "Modern SaaS Cards" theme with a layered
glass-card visual treatment, GSAP hover-lift/stagger-reveal motion, and two new pure-CSS
severity distribution charts (List Page aggregate bar, Detail Page per-PR donut) — with
zero accent-color change and zero new data model/API/pipeline changes.

**Architecture:** Three independent, sequentially-buildable chunks: (1) CSS tokens +
`.card-glass`/`.app-gradient` utility classes + replacing every hardcoded hex Tailwind
utility with token-based classes; (2) a new pure `buildSeveritySummary()` function plus two
new server-renderable chart components wired into the List/Detail pages; (3) a new `gsap`
dependency plus two new client-component wrappers (`HoverLiftCard`, `StaggerReveal`) wired
around the existing `Card` elements. Each chunk leaves the app in a fully working, tested
state.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind CSS v4, shadcn/ui components,
Vitest + Testing Library (jsdom), GSAP 3.15 (new dependency), better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-07-29-layered-depth-motion-charts-design.md`
(read this first for full rationale — this plan implements it verbatim, referencing its
line-numbered file dispositions).

**Before starting:** confirm you're in the isolated worktree created for this feature
(`.worktrees/layered-depth-motion-charts`, branch `layered-depth-motion-charts`), with a
clean baseline: `npm test` → 120/120 passing, `npm run lint` → 0 errors, `npm run build` →
clean.

---

## Chunk 1: Visual System — CSS tokens, glass cards, gradient background, hex cleanup

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/pr/[number]/page.tsx`
- Modify: `src/app/components/FindingCard.tsx`
- Modify: `src/app/components/VerdictBadge.tsx`
- Modify: `src/app/components/VerdictBadge.test.tsx`

### Task 1.1: Add new CSS tokens, `.card-glass`, `.app-gradient`, and severity/accent-glow tokens

`globals.css` is plain CSS (not TypeScript/JS), so there's no unit test to write first here
— verification is via `npm run build` (Tailwind must compile the new `@theme inline`
entries into real utility classes without error) plus a manual visual check at the end of
this chunk. This is the one task in the plan that isn't strict TDD, by necessity of the
file type.

**Important implementation detail not fully spelled out in the spec:** Tailwind v4 (and
this project's own generated utilities like `bg-card`, `ring-1`, `rounded-xl` used by
shadcn's `<Card>`) live inside Tailwind's own `@layer utilities` cascade layer. CSS Cascade
Layers give **unlayered** rules priority over **all** `@layer`-wrapped rules, regardless of
source order or selector specificity. If `.card-glass` were declared inside `@layer
components` (as an earlier draft implied), Card's own `bg-card`/`ring-1`/`rounded-xl`
utility classes would silently win and the glass restyle would have **no visible effect**
on any `<Card>` — the same failure mode the spec review already caught once for token-only
changes. To guarantee `.card-glass` reliably overrides Card's built-in chrome, define it
**outside any `@layer` block** (a plain, unlayered rule) — see the code below.

- [ ] **Step 1: Add the new tokens to `globals.css`'s `:root` block**

In `src/app/globals.css`, inside the existing `:root { ... }` block, add these new custom
properties immediately after the existing `--radius: 0.75rem;` line (which itself changes
to `1rem` — see Task 1.1 Step 3 below):

```css
  --glass-bg: rgba(255, 255, 255, 0.03);
  --glass-border: rgba(255, 255, 255, 0.08);
  --glass-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  --glass-shadow-hover: 0 12px 32px rgba(0, 0, 0, 0.4);
  --accent-glow: 0 0 12px rgba(59, 130, 246, 0.4);
  --severity-critical: #991b1b;
  --severity-high: #f87171;
  --severity-medium: #fbbf24;
  --severity-low: #3f3f46;
```

(The four `--severity-*` values are copied verbatim from `SeverityBadge.tsx`'s existing
`bg-[...]` literals — not new colors — so the new chart components in Chunk 2 share a
single token-based source of truth instead of a third hardcoded copy.)

- [ ] **Step 2: Register the new tokens in `@theme inline` so Tailwind generates utilities**

In the same file's `@theme inline { ... }` block, add these lines (anywhere in the block;
grouping with the other `--color-*`/`--radius-*` entries is fine):

```css
  --color-glass-bg: var(--glass-bg);
  --color-glass-border: var(--glass-border);
  --shadow-glass: var(--glass-shadow);
  --shadow-glass-hover: var(--glass-shadow-hover);
  --shadow-accent-glow: var(--accent-glow);
  --color-severity-critical: var(--severity-critical);
  --color-severity-high: var(--severity-high);
  --color-severity-medium: var(--severity-medium);
  --color-severity-low: var(--severity-low);
```

This makes `bg-glass-bg`, `border-glass-border`, `shadow-glass`, `shadow-glass-hover`,
`shadow-accent-glow`, `bg-severity-critical`, `bg-severity-high`, `bg-severity-medium`,
`bg-severity-low` all available as real Tailwind utility classes (Tailwind v4's `--color-*`
and `--shadow-*` theme namespaces auto-generate the corresponding utility class family).

- [ ] **Step 3: Bump the base radius**

Change the existing `--radius: 0.75rem;` line in `:root` to `--radius: 1rem;`. This affects
every existing consumer of the `--radius-*` scale (`rounded-lg`/`rounded-xl`/etc. used by
`Card`/`Badge`/`Button`) — this is an intentional, spec-approved wide-reaching change from
a single-line edit.

- [ ] **Step 4: Add the unlayered `.card-glass` and `.app-gradient` classes**

At the very end of `globals.css` (after the existing `@media (prefers-reduced-motion:
reduce) { ... }` block, still outside any `@layer` wrapper), add:

```css
/* Deliberately NOT inside @layer: CSS Cascade Layers give unlayered
   rules priority over every @layer-wrapped rule (including Tailwind's
   own utilities layer), regardless of source order or specificity. This
   guarantees .card-glass reliably overrides shadcn <Card>'s built-in
   bg-card/ring-1/rounded-xl utility classes instead of silently losing
   the cascade to them. border-radius is set explicitly to 1rem (16px)
   rather than relying on Card's own rounded-xl (which scales off
   --radius-xl = --radius * 1.4 = 1.4rem) so glass cards render at a
   consistent 16px regardless of which rounded-* utility a wrapped
   element happens to use. */
.card-glass {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 1rem;
  box-shadow: var(--glass-shadow);
}

/* Layered 3-stop gradient applied on top of body's existing solid
   bg-background fill (see layout.tsx) - background-image renders over
   background-color, so --background still provides a solid fallback
   (no-JS, print, or if this rule fails to load) underneath. */
.app-gradient {
  background-image: linear-gradient(180deg, #0a0a0c 0%, #050506 60%, #020203 100%);
}
```

- [ ] **Step 5: Verify the build compiles the new utilities**

Run: `npm run build`
Expected: build succeeds with no errors (Tailwind v4 resolves `@theme inline` entries into
real CSS at build time — a typo here would surface as a build-time warning/error).

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: add glass card, gradient background, and severity CSS tokens"
```

### Task 1.2: Apply the gradient background to `body`

- [ ] **Step 1: Edit `src/app/layout.tsx`**

Change:
```tsx
      <body className="min-h-full flex flex-col">{children}</body>
```
to:
```tsx
      <body className="min-h-full flex flex-col app-gradient">{children}</body>
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: 120/120 passing (this is a pure className addition — no test exercises `body`'s
class directly, so nothing should change).

- [ ] **Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat: apply layered gradient background to body"
```

### Task 1.3: Replace hardcoded hex utilities in `src/app/page.tsx`

Per the spec's exhaustive disposition list for this file:

- [ ] **Step 1: Make the replacements**

In `src/app/page.tsx`:
1. Line ~27: `<h1 className="text-2xl font-semibold text-[#FAFAFA]">` →
   `<h1 className="text-2xl font-semibold text-foreground">`
2. Line ~37 (the `Card` className template literal): replace
   `border-[#27272A] bg-[#18181B] p-4 transition-colors duration-200 ease-out
   hover:border-[#3B82F6]/40` with
   `card-glass p-4 transition-colors duration-200 ease-out hover:border-primary/40`
3. Line ~62: `focus-visible:outline-[#3B82F6]` → `focus-visible:outline-primary`
4. Line ~73: `<span className="font-medium text-[#FAFAFA]">` →
   `<span className="font-medium text-foreground">`
5. Line ~85: `<span className="h-2 w-2 animate-pulse rounded-full bg-[#3B82F6]" />` →
   `<span className="h-2 w-2 animate-pulse rounded-full bg-primary" />`

(`hover:border-primary/40`, `focus-visible:outline-primary`, and `bg-primary` are the exact
same rendered color as the literals they replace — `#3b82f6` **is** `--primary`, confirmed
in `globals.css` — this is a token-driven drive-by fix, not a new color decision.)

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: 120/120 passing — no test in this codebase asserts on these specific className
strings (existing tests only check rendered text/roles), so this should be a no-op for
tests.

- [ ] **Step 3: Manual visual check**

Run: `npm run dev`, open `http://localhost:3000`, confirm PR row cards now render with the
glass treatment (soft border, subtle shadow) and the hover/focus/pulse-dot states still
show blue, not a broken/missing color.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "refactor: replace hardcoded hex utilities with tokens on the list page"
```

### Task 1.4: Replace hardcoded hex utilities in `src/app/pr/[number]/page.tsx`

- [ ] **Step 1: Make the replacements**

In `src/app/pr/[number]/page.tsx`:
1. Line ~36: `className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground
   hover:text-[#FAFAFA]"` → replace `hover:text-[#FAFAFA]` with `hover:text-foreground`.
2. Line ~42: `<h1 className="text-2xl font-semibold text-[#FAFAFA]">` →
   `<h1 className="text-2xl font-semibold text-foreground">`
3. Lines ~77, ~91, ~98: each `Card` className `border-[#27272A] bg-[#18181B]` →
   `card-glass` (keep the rest of each className string — `flex flex-col gap-2 p-4` /
   `... opacity-80` — unchanged).
4. Line ~85: `<p className="text-sm text-[#D4D4D8]">` →
   `<p className="text-sm text-muted-foreground">`
5. Line ~106: `<details className="rounded-lg border border-[#27272A] bg-[#18181B]
   p-4">` → `<details className="card-glass p-4">`

**Explicitly kept as-is (do not touch):** the warning banner (`border-[#451A03]
bg-[#FBBF24]/10 text-[#FBBF24]`, ~line 51) and error banner (`border-[#450A0A]
bg-[#F87171]/10 text-[#F87171]`, ~line 65) — these are semantic warning/error banners
matching `PollStatusBanner.tsx`'s existing pattern, out of scope for this card/surface
restyle per the spec.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: 120/120 passing.

- [ ] **Step 3: Commit**

```bash
git add "src/app/pr/[number]/page.tsx"
git commit -m "refactor: replace hardcoded hex utilities with tokens on the detail page"
```

### Task 1.5: Replace hardcoded hex utilities in `FindingCard.tsx`

- [ ] **Step 1: Make the replacements**

In `src/app/components/FindingCard.tsx`:
1. Line ~27: `className="mb-2 rounded-lg border border-[#27272A] bg-[#18181B] p-3 pl-4"`
   → `className="mb-2 card-glass p-3 pl-4"` (drop `rounded-lg` — `.card-glass` already
   sets its own `border-radius: 1rem`).
2. Line ~31: `<strong className="text-[#FAFAFA]">` → `<strong className="text-foreground">`
3. Lines ~36, ~39, ~42: each `<p className="mt-{N} text-sm text-[#D4D4D8]">` →
   `<p className="mt-{N} text-sm text-muted-foreground">` (keep each line's own `mt-*`
   value unchanged).

**Explicitly kept as-is:** line ~45's `<pre className="mt-2 overflow-x-auto rounded
bg-[#09090B] p-2 font-mono text-xs">` — this is an intentionally-darker nested code-snippet
"well" inside the glass card, not a card surface; out of scope for this pass. The
`BORDER_COLORS` constant (lines 15-20, using the same severity hex literals for the
left-border accent) is also unchanged — it's an independent literal object unrelated to the
new `--severity-*` CSS tokens, and touching it is out of scope here.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: 120/120 passing (existing `FindingCard.test.tsx` only asserts on text content).

- [ ] **Step 3: Commit**

```bash
git add src/app/components/FindingCard.tsx
git commit -m "refactor: replace hardcoded hex utilities with tokens in FindingCard"
```

### Task 1.6: Add the accent glow to `VerdictBadge`'s approve state

- [ ] **Step 1: Write the failing test**

In `src/app/components/VerdictBadge.test.tsx`, add a new test after the existing "renders
an approve badge" test:

```tsx
  it('applies the accent glow shadow only to the approve badge', () => {
    const { container: approveContainer } = render(<VerdictBadge verdict="approve" />);
    expect(approveContainer.querySelector('.shadow-accent-glow')).toBeInTheDocument();

    const { container: needsFixContainer } = render(<VerdictBadge verdict="needs_fix" />);
    expect(needsFixContainer.querySelector('.shadow-accent-glow')).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/components/VerdictBadge.test.tsx`
Expected: FAIL — no element has class `shadow-accent-glow` yet.

- [ ] **Step 3: Implement**

In `src/app/components/VerdictBadge.tsx`, change the `approve` entry in `CLASSES`:

```ts
  approve: 'bg-gradient-to-r from-[#22C55E] to-[#16A34A] text-white border-transparent shadow-accent-glow',
```

(leave `needs_review`, `needs_fix`, `failed` unchanged — the glow is approve-only per the
spec.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/components/VerdictBadge.test.tsx`
Expected: PASS (all 5 tests, including the new one).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: 120/121 → now 121 tests total, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/app/components/VerdictBadge.tsx src/app/components/VerdictBadge.test.tsx
git commit -m "feat: add accent glow to the approve verdict badge"
```

### Task 1.7: Chunk 1 final verification

- [ ] **Step 1: Run full verification**

```bash
npm test
npm run lint
npm run build
```
Expected: 121/121 tests passing, 0 lint errors, clean build.

- [ ] **Step 2: Manual visual pass**

Run `npm run dev`, visit both the List Page and a Detail Page. Confirm: layered gradient
background is visible, all card surfaces (PR row cards, Executive Summary/Top Risks/
Medium-Low cards, `FindingCard`) show the glass treatment with no leftover flat
`#18181b` card backgrounds (the intentionally-unchanged `#09090b` code-snippet `<pre>`
well inside `FindingCard`, per Task 1.5, is expected to remain as-is and is not part of
this check), no broken/invisible text (everything that was `#FAFAFA`/`#D4D4D8` still
reads clearly), the approve verdict badge shows a subtle blue glow, and the warning/error
banners and severity/verdict badges still show their original colors unchanged.

**Chunk 1 complete.** Dispatch the plan-document-reviewer subagent for this chunk before
proceeding to Chunk 2 (see `plan-document-reviewer-prompt.md`).

---

## Chunk 2: Severity Visualization — `severitySummary.ts` + `SeveritySummaryBar` + `SeverityDonut`

**Files:**
- Create: `src/lib/severitySummary.ts`
- Test: `src/lib/severitySummary.test.ts`
- Create: `src/app/components/SeveritySummaryBar.tsx`
- Test: `src/app/components/SeveritySummaryBar.test.tsx`
- Create: `src/app/components/SeverityDonut.tsx`
- Test: `src/app/components/SeverityDonut.test.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/pr/[number]/page.tsx`

Reference: `PullRequestRow` is defined in `src/db/pullRequests.ts:15-38` with snake_case
fields `severity_critical`, `severity_high`, `severity_medium`, `severity_low`,
`last_reviewed_at`. `buildSeveritySummary` consumes this type directly (no camelCase
mapping step), mirroring `src/lib/listPageViewModel.ts`'s existing convention where
`buildListPageViewModel` takes `PullRequestRow[]` straight from `getOpenPrs()` and maps
fields internally inside itself, not at the page-component call site.

### Task 2.1: `severitySummary.ts` — pure aggregation function

- [ ] **Step 1: Write the failing tests**

Create `src/lib/severitySummary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSeveritySummary } from './severitySummary';
import type { PullRequestRow } from '../db/pullRequests';

// Minimal builder - only the fields buildSeveritySummary reads matter;
// the rest are irrelevant filler required by the PullRequestRow type.
function makeRow(overrides: Partial<PullRequestRow>): PullRequestRow {
  return {
    id: 1,
    repo: 'org/repo',
    pr_number: 1,
    title: 'title',
    author: 'author',
    branch: 'branch',
    base_branch: 'main',
    head_sha: 'abc123',
    pr_url: 'https://example.com',
    is_draft: 0,
    pr_state: 'open',
    review_status: 'done',
    verdict: 'approve',
    severity_critical: 0,
    severity_high: 0,
    severity_medium: 0,
    severity_low: 0,
    reviewed_head_sha: 'abc123',
    last_reviewed_at: '2026-07-29T00:00:00.000Z',
    last_attempted_at: '2026-07-29T00:00:00.000Z',
    raw_report_md: null,
    error_message: null,
    ...overrides,
  };
}

describe('buildSeveritySummary', () => {
  it('returns all-zero, reviewedCount 0 for an empty array', () => {
    const result = buildSeveritySummary([]);
    expect(result).toEqual({ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 0 });
  });

  it('sums severity counts across a single reviewed row', () => {
    const result = buildSeveritySummary([
      makeRow({ severity_critical: 2, severity_high: 1, severity_medium: 3, severity_low: 4 }),
    ]);
    expect(result).toEqual({ critical: 2, high: 1, medium: 3, low: 4, total: 10, reviewedCount: 1 });
  });

  it('sums severity counts across multiple reviewed rows', () => {
    const result = buildSeveritySummary([
      makeRow({ severity_critical: 1, severity_high: 0, severity_medium: 0, severity_low: 0 }),
      makeRow({ severity_critical: 1, severity_high: 2, severity_medium: 0, severity_low: 0 }),
    ]);
    expect(result).toEqual({ critical: 2, high: 2, medium: 0, low: 0, total: 4, reviewedCount: 2 });
  });

  it('excludes a row with last_reviewed_at: null from both the sums and reviewedCount', () => {
    const result = buildSeveritySummary([
      makeRow({ last_reviewed_at: null, severity_critical: 9, severity_high: 9, severity_medium: 9, severity_low: 9 }),
      makeRow({ severity_critical: 1, severity_high: 0, severity_medium: 0, severity_low: 0 }),
    ]);
    expect(result).toEqual({ critical: 1, high: 0, medium: 0, low: 0, total: 1, reviewedCount: 1 });
  });

  it('reports reviewedCount 0 when no row has ever completed a review ("no reviewed data yet")', () => {
    const result = buildSeveritySummary([makeRow({ last_reviewed_at: null })]);
    expect(result.reviewedCount).toBe(0);
    expect(result.total).toBe(0);
  });

  it('reports reviewedCount > 0 with total 0 when reviewed rows have zero findings ("reviewed, and clean")', () => {
    const result = buildSeveritySummary([makeRow({})]);
    expect(result.reviewedCount).toBe(1);
    expect(result.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/severitySummary.test.ts`
Expected: FAIL with "Cannot find module './severitySummary'" (the module doesn't exist
yet).

- [ ] **Step 3: Implement**

Create `src/lib/severitySummary.ts`:

```ts
import type { PullRequestRow } from '../db/pullRequests';

export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** Sum of the four buckets above - for percentage math. 0 is a valid,
   * expected value; see reviewedCount for how to distinguish "no
   * reviewed data yet" from "reviewed, and clean". */
  total: number;
  /** Count of input rows with last_reviewed_at !== null (i.e. rows that
   * have ever completed a real review). Used by SeveritySummaryBar/
   * SeverityDonut to pick the correct zero-state copy: reviewedCount
   * === 0 means "no reviewed data yet"; reviewedCount > 0 with total
   * === 0 means every reviewed PR was clean. */
  reviewedCount: number;
}

// Takes raw PullRequestRow[] directly (snake_case DB fields), matching
// the existing convention in listPageViewModel.ts, where buildListPageViewModel
// takes PullRequestRow[] straight from getOpenPrs() and maps fields
// internally rather than requiring an intermediate camelCase type.
export function buildSeveritySummary(rows: PullRequestRow[]): SeveritySummary {
  const reviewed = rows.filter((row) => row.last_reviewed_at !== null);

  const summary = reviewed.reduce(
    (acc, row) => ({
      critical: acc.critical + row.severity_critical,
      high: acc.high + row.severity_high,
      medium: acc.medium + row.severity_medium,
      low: acc.low + row.severity_low,
    }),
    { critical: 0, high: 0, medium: 0, low: 0 }
  );

  return {
    ...summary,
    total: summary.critical + summary.high + summary.medium + summary.low,
    reviewedCount: reviewed.length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/severitySummary.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/severitySummary.ts src/lib/severitySummary.test.ts
git commit -m "feat: add buildSeveritySummary pure aggregation function"
```

### Task 2.2: `SeveritySummaryBar` component (List Page aggregate bar)

- [ ] **Step 1: Write the failing tests**

Create `src/app/components/SeveritySummaryBar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeveritySummaryBar } from './SeveritySummaryBar';

describe('SeveritySummaryBar', () => {
  it('shows the per-severity legend counts for a populated summary', () => {
    render(
      <SeveritySummaryBar summary={{ critical: 3, high: 5, medium: 8, low: 4, total: 20, reviewedCount: 6 }} />
    );
    expect(screen.getByText(/critical 3/i)).toBeInTheDocument();
    expect(screen.getByText(/high 5/i)).toBeInTheDocument();
    expect(screen.getByText(/medium 8/i)).toBeInTheDocument();
    expect(screen.getByText(/low 4/i)).toBeInTheDocument();
  });

  it('renders each segment with a flex-basis proportional to its share of the total', () => {
    const { container } = render(
      <SeveritySummaryBar summary={{ critical: 5, high: 5, medium: 5, low: 5, total: 20, reviewedCount: 4 }} />
    );
    const critical = container.querySelector('[data-testid="severity-segment-critical"]') as HTMLElement;
    const high = container.querySelector('[data-testid="severity-segment-high"]') as HTMLElement;
    expect(critical.style.flexBasis).toBe('25%');
    expect(high.style.flexBasis).toBe('25%');
  });

  it('omits a segment entirely when its count is 0', () => {
    const { container } = render(
      <SeveritySummaryBar summary={{ critical: 0, high: 10, medium: 0, low: 0, total: 10, reviewedCount: 1 }} />
    );
    expect(container.querySelector('[data-testid="severity-segment-critical"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="severity-segment-high"]')).toBeInTheDocument();
  });

  it('shows "No reviewed data yet" when reviewedCount is 0', () => {
    render(<SeveritySummaryBar summary={{ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 0 }} />);
    expect(screen.getByText(/no reviewed data yet/i)).toBeInTheDocument();
  });

  it('shows a clean-result message when reviewedCount is positive but total is 0', () => {
    render(<SeveritySummaryBar summary={{ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 3 }} />);
    expect(screen.getByText(/no findings across 3 reviewed prs/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/components/SeveritySummaryBar.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/app/components/SeveritySummaryBar.tsx`:

```tsx
import type { SeveritySummary } from '../../lib/severitySummary';

export function SeveritySummaryBar({ summary }: { summary: SeveritySummary }) {
  if (summary.total === 0) {
    return (
      <div className="card-glass flex flex-col gap-1 p-3">
        <div className="h-2 w-full rounded-full bg-muted" />
        <p className="text-xs text-muted-foreground">
          {summary.reviewedCount === 0
            ? 'No reviewed data yet'
            : `No findings across ${summary.reviewedCount} reviewed PRs`}
        </p>
      </div>
    );
  }

  const segments: Array<{ key: string; label: string; count: number; colorClass: string }> = [
    { key: 'critical', label: 'Critical', count: summary.critical, colorClass: 'bg-severity-critical' },
    { key: 'high', label: 'High', count: summary.high, colorClass: 'bg-severity-high' },
    { key: 'medium', label: 'Medium', count: summary.medium, colorClass: 'bg-severity-medium' },
    { key: 'low', label: 'Low', count: summary.low, colorClass: 'bg-severity-low' },
  ];

  return (
    <div className="card-glass flex flex-col gap-2 p-3">
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <div
              key={segment.key}
              data-testid={`severity-segment-${segment.key}`}
              className={segment.colorClass}
              style={{ flexBasis: `${(segment.count / summary.total) * 100}%` }}
            />
          ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {segments.map((segment) => `${segment.label} ${segment.count}`).join(' · ')}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/components/SeveritySummaryBar.test.tsx`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/app/components/SeveritySummaryBar.tsx src/app/components/SeveritySummaryBar.test.tsx
git commit -m "feat: add SeveritySummaryBar component"
```

### Task 2.3: `SeverityDonut` component (Detail Page per-PR donut)

- [ ] **Step 1: Write the failing tests**

Create `src/app/components/SeverityDonut.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityDonut } from './SeverityDonut';

describe('SeverityDonut', () => {
  it('renders a conic-gradient ring reflecting the given proportions', () => {
    const { container } = render(
      <SeverityDonut summary={{ critical: 1, high: 1, medium: 1, low: 1, total: 4, reviewedCount: 1 }} />
    );
    const ring = container.querySelector('[data-testid="severity-donut-ring"]') as HTMLElement;
    expect(ring.style.backgroundImage).toContain('conic-gradient');
  });

  it('computes cumulative degree stops in Critical -> High -> Medium -> Low order', () => {
    // 4 equal quarters of 360deg: 0-90, 90-180, 180-270, 270-360.
    const { container } = render(
      <SeverityDonut summary={{ critical: 1, high: 1, medium: 1, low: 1, total: 4, reviewedCount: 1 }} />
    );
    const ring = container.querySelector('[data-testid="severity-donut-ring"]') as HTMLElement;
    const gradient = ring.style.backgroundImage;
    expect(gradient).toContain('var(--severity-critical) 0deg 90deg');
    expect(gradient).toContain('var(--severity-high) 90deg 180deg');
    expect(gradient).toContain('var(--severity-medium) 180deg 270deg');
    expect(gradient).toContain('var(--severity-low) 270deg 360deg');
  });

  it('skips a zero-count severity segment entirely rather than emitting a 0deg-wide stop', () => {
    // critical=0 (skipped), high=10 (0-360deg, the only segment).
    const { container } = render(
      <SeverityDonut summary={{ critical: 0, high: 10, medium: 0, low: 0, total: 10, reviewedCount: 1 }} />
    );
    const ring = container.querySelector('[data-testid="severity-donut-ring"]') as HTMLElement;
    const gradient = ring.style.backgroundImage;
    expect(gradient).not.toContain('var(--severity-critical)');
    expect(gradient).toContain('var(--severity-high) 0deg 360deg');
  });

  it('shows "Not yet reviewed" in the center when reviewedCount is 0', () => {
    render(<SeverityDonut summary={{ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 0 }} />);
    expect(screen.getByText(/not yet reviewed/i)).toBeInTheDocument();
  });

  it('shows "0 findings" in the center when reviewedCount is 1 but total is 0', () => {
    render(<SeverityDonut summary={{ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 1 }} />);
    expect(screen.getByText(/0 findings/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/components/SeverityDonut.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/app/components/SeverityDonut.tsx`:

```tsx
import type { SeveritySummary } from '../../lib/severitySummary';

function buildConicGradient(summary: SeveritySummary): string {
  const stops: Array<{ colorVar: string; count: number }> = [
    { colorVar: 'var(--severity-critical)', count: summary.critical },
    { colorVar: 'var(--severity-high)', count: summary.high },
    { colorVar: 'var(--severity-medium)', count: summary.medium },
    { colorVar: 'var(--severity-low)', count: summary.low },
  ];

  let cumulativeDeg = 0;
  const segments = stops
    .filter((stop) => stop.count > 0)
    .map((stop) => {
      const startDeg = cumulativeDeg;
      cumulativeDeg += (stop.count / summary.total) * 360;
      return `${stop.colorVar} ${startDeg}deg ${cumulativeDeg}deg`;
    });

  return `conic-gradient(${segments.join(', ')})`;
}

export function SeverityDonut({ summary }: { summary: SeveritySummary }) {
  const centerLabel = summary.reviewedCount === 0 ? 'Not yet reviewed' : summary.total === 0 ? '0 findings' : null;

  return (
    <div className="relative flex h-24 w-24 items-center justify-center">
      <div
        data-testid="severity-donut-ring"
        className="absolute inset-0 rounded-full"
        style={{
          backgroundImage: summary.total > 0 ? buildConicGradient(summary) : undefined,
          backgroundColor: summary.total === 0 ? 'var(--muted)' : undefined,
        }}
      />
      <div className="app-gradient absolute inset-3 rounded-full" />
      <span className="relative z-10 text-center text-xs text-muted-foreground">
        {centerLabel ?? `${summary.total} findings`}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/components/SeverityDonut.test.tsx`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/app/components/SeverityDonut.tsx src/app/components/SeverityDonut.test.tsx
git commit -m "feat: add SeverityDonut component"
```

### Task 2.4: Wire `SeveritySummaryBar` into the List Page

- [ ] **Step 1: Edit `src/app/page.tsx`**

Add the import. At the top of the file, add:

```tsx
import { buildSeveritySummary } from '../lib/severitySummary';
import { SeveritySummaryBar } from './components/SeveritySummaryBar';
```

Inside `ListPage()`, the existing code calls `getOpenPrs(db, repo)` inline as a
`buildListPageViewModel({ ..., prs: getOpenPrs(db, repo) })` argument. Pull that call out
into its own variable first so both `buildListPageViewModel` and the new
`buildSeveritySummary` reuse the same query result instead of hitting the DB twice:

```tsx
  const openPrs = getOpenPrs(db, repo);
  const vm = buildListPageViewModel({
    repo,
    lastPollAt: getConfig(db, 'last_poll_at') ?? null,
    lastPollStatus: (getConfig(db, 'last_poll_status') as 'ok' | 'error' | undefined) ?? null,
    lastPollError: getConfig(db, 'last_poll_error') ?? null,
    prs: openPrs,
  });
  const severitySummary = buildSeveritySummary(openPrs);
```

In the JSX, render the bar right after the `<PollStatusBanner .../>` line (still inside the
existing `<div>` wrapping the heading/banner, or directly after that `<div>` — either is
fine as long as it appears above the PR row list):

```tsx
      <SeveritySummaryBar summary={severitySummary} />
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: still all passing (no existing test renders `ListPage` directly, so this can't
regress an existing test — this is a purely additive composition change).

- [ ] **Step 3: Manual visual check**

Run `npm run dev`, load the List Page, confirm the severity bar renders above the PR list
with either real data or the correct zero-state message.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: wire SeveritySummaryBar into the list page"
```

### Task 2.5: Wire `SeverityDonut` into the Detail Page

- [ ] **Step 1: Edit `src/app/pr/[number]/page.tsx`**

Add the import:

```tsx
import { buildSeveritySummary } from '../../../lib/severitySummary';
import { SeverityDonut } from '../../components/SeverityDonut';
```

`pr` (the raw `PullRequestRow` from `getByNumber`) is already in scope. After the existing
`const isInProgress = ...` line, add:

```tsx
  const severitySummary = buildSeveritySummary([pr]);
```

In the JSX, render the donut only when the PR has completed at least one review (mirrors
the existing `hasPriorSuccess` signal used elsewhere) — add it inside the existing
`{vm.state !== 'failed-no-prior-success' && ( <> ... </> )}` block, as the first child,
guarded by `pr.last_reviewed_at !== null`:

```tsx
          {pr.last_reviewed_at !== null && (
            <div className="flex justify-center">
              <SeverityDonut summary={severitySummary} />
            </div>
          )}
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: still all passing.

- [ ] **Step 3: Manual visual check**

Run `npm run dev`, open a reviewed PR's Detail Page — confirm the donut renders with the
correct proportions/center label, and that a PR still awaiting its first review does not
render the donut at all (falls through to the existing pending/in-progress UI).

- [ ] **Step 4: Commit**

```bash
git add "src/app/pr/[number]/page.tsx"
git commit -m "feat: wire SeverityDonut into the detail page"
```

### Task 2.6: Chunk 2 final verification

- [ ] **Step 1: Run full verification**

```bash
npm test
npm run lint
npm run build
```
Expected: 137/137 tests passing (121 from Chunk 1 + 6 `severitySummary.test.ts` + 5
`SeveritySummaryBar.test.tsx` + 5 `SeverityDonut.test.tsx` = 137), 0 lint errors, clean
build.

**Chunk 2 complete.** Dispatch the plan-document-reviewer subagent for this chunk before
proceeding to Chunk 3.

---

## Chunk 3: Motion System — GSAP hover-lift + stagger reveal

**Files:**
- Modify: `package.json` (new `gsap` dependency)
- Create: `src/app/components/HoverLiftCard.tsx`
- Test: `src/app/components/HoverLiftCard.test.tsx`
- Create: `src/app/components/StaggerReveal.tsx`
- Test: `src/app/components/StaggerReveal.test.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/pr/[number]/page.tsx`

### Task 3.1: Add the `gsap` dependency

- [ ] **Step 1: Install**

Run: `npm install gsap@^3.15.0`
Expected: `package.json`/`package-lock.json` updated with the new dependency; no errors.

- [ ] **Step 2: Verify the app still builds**

Run: `npm run build`
Expected: clean build (adding an unused dependency shouldn't break anything, but confirm
before building on top of it).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add gsap dependency for hover-lift and stagger-reveal motion"
```

### Task 3.2: `HoverLiftCard` client component

**Reduced-motion + tween correctness note:** GSAP tweens are JS-driven
(`requestAnimationFrame`), not CSS transitions, so they are **not** covered by
`globals.css`'s existing `@media (prefers-reduced-motion: reduce)` rule — both new
components must check `window.matchMedia('(prefers-reduced-motion: reduce)').matches`
themselves. Also: GSAP's `boxShadow` tween needs a **literal, interpolatable shadow
string** (e.g. `"0 8px 24px rgba(0, 0, 0, 0.3)"`) on each end of the tween — passing a raw
`"var(--glass-shadow)"` string would not animate, since GSAP does not resolve CSS custom
properties before parsing a value for interpolation, it would just set that literal
(non-animatable) string as the inline style. The literals below are copied verbatim from
`globals.css`'s `--glass-shadow`/`--glass-shadow-hover` values — keep them in sync if
either changes.

- [ ] **Step 1: Write the failing tests**

Create `src/app/components/HoverLiftCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HoverLiftCard } from './HoverLiftCard';

const quickToMock = vi.fn(() => vi.fn());

vi.mock('gsap', () => ({
  gsap: {
    quickTo: (...args: unknown[]) => quickToMock(...args),
  },
}));

function mockMatchMedia(reduceMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduceMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('HoverLiftCard', () => {
  beforeEach(() => {
    quickToMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its children', () => {
    mockMatchMedia(false);
    render(
      <HoverLiftCard>
        <div>card content</div>
      </HoverLiftCard>
    );
    expect(screen.getByText('card content')).toBeInTheDocument();
  });

  it('sets up quickTo tweens for y and boxShadow with the documented duration/ease', () => {
    mockMatchMedia(false);
    render(
      <HoverLiftCard>
        <div>card content</div>
      </HoverLiftCard>
    );
    const yCall = quickToMock.mock.calls.find((call) => call[1] === 'y');
    const shadowCall = quickToMock.mock.calls.find((call) => call[1] === 'boxShadow');
    expect(yCall?.[2]).toMatchObject({ duration: 0.25, ease: 'power2.out' });
    expect(shadowCall?.[2]).toMatchObject({ duration: 0.25, ease: 'power2.out' });
  });

  it('does not call gsap.quickTo when prefers-reduced-motion is set', () => {
    mockMatchMedia(true);
    render(
      <HoverLiftCard>
        <div>card content</div>
      </HoverLiftCard>
    );
    expect(quickToMock).not.toHaveBeenCalled();
  });

  it('tweens to the lifted position and hover+glow shadow on mouseenter, and back to resting on mouseleave', () => {
    mockMatchMedia(false);
    const setY = vi.fn();
    const setShadow = vi.fn();
    quickToMock.mockImplementation((_el: unknown, prop: string) => (prop === 'y' ? setY : setShadow));
    render(
      <HoverLiftCard>
        <div>card content</div>
      </HoverLiftCard>
    );
    const wrapper = screen.getByText('card content').parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(setY).toHaveBeenCalledWith(-4);
    expect(setShadow).toHaveBeenCalledWith('0 12px 32px rgba(0, 0, 0, 0.4), 0 0 12px rgba(59, 130, 246, 0.4)');

    fireEvent.mouseLeave(wrapper);
    expect(setY).toHaveBeenCalledWith(0);
    expect(setShadow).toHaveBeenCalledWith('0 8px 24px rgba(0, 0, 0, 0.3)');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/components/HoverLiftCard.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/app/components/HoverLiftCard.tsx`:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

// Literal shadow strings mirroring globals.css's --glass-shadow /
// --glass-shadow-hover / --accent-glow values - kept as plain strings
// (not var(...)) because gsap needs concrete, interpolatable box-shadow
// values on both ends of the tween. HOVER_SHADOW layers the accent glow
// (spec: "a subtle accent glow ... to HoverLiftCard's hover box-shadow")
// as a second comma-separated shadow alongside the lifted glass shadow.
// Keep these in sync if globals.css's corresponding tokens change.
const RESTING_SHADOW = '0 8px 24px rgba(0, 0, 0, 0.3)';
const HOVER_SHADOW = '0 12px 32px rgba(0, 0, 0, 0.4), 0 0 12px rgba(59, 130, 246, 0.4)';

export function HoverLiftCard({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const setY = gsap.quickTo(el, 'y', { duration: 0.25, ease: 'power2.out' });
    const setShadow = gsap.quickTo(el, 'boxShadow', { duration: 0.25, ease: 'power2.out' });

    const handleEnter = () => {
      setY(-4);
      setShadow(HOVER_SHADOW);
    };
    const handleLeave = () => {
      setY(0);
      setShadow(RESTING_SHADOW);
    };

    el.addEventListener('mouseenter', handleEnter);
    el.addEventListener('mouseleave', handleLeave);
    return () => {
      el.removeEventListener('mouseenter', handleEnter);
      el.removeEventListener('mouseleave', handleLeave);
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/components/HoverLiftCard.test.tsx`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/app/components/HoverLiftCard.tsx src/app/components/HoverLiftCard.test.tsx
git commit -m "feat: add HoverLiftCard motion wrapper component"
```

### Task 3.3: `StaggerReveal` client component

- [ ] **Step 1: Write the failing tests**

Create `src/app/components/StaggerReveal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StaggerReveal } from './StaggerReveal';

const fromMock = vi.fn();

vi.mock('gsap', () => ({
  gsap: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

function mockMatchMedia(reduceMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduceMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('StaggerReveal', () => {
  beforeEach(() => {
    fromMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all children', () => {
    mockMatchMedia(false);
    render(
      <StaggerReveal>
        <div>first</div>
        <div>second</div>
      </StaggerReveal>
    );
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('calls gsap.from with the documented tween parameters when motion is allowed', () => {
    mockMatchMedia(false);
    render(
      <StaggerReveal>
        <div>first</div>
        <div>second</div>
      </StaggerReveal>
    );
    expect(fromMock).toHaveBeenCalledTimes(1);
    const [, vars] = fromMock.mock.calls[0];
    expect(vars).toMatchObject({ opacity: 0, y: 8, duration: 0.35, ease: 'power1.out', stagger: 0.05 });
  });

  it('does not call gsap.from when prefers-reduced-motion is set', () => {
    mockMatchMedia(true);
    render(
      <StaggerReveal>
        <div>first</div>
      </StaggerReveal>
    );
    expect(fromMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/components/StaggerReveal.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/app/components/StaggerReveal.tsx`:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

export function StaggerReveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.from(el.children, { opacity: 0, y: 8, duration: 0.35, ease: 'power1.out', stagger: 0.05 });
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/components/StaggerReveal.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/app/components/StaggerReveal.tsx src/app/components/StaggerReveal.test.tsx
git commit -m "feat: add StaggerReveal motion wrapper component"
```

### Task 3.4: Wrap List Page cards with `HoverLiftCard` + `StaggerReveal`

**Overlay-pattern safety note:** `page.tsx`'s existing PR row `Card` uses a full-card
clickable-overlay pattern (an absolutely-positioned `z-0` `Link`, a `pointer-events-none
z-[1]` content wrapper, and `RecheckButton` in its own `z-10 pointer-events-auto`
container — see the long code comment already in `page.tsx` above the `<Link>`).
`HoverLiftCard` must wrap the **entire** `Card` (so the overlay Link/content
wrapper/RecheckButton all stay inside it, in their existing relative stacking order) and
must **not** set its own `position`, `z-index`, or `pointer-events` styles that would
shift that stack — it only sets `transform`/`box-shadow` via GSAP, which don't interfere
with click routing.

- [ ] **Step 1: Edit `src/app/page.tsx`**

Add the imports:

```tsx
import { HoverLiftCard } from './components/HoverLiftCard';
import { StaggerReveal } from './components/StaggerReveal';
```

Wrap the `<div className="flex flex-col gap-2.5">{vm.rows.map(...)}</div>` block's
children: change

```tsx
      <div className="flex flex-col gap-2.5">
        {vm.rows.map((row) => (
          <Card
            key={row.prNumber}
            ...
```

to:

```tsx
      <StaggerReveal className="flex flex-col gap-2.5">
        {vm.rows.map((row) => (
          <HoverLiftCard key={row.prNumber}>
            <Card
              ...
```

and close both new wrappers at the end (replacing the closing `</Card>` / `</div>` pair):

```tsx
            </Card>
          </HoverLiftCard>
        ))}
      </StaggerReveal>
```

(Move the `key={row.prNumber}` prop from `Card` to the new outer `HoverLiftCard` — a
single `key` per mapped element, now on the outermost element of each iteration.)

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all passing (no test renders `ListPage`, so nothing to regress directly).

- [ ] **Step 3: Manual click-through verification (per the spec's explicit requirement)**

Run `npm run dev`, open the List Page, and manually verify:
1. Clicking anywhere on a PR row card (title, branch text, empty space) navigates to that
   PR's Detail Page.
2. The card is reachable and activatable via keyboard (Tab to focus, Enter to navigate).
3. Clicking "Re-check now" triggers the recheck action *without* also navigating to the
   Detail Page (the two click targets remain independent).
4. Hovering a card shows the 4px lift + shadow boost; cards fade/rise in on page load.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: wrap list page cards with HoverLiftCard and StaggerReveal"
```

### Task 3.5: Wrap Detail Page cards with `HoverLiftCard`

- [ ] **Step 1: Edit `src/app/pr/[number]/page.tsx`**

Add the import:

```tsx
import { HoverLiftCard } from '../../components/HoverLiftCard';
```

Wrap each of the three plain `<Card className="card-glass ...">` elements — the
Executive Summary, Top Risks, and Medium/Low cards created in Chunk 1's Task 1.4 (their
className is `card-glass` post-Chunk-1, replacing the original `border-[#27272A]
bg-[#18181B]` literal) — **not** the failure/error banners, and **not** the `<details>`
raw-report block, which stay unwrapped since they aren't part of the approved-mockup's
hover-lift set) individually:

```tsx
          <HoverLiftCard>
            <Card className="flex flex-col gap-2 card-glass p-4">
              ...
            </Card>
          </HoverLiftCard>
```

Repeat for the "Top Risks" and "Medium/Low" cards (the `opacity-80` modifier on the
Medium/Low card stays on the `Card` itself, unaffected by the new wrapper).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all passing.

- [ ] **Step 3: Manual visual check**

Run `npm run dev`, open a Detail Page, confirm each of the three main cards lifts on
hover and no layout/scroll issues were introduced.

- [ ] **Step 4: Commit**

```bash
git add "src/app/pr/[number]/page.tsx"
git commit -m "feat: wrap detail page cards with HoverLiftCard"
```

### Task 3.6: Chunk 3 final verification

- [ ] **Step 1: Run full verification**

```bash
npm test
npm run lint
npm run build
```
Expected: all tests passing (Chunk 2's total + 4 `HoverLiftCard` + 3 `StaggerReveal` new
tests), 0 lint errors, clean build.

- [ ] **Step 2: Full manual pass**

Run `npm run dev`. Walk through: List Page (gradient background, glass cards, severity
bar, hover-lift, stagger-in-on-load, full click-through still works, RecheckButton still
independently clickable) and Detail Page (glass cards, hover-lift, severity donut showing
correctly for a reviewed PR, no donut for a not-yet-reviewed PR, failure/error banners
unchanged, raw report `<details>` unchanged).

- [ ] **Step 3: Test with OS-level reduced motion enabled**

On macOS: System Settings → Accessibility → Display → Reduce Motion → on. Reload the app
and confirm hover-lift and stagger-reveal are both skipped (no animation, but layout and
click-through remain correct) — this is the one behavior that can't be verified by the
jsdom-based unit tests (jsdom's `matchMedia` mock doesn't reflect real OS settings), so it
needs this manual check.

**Chunk 3 complete.** Dispatch the plan-document-reviewer subagent for this final chunk.
Once approved, this plan is fully implemented — proceed to
`superpowers:finishing-a-development-branch` for merge/PR decisions.
