# Review Triggers Confirmation, List Page Animation Fix, and PR Status Tracking — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the GSAP list-page fade-in animation freezing on back-navigation, and add merged/closed PR status tracking (3-day retention with badges) to pr-review-dashboard.

**Architecture:** (1) Harden `StaggerReveal`'s one-shot GSAP entrance animation with unmount cleanup + a safety-net timer so it can never leave cards permanently stuck at low opacity. (2) Extend the SQLite schema with a `closed_at` column and widen `pr_state` to include `'merged'`; the poller resolves a PR's real final state via a new `gh pr view` helper when it disappears from the open list, and a retention sweep hard-deletes rows 3+ days past closure. (3) Thread the new `pr_state`/`closed_at` data through the list/detail view models and UI so merged/closed PRs render with a distinct badge, reduced opacity, and no "Re-check now" button, while never appearing as "in progress" even if a stale `pending` status lingers.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, better-sqlite3, GSAP, Vitest, Tailwind CSS v4 + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-07-29-review-triggers-animation-fix-pr-status-design.md`

---

## Chunk 1: Fix the StaggerReveal animation freeze

### Task 1: Add cleanup + safety-net timer to `StaggerReveal`

**Files:**
- Modify: `src/app/components/StaggerReveal.tsx`
- Test: `src/app/components/StaggerReveal.test.tsx` (this file already exists — read it first; do not assume no tests exist)

- [ ] **Step 1: Read the current implementation and existing test file**

Run: `cat src/app/components/StaggerReveal.tsx src/app/components/StaggerReveal.test.tsx`

Confirm current `StaggerReveal.tsx` content matches:

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

If it differs, stop and re-read the file before proceeding — the diff below assumes this exact content.

The existing test file mocks `gsap` as `{ gsap: { from: (...args) => fromMock(...args) } }`,
where `fromMock` returns `undefined`. The implementation change in this
task calls `.kill()` on the return value of `gsap.from(...)` and also
calls `gsap.set(...)`, so the mock must be updated first (Step 2) or the
existing passing tests will break and the new tests can't express
"kill was called" at all.

- [ ] **Step 2: Update the test file's gsap mock, then add failing tests for cleanup + safety-net behavior**

Replace the top of `src/app/components/StaggerReveal.test.tsx` (imports and
mock setup) with:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StaggerReveal } from './StaggerReveal';

const fromMock = vi.fn();
const killMock = vi.fn();
const setMock = vi.fn();

vi.mock('gsap', () => ({
  gsap: {
    from: (...args: unknown[]) => {
      fromMock(...args);
      return { kill: killMock };
    },
    set: (...args: unknown[]) => setMock(...args),
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
    killMock.mockClear();
    setMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
```

(Keep the three existing `it(...)` blocks — "renders all children", "calls
gsap.from with the documented tween parameters...", and "does not call
gsap.from when prefers-reduced-motion is set" — unchanged below this;
only the imports/mock setup and `beforeEach` above them are being
replaced.)

Then add two new tests, using fake timers for the safety-net one:

```tsx
  it('kills the tween and clears inline styles on unmount', () => {
    mockMatchMedia(false);
    const { unmount } = render(
      <StaggerReveal>
        <div>first</div>
        <div>second</div>
      </StaggerReveal>
    );
    setMock.mockClear(); // ignore any calls made synchronously during mount, if any
    unmount();
    expect(killMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(expect.anything(), { clearProps: 'opacity,transform' });
  });

  it('force-clears inline styles via the safety-net timer if the tween never unmounts or completes', () => {
    vi.useFakeTimers();
    mockMatchMedia(false);
    render(
      <StaggerReveal>
        <div>first</div>
        <div>second</div>
      </StaggerReveal>
    );
    setMock.mockClear();
    expect(setMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // well past the ~0.55s safety-net delay for 2 children

    expect(setMock).toHaveBeenCalledWith(expect.anything(), { clearProps: 'opacity,transform' });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3: Run tests to verify the two new ones fail (and the mock update alone doesn't break the existing three)**

Run: `npm test -- StaggerReveal.test.ts`
Expected: the 3 pre-existing tests still PASS (the mock change is
backward-compatible with them), and the 2 new tests FAIL — `killMock`/
`setMock` are never called because the implementation doesn't call
`.kill()` or `gsap.set(...)` yet.

- [ ] **Step 4: Implement the cleanup + safety-net fix**

Replace the effect body in `src/app/components/StaggerReveal.tsx` with a
version that (a) kills the tween and clears its inline styles when the
component unmounts, and (b) force-clears those same styles via a fallback
timer shortly after the animation's total duration, in case something
else freezes the tween before its own `onComplete` fires:

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

    const targets = el.children;
    const tween = gsap.from(targets, { opacity: 0, y: 8, duration: 0.35, ease: 'power1.out', stagger: 0.05 });

    // Safety net: if some external interruption (e.g. an in-flight
    // client-side navigation) freezes this tween mid-flight before its
    // own onComplete ever fires, force the natural resting styles after
    // slightly longer than the tween's total duration (0.35s base +
    // 0.05s per staggered child, plus margin) so cards can never be left
    // stuck at a low, barely-visible opacity indefinitely.
    const maxStaggerDelay = Math.max(0, targets.length - 1) * 0.05;
    const safetyNetMs = (0.35 + maxStaggerDelay + 0.2) * 1000;
    const safetyNetId = setTimeout(() => {
      gsap.set(targets, { clearProps: 'opacity,transform' });
    }, safetyNetMs);

    return () => {
      clearTimeout(safetyNetId);
      // Kill the tween and immediately restore natural styles on
      // unmount, so an interrupted animation never leaves stale partial
      // opacity/transform inline styles behind for whatever renders
      // next (see spec section 2 for the observed bug this prevents).
      tween.kill();
      gsap.set(targets, { clearProps: 'opacity,transform' });
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they all pass**

Run: `npm test -- StaggerReveal.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 6: Lint and type-check**

Run: `npm run lint`
Expected: no new errors in `StaggerReveal.tsx` or its test file.

Run: `npx tsc --noEmit`
Expected: no new type errors. (`tsc --noEmit` is not a defined `npm run`
script in this project's `package.json`, but is valid to invoke directly
via `npx` since `typescript` is a dependency.)

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS (this change should not affect any other test file).

- [ ] **Step 8: Manual verification**

Run: `npm run dev`

In a browser: open the list page, immediately click into a PR detail page
before the stagger animation finishes (within ~0.5s of the list page
loading), then click "Back to list" immediately. Confirm the cards render
at full opacity (no lingering faint/invisible cards). Repeat a few times
to be confident the freeze no longer reproduces.

- [ ] **Step 9: Commit**

```bash
git add src/app/components/StaggerReveal.tsx src/app/components/StaggerReveal.test.tsx
git commit -m "fix: prevent StaggerReveal fade-in animation from freezing on interrupted navigation

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Chunk 2: Schema migration + `gh pr view` helper

### Task 2: Add `closed_at` column and a shared DB migration helper

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/client.ts`
- Test: `src/db/client.test.ts`

- [ ] **Step 1: Read the existing test file to match conventions**

Run: `cat src/db/client.test.ts`

Note its existing style: plain `describe('createTestDb', ...)` block,
`import { createTestDb } from './client'`, raw `db.prepare(...).all()`
calls cast to typed shapes inline. Match this exactly — no new imports
of `better-sqlite3`'s `Database` type are needed for these tests.

- [ ] **Step 2: Write the failing tests**

Add to `src/db/client.test.ts`, inside the existing `describe('createTestDb', ...)`
block, plus a new `describe` block for the migration helper applied to a
database that predates the `closed_at` column (simulating a real existing
production DB, not just a freshly-created one — this is the case the
migration actually exists to handle). Replace the top of the file's
imports with:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, runMigrations } from './client';
```

Then add:

```ts
  it('createTestDb() includes the closed_at column on pull_requests', () => {
    const db = createTestDb();
    const columns = db.prepare('PRAGMA table_info(pull_requests)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('closed_at');
  });
});

describe('runMigrations', () => {
  it('adds the closed_at column to a pre-existing database that does not have it yet', () => {
    // Build a DB the old way: schema.sql's CREATE TABLE IF NOT EXISTS,
    // but with the closed_at line manually stripped out first, so this
    // truly simulates an existing production DB from before this column
    // was introduced (calling createTestDb() here would not exercise
    // this at all, since it already includes the column from schema.sql).
    const schemaSql = fs
      .readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf-8')
      .replace(/\s*closed_at TEXT,\n/, '\n');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schemaSql);

    const beforeColumns = db.prepare('PRAGMA table_info(pull_requests)').all() as { name: string }[];
    expect(beforeColumns.map((c) => c.name)).not.toContain('closed_at');

    runMigrations(db);

    const afterColumns = db.prepare('PRAGMA table_info(pull_requests)').all() as { name: string }[];
    expect(afterColumns.map((c) => c.name)).toContain('closed_at');
  });

  it('is idempotent: running it twice on the same database does not throw', () => {
    const db = createTestDb(); // already has closed_at via schema.sql
    expect(() => {
      runMigrations(db);
      runMigrations(db);
    }).not.toThrow();
  });
```

This requires exporting `runMigrations` from `src/db/client.ts` (added in
Step 5 below) — already reflected in the import line above.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- client.test.ts`
Expected: FAIL — `closed_at` column doesn't exist yet in `schema.sql`, and
`runMigrations` isn't exported yet.

- [ ] **Step 4: Add the column to the base schema**

In `src/db/schema.sql`, add `closed_at TEXT` to the `pull_requests` table
(right after `error_message TEXT,` is a reasonable spot, before the
`UNIQUE(repo, pr_number)` line):

```sql
  raw_report_md TEXT,
  error_message TEXT,
  closed_at TEXT,
  UNIQUE(repo, pr_number)
```

This covers brand-new databases (schema is applied via
`CREATE TABLE IF NOT EXISTS`, which does nothing for already-existing
tables — see Step 5 for the migration that covers those).

- [ ] **Step 5: Add an idempotent, exported migration helper**

In `src/db/client.ts`, add an exported `runMigrations` helper and call it
from both `getDb()` and `createTestDb()` (both currently call
`db.exec(readSchema())` directly and nothing else — this migration must
run in both places so production and test databases stay consistent):

```ts
// Runs any schema changes not expressible via `CREATE TABLE IF NOT
// EXISTS` (i.e. new columns on an already-existing table), so an
// existing production database created before this column existed still
// gets it, without losing any data. Checked via PRAGMA table_info rather
// than a version table, since the ALTER TABLE itself is naturally
// idempotent-safe to guard this way for a single-column addition.
// Exported so it's independently testable against a hand-built
// pre-migration database (see client.test.ts).
export function runMigrations(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(pull_requests)').all() as { name: string }[];
  const hasClosedAt = columns.some((c) => c.name === 'closed_at');
  if (!hasClosedAt) {
    db.exec('ALTER TABLE pull_requests ADD COLUMN closed_at TEXT');
  }
}
```

Then call it right after `db.exec(readSchema())` in both `getDb()` and
`createTestDb()`:

```ts
export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(readSchema());
  runMigrations(db);

  dbInstance = db;
  return db;
}
```

```ts
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readSchema());
  runMigrations(db);
  return db;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- client.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full test suite to check nothing else broke**

Run: `npm test`
Expected: PASS (all existing tests still green — this change is additive only)

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql src/db/client.ts src/db/client.test.ts
git commit -m "feat: add closed_at column with idempotent migration for existing DBs

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Widen `PullRequestRow.pr_state` type and add `closed_at` field

**Files:**
- Modify: `src/db/pullRequests.ts`
- Test: none (this is a pure TypeScript type change with no new runtime
  behavior — validated via the TypeScript compiler, not Vitest, since
  Vitest's esbuild-based transform does not type-check)

- [ ] **Step 1: Update the `PullRequestRow` interface**

In `src/db/pullRequests.ts`, change:

```ts
  pr_state: 'open' | 'closed';
```

to:

```ts
  pr_state: 'open' | 'merged' | 'closed';
```

and add a new field after `error_message`:

```ts
  error_message: string | null;
  closed_at: string | null;
```

- [ ] **Step 2: Type-check to confirm the widened type doesn't break any consumer**

First capture the current baseline error count, since this repo's
`npx tsc --noEmit` does **not** currently pass clean — there are pre-existing,
unrelated errors in several `*.test.ts` files (e.g.
`src/app/components/HoverLiftCard.test.tsx`, `src/instrumentation-node.test.ts`,
`src/lib/recheck.test.ts`, `src/lib/repoCache.test.ts`,
`src/lib/reviewRunner.test.ts` — all a `TS2556`/`TS2493` spread-argument
pattern unrelated to this change):

Run: `npx tsc --noEmit 2>&1 | wc -l` and note the line count as the baseline.

Then run: `npx tsc --noEmit`
Expected: the same set of pre-existing errors as the baseline, and
**no new errors** mentioning `pullRequests.ts` or any file that consumes
`PullRequestRow.pr_state`. (A pure union-widening of `pr_state` and an
added-but-currently-unused `closed_at` field cannot break any existing
consumer that only reads `'open' | 'closed'` — TypeScript would only flag
consumers that exhaustively switch/narrow over the old two values and
rely on exhaustiveness checking; if `tsc` reports any *new* such error,
it means an existing `switch` statement needs a `'merged'` case added —
inspect and fix before proceeding.)

- [ ] **Step 3: Run existing tests to confirm nothing broke at runtime**

Run: `npm test -- pullRequests.test.ts`
Expected: PASS (no runtime behavior changed by this step)

- [ ] **Step 4: Commit**

```bash
git add src/db/pullRequests.ts
git commit -m "feat: widen PullRequestRow.pr_state to include 'merged' and add closed_at

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Add `getPrFinalState` helper to `src/lib/gh.ts`

**Files:**
- Modify: `src/lib/gh.ts`
- Test: `src/lib/gh.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/gh.test.ts` (following the existing `execFileMock` pattern
already set up at the top of that file):

```ts
describe('getPrFinalState', () => {
  it('maps a MERGED gh pr view result to "merged"', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, JSON.stringify({ state: 'MERGED' }), ''));
    const result = await getPrFinalState('o/r', 42);
    expect(result).toBe('merged');
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '42', '--repo', 'o/r', '--json', 'state'],
      expect.any(Function)
    );
  });

  it('maps a CLOSED gh pr view result to "closed"', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, JSON.stringify({ state: 'CLOSED' }), ''));
    const result = await getPrFinalState('o/r', 42);
    expect(result).toBe('closed');
  });

  it('rejects when gh exits non-zero', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(new Error('gh: not found'), '', ''));
    await expect(getPrFinalState('o/r', 42)).rejects.toThrow('gh: not found');
  });

  it('throws on an unexpected state value (e.g. still OPEN) rather than silently mislabeling it "closed"', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, JSON.stringify({ state: 'OPEN' }), ''));
    await expect(getPrFinalState('o/r', 42)).rejects.toThrow(/unexpected pr state/i);
  });
});
```

The existing file already imports `fetchOpenPrs` at the top via
`const { fetchOpenPrs } = await import('./gh');` — extend that same line
to also destructure `getPrFinalState`:

```ts
const { fetchOpenPrs, getPrFinalState } = await import('./gh');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- gh.test.ts`
Expected: FAIL — `getPrFinalState` is not exported yet.

- [ ] **Step 3: Implement `getPrFinalState`**

Add to `src/lib/gh.ts`, reusing the existing `execFileAsync` helper already
defined in that file:

```ts
export type PrFinalState = 'merged' | 'closed';

interface RawGhPrState {
  state: 'MERGED' | 'CLOSED' | 'OPEN';
}

// Called only for a PR that has just disappeared from `fetchOpenPrs`'s
// open-state result, to determine whether it was merged or closed
// without merging (GitHub distinguishes these; a plain "closed" result
// from `gh pr list --state open` cannot tell them apart, since it never
// returns non-open PRs at all).
export async function getPrFinalState(repo: string, prNumber: number): Promise<PrFinalState> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'view', String(prNumber),
    '--repo', repo,
    '--json', 'state',
  ]);
  const raw = JSON.parse(stdout) as RawGhPrState;
  if (raw.state === 'MERGED') return 'merged';
  if (raw.state === 'CLOSED') return 'closed';
  // A PR that just disappeared from `fetchOpenPrs`'s open-state result
  // should only ever resolve here to MERGED or CLOSED. An unexpected
  // value (e.g. still OPEN, due to a race between the two `gh` calls, or
  // some other GitHub API state this app doesn't know about) must not be
  // silently mislabeled "closed" — that would misrepresent an actually-
  // still-open PR as closed. Throwing lets the caller decide how to
  // handle it defensively (Chunk 3's poller.ts wraps each call to this
  // function in its own try/catch and falls back to its own default when
  // it throws, for exactly this reason).
  throw new Error(`unexpected pr state "${raw.state}" for ${repo}#${prNumber}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- gh.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/gh.ts src/lib/gh.test.ts
git commit -m "feat: add getPrFinalState helper to distinguish merged vs closed PRs

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Chunk 3: Poller wiring — merged/closed detection, retention deletion, queue guards

### Task 5: Replace `markClosedExcept` with state-resolving logic + add retention deletion + guard `getPendingPrs`/`getOpenPrs`→`getVisiblePrs`

**Files:**
- Modify: `src/db/pullRequests.ts`
- Modify: `src/lib/poller.ts`
- Test: `src/db/pullRequests.test.ts`
- Test: `src/lib/poller.test.ts`

- [ ] **Step 1: Write the failing DB-layer tests**

Add to `src/db/pullRequests.test.ts` (near the existing `markClosedExcept`
tests — these extend that describe block; keep the existing 3 tests that
call `markClosedExcept(db, 'owner/name', [...])` with only 2 arguments
exactly as they are — the new 3rd `finalStates` parameter must default to
`{}` so those calls keep compiling and passing unchanged):

```ts
it('markClosedExcept sets pr_state to the resolved final state and stamps closed_at', () => {
  upsertOpenPr(db, basePr);
  upsertOpenPr(db, { ...basePr, prNumber: 2 });

  markClosedExcept(db, 'owner/name', [], { 1: 'merged', 2: 'closed' });

  const merged = getByNumber(db, 'owner/name', 1)!;
  expect(merged.pr_state).toBe('merged');
  expect(merged.closed_at).toBeTruthy();

  const closed = getByNumber(db, 'owner/name', 2)!;
  expect(closed.pr_state).toBe('closed');
  expect(closed.closed_at).toBeTruthy();
});

it('getVisiblePrs includes open PRs and merged/closed PRs within the retention window, excludes drafts and stale closed PRs', () => {
  upsertOpenPr(db, basePr); // open
  upsertOpenPr(db, { ...basePr, prNumber: 2 });
  upsertOpenPr(db, { ...basePr, prNumber: 3 });
  upsertOpenPr(db, { ...basePr, prNumber: 4, isDraft: true }); // draft, always excluded

  markClosedExcept(db, 'owner/name', [1], { 2: 'merged', 3: 'closed', 4: 'closed' });

  // #3 is just inside the retention window (1 day old); #2 is stamped
  // "now" by markClosedExcept, so backdate it directly to simulate an
  // old closure that should have already been swept/excluded.
  db.prepare(
    "UPDATE pull_requests SET closed_at = datetime('now', '-4 days') WHERE repo = ? AND pr_number = 2"
  ).run('owner/name');

  const visible = getVisiblePrs(db, 'owner/name');
  expect(visible.map((r) => r.pr_number).sort()).toEqual([1, 3]);
});

it('deleteStaleClosedPrs removes merged/closed rows older than the retention window and their findings', () => {
  upsertOpenPr(db, basePr);
  markClosedExcept(db, 'owner/name', [], { 1: 'merged' });
  db.prepare(
    "UPDATE pull_requests SET closed_at = datetime('now', '-4 days') WHERE repo = ? AND pr_number = 1"
  ).run('owner/name');
  const row = getByNumber(db, 'owner/name', 1)!;
  replaceFindings(db, row.id, [
    { file: 'a.ts', line: 1, severity: 'HIGH', summary: 's', failureScenario: '', evidence: '', fixSuggestion: '', codeSnippet: '' },
  ]);
  expect(getFindingsByPrId(db, row.id)).toHaveLength(1);

  const deleted = deleteStaleClosedPrs(db, 3);

  expect(deleted).toBe(1);
  expect(getByNumber(db, 'owner/name', 1)).toBeUndefined();
  expect(getFindingsByPrId(db, row.id)).toHaveLength(0); // cascade-deleted
});

it('deleteStaleClosedPrs leaves open PRs and recently-closed PRs untouched', () => {
  upsertOpenPr(db, basePr); // open, never closed
  upsertOpenPr(db, { ...basePr, prNumber: 2 });
  markClosedExcept(db, 'owner/name', [1], { 2: 'closed' }); // closed_at = now

  const deleted = deleteStaleClosedPrs(db, 3);

  expect(deleted).toBe(0);
  expect(getByNumber(db, 'owner/name', 1)).toBeDefined();
  expect(getByNumber(db, 'owner/name', 2)).toBeDefined();
});

it('getPendingPrs only returns pr_state=open rows, even if review_status is still pending on a merged/closed row', () => {
  upsertOpenPr(db, basePr); // pending, open
  upsertOpenPr(db, { ...basePr, prNumber: 2 }); // will become "pending but merged"
  markClosedExcept(db, 'owner/name', [1], { 2: 'merged' }); // #2 stays review_status='pending' from its insert default

  const pending = getPendingPrs(db, 'owner/name');
  expect(pending.map((r) => r.pr_number)).toEqual([1]);
});
```

Also add the necessary imports at the top of `src/db/pullRequests.test.ts`:
`getVisiblePrs`, `deleteStaleClosedPrs` (added to the existing named import
from `./pullRequests`), and `replaceFindings`/`getFindingsByPrId` from
`../db/findings` (check whether either is already imported for another
test in this file before adding a duplicate import).

Update the existing `getOpenPrs`-named test
(`'getOpenPrs only returns pr_state=open and is_draft=0'`, currently at
line 73) to call `getVisiblePrs` instead and rename the import — the
function is being renamed, and the old name must not be left referenced
anywhere in this test file:

```ts
it('getVisiblePrs only returns pr_state=open and is_draft=0 when nothing is closed', () => {
  // ...unchanged body, just replace getOpenPrs(...) with getVisiblePrs(...)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pullRequests.test.ts`
Expected: FAIL — `markClosedExcept`'s 3rd argument doesn't exist yet, and
`getVisiblePrs`/`deleteStaleClosedPrs` aren't exported yet.

- [ ] **Step 3: Implement the DB-layer changes in `src/db/pullRequests.ts`**

Replace `markClosedExcept` and `getOpenPrs`. Note the `closed_at`
comparisons below wrap both sides in SQLite's `datetime(...)` function
rather than comparing the raw TEXT columns directly: `closed_at` is
stored as a JS `.toISOString()` string (e.g. `2026-07-29T08:00:00.000Z`),
while SQLite's `datetime('now', ...)` produces its own
`YYYY-MM-DD HH:MM:SS` format (space-separated, no `T`/`Z`/milliseconds) —
a raw text comparison between these two different formats would silently
produce wrong results, whereas `datetime(closed_at)` normalizes it back
to SQLite's canonical comparable format:

```ts
export function markClosedExcept(
  db: Database.Database,
  repo: string,
  keepPrNumbers: number[],
  finalStates: Record<number, 'merged' | 'closed'> = {}
): void {
  const now = new Date().toISOString();
  const setFinalState = db.prepare(
    `UPDATE pull_requests SET pr_state = @prState, closed_at = @now
     WHERE repo = @repo AND pr_number = @prNumber`
  );

  if (keepPrNumbers.length === 0) {
    // No PRs currently open for this repo (or gh returned an empty list):
    // resolve every currently-open row's final state. `NOT IN ()` is
    // invalid SQL and `NOT IN (NULL)` silently matches nothing in
    // SQLite, so this case must be handled separately rather than
    // falling through to the parameterized query below.
    const stillOpen = db
      .prepare(`SELECT pr_number FROM pull_requests WHERE repo = ? AND pr_state = 'open'`)
      .all(repo) as { pr_number: number }[];
    for (const { pr_number } of stillOpen) {
      const prState = finalStates[pr_number] ?? 'closed';
      setFinalState.run({ repo, prNumber: pr_number, prState, now });
    }
    return;
  }

  const placeholders = keepPrNumbers.map(() => '?').join(',');
  const toClose = db
    .prepare(
      `SELECT pr_number FROM pull_requests WHERE repo = ? AND pr_state = 'open'
       AND pr_number NOT IN (${placeholders})`
    )
    .all(repo, ...keepPrNumbers) as { pr_number: number }[];

  for (const { pr_number } of toClose) {
    const prState = finalStates[pr_number] ?? 'closed';
    setFinalState.run({ repo, prNumber: pr_number, prState, now });
  }
}

// Renamed from getOpenPrs: also surfaces merged/closed PRs that closed
// within the last `retentionDays` (default 3, per spec), so they remain
// visible with a status badge instead of disappearing the instant they
// leave the open state. Drafts stay excluded entirely, matching the
// prior getOpenPrs behavior.
export function getVisiblePrs(
  db: Database.Database,
  repo: string,
  retentionDays = 3
): PullRequestRow[] {
  return db
    .prepare(
      `SELECT * FROM pull_requests
       WHERE repo = ? AND is_draft = 0
         AND (
           pr_state = 'open'
           OR (pr_state IN ('merged', 'closed') AND datetime(closed_at) > datetime('now', '-' || ? || ' days'))
         )
       ORDER BY pr_number DESC`
    )
    .all(repo, retentionDays) as PullRequestRow[];
}

// Hard-deletes merged/closed rows once they're older than the retention
// window, across all repos (this app only ever tracks one repo at a
// time via TARGET_REPO, but the query is intentionally not repo-scoped
// so it also cleans up rows from a previously-configured repo). findings
// rows cascade-delete automatically via their existing
// `ON DELETE CASCADE` foreign key onto pull_requests.id (see schema.sql).
export function deleteStaleClosedPrs(db: Database.Database, retentionDays = 3): number {
  const result = db
    .prepare(
      `DELETE FROM pull_requests
       WHERE pr_state IN ('merged', 'closed')
         AND closed_at IS NOT NULL
         AND datetime(closed_at) <= datetime('now', '-' || ? || ' days')`
    )
    .run(retentionDays);
  return result.changes;
}
```

Update `getPendingPrs` to also require `pr_state = 'open'` (a row can still
be `review_status = 'pending'` after merging/closing if it was enqueued for
a commit change and then merged before `processQueue` reached it — see
spec section 3):

```ts
export function getPendingPrs(db: Database.Database, repo: string): PullRequestRow[] {
  return db
    .prepare(
      `SELECT * FROM pull_requests WHERE repo = ? AND review_status = 'pending' AND is_draft = 0 AND pr_state = 'open'
       ORDER BY id ASC`
    )
    .all(repo) as PullRequestRow[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pullRequests.test.ts`
Expected: PASS

- [ ] **Step 5: Update the poller tests first (still red at this point) before touching `poller.ts`**

Read the current `src/lib/poller.ts` and `src/lib/poller.test.ts` in full
first to confirm exact current structure before editing.

In `src/lib/poller.test.ts`:

1. Add a `getPrFinalState` mock to the existing `vi.mock('./gh', ...)`
   block, alongside `fetchOpenPrsMock`:

```ts
const getPrFinalStateMock = vi.fn().mockResolvedValue('closed');
vi.mock('./gh', () => ({
  fetchOpenPrs: (...args: unknown[]) => fetchOpenPrsMock(...args),
  getPrFinalState: (...args: unknown[]) => getPrFinalStateMock(...args),
}));
```

2. Reset/re-arm it in `beforeEach`, alongside the other mock resets:

```ts
    getPrFinalStateMock.mockReset();
    getPrFinalStateMock.mockResolvedValue('closed');
```

3. Update the import of `getOpenPrs` from `../db/pullRequests` to
   `getVisiblePrs` (the function is renamed in this chunk — there must be
   no remaining reference to `getOpenPrs` anywhere in this file), and
   update its one call site in the `'skips a draft PR entirely'` test:

```ts
import { getByNumber, getVisiblePrs } from '../db/pullRequests';
```

```ts
    expect(getVisiblePrs(db, 'owner/name')).toEqual([]); // filtered out of the visible list
```

4. Add one more test asserting the merged path resolves correctly:

```ts
it('resolves a PR to "merged" via getPrFinalState when gh reports it merged', async () => {
  fetchOpenPrsMock.mockResolvedValueOnce([basePrFromGh]);
  runReviewMock.mockResolvedValue({
    success: true,
    output: `# R\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
  });
  await runPollTick(db, 'owner/name');

  fetchOpenPrsMock.mockResolvedValueOnce([]);
  getPrFinalStateMock.mockResolvedValueOnce('merged');
  await runPollTick(db, 'owner/name');

  const row = getByNumber(db, 'owner/name', 1)!;
  expect(row.pr_state).toBe('merged');
  expect(row.closed_at).toBeTruthy();
});
```

The existing test `'marks PRs absent from the gh result as closed'` needs
no assertion changes — its expectation
(`expect(getByNumber(db, 'owner/name', 1)!.pr_state).toBe('closed')`)
still holds true given `getPrFinalStateMock`'s default `'closed'` resolve
value from step 2 above.

- [ ] **Step 6: Run poller tests to verify they fail**

Run: `npm test -- poller.test.ts`
Expected: FAIL — `getVisiblePrs` isn't imported/exported correctly yet in
this file's context relative to `poller.ts`'s own (still old) implementation,
and the new "resolves a PR to merged" test fails because `poller.ts` still
unconditionally marks everything `'closed'`.

- [ ] **Step 7: Now implement the `poller.ts` changes**

Update the import from `./gh` to include `getPrFinalState`:

```ts
import { fetchOpenPrs, getPrFinalState } from './gh';
```

Update the import from `../db/pullRequests` to add `getVisiblePrs` and
`deleteStaleClosedPrs`:

```ts
import {
  upsertOpenPr,
  markClosedExcept,
  markPending,
  markReviewing,
  markDone,
  markFailed,
  getByNumber,
  getPendingPrs,
  getVisiblePrs,
  deleteStaleClosedPrs,
} from '../db/pullRequests';
```

Replace the existing `markClosedExcept(db, repo, keepPrNumbers);` line
(currently right after the `for (const pr of prs)` loop, before the
`setConfig(db, 'last_poll_at', ...)` calls) with:

```ts
  const finalStates: Record<number, 'merged' | 'closed'> = {};
  const previouslyOpen = getVisiblePrs(db, repo).filter((row) => row.pr_state === 'open');
  for (const row of previouslyOpen) {
    if (keepPrNumbers.includes(row.pr_number)) continue;
    try {
      finalStates[row.pr_number] = await getPrFinalState(repo, row.pr_number);
    } catch {
      // If gh fails for this specific lookup (e.g. transient network
      // error, or getPrFinalState's own defensive throw on an unexpected
      // state), fall back to the prior behavior of marking it 'closed'
      // (markClosedExcept's default) rather than leaving it stuck open
      // forever. It'll simply show as "Closed" instead of "Merged" if
      // this was actually a merge — a minor cosmetic inaccuracy, not a
      // correctness issue, and it's still correctly retained/swept by
      // the 3-day window either way.
    }
  }

  markClosedExcept(db, repo, keepPrNumbers, finalStates);
  deleteStaleClosedPrs(db);
```

The three existing lines right after that
(`setConfig(db, 'last_poll_at', ...)`, `setConfig(db, 'last_poll_status', 'ok')`,
`setConfig(db, 'last_poll_error', '')`) stay exactly as they are — do not
duplicate or remove them, just leave the new block above inserted
directly before them.

- [ ] **Step 8: Run poller tests to verify they pass**

Run: `npm test -- poller.test.ts`
Expected: PASS

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS. If anything still fails, it should only be
`src/app/page.tsx`'s `getOpenPrs` import (a `.tsx` file not directly
exercised by any Vitest test file, so it would only surface as a
type-check failure via `npx tsc --noEmit`, not a Vitest failure) —
addressed in Chunk 4, Task 8. Confirm via `npx tsc --noEmit` that
`src/app/page.tsx` is the *only* remaining compile error at this point.

- [ ] **Step 10: Commit**

```bash
git add src/db/pullRequests.ts src/db/pullRequests.test.ts src/lib/poller.ts src/lib/poller.test.ts
git commit -m "feat: resolve merged/closed PR state via gh, add 3-day retention sweep

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Chunk 4: View models, badges, and UI wiring

### Task 6: Add `PrStateBadge` component

**Files:**
- Create: `src/app/components/PrStateBadge.tsx`
- Test: `src/app/components/PrStateBadge.test.tsx` (this repo DOES have a
  test file for `VerdictBadge.tsx` — `VerdictBadge.test.tsx` — so match
  that convention rather than skipping tests for this new badge)

- [ ] **Step 1: Read `VerdictBadge.tsx` and `VerdictBadge.test.tsx` for the exact visual/test pattern to match**

Run: `cat src/app/components/VerdictBadge.tsx src/app/components/VerdictBadge.test.tsx`

- [ ] **Step 2: Confirm which lucide-react icons are actually available and how they render**

Run: `node -e "const i = require('lucide-react'); console.log(typeof i.GitMerge, typeof i.GitPullRequestClosed)"`
Expected: `object object` (lucide-react's icons are React `forwardRef`
components, not plain functions — they resolve as JS objects, not
`function`, so `object object` here means both icons exist and are usable
as JSX components; `undefined` for either would mean it needs replacing).
If either logs `undefined`, pick the closest available equivalent icon
from lucide-react's actual export list instead:
`node -e "console.log(Object.keys(require('lucide-react')).filter(k => /git|merge|closed/i.test(k)))"`.

- [ ] **Step 3: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrStateBadge } from './PrStateBadge';

describe('PrStateBadge', () => {
  it('renders a Merged badge', () => {
    render(<PrStateBadge state="merged" />);
    expect(screen.getByText('Merged')).toBeInTheDocument();
  });

  it('renders a Closed badge', () => {
    render(<PrStateBadge state="closed" />);
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('applies visually distinct classes for merged vs closed', () => {
    const { container: mergedContainer } = render(<PrStateBadge state="merged" />);
    const { container: closedContainer } = render(<PrStateBadge state="closed" />);
    expect(mergedContainer.firstChild).not.toHaveClass('bg-[#3F3F46]');
    expect(closedContainer.firstChild).toHaveClass('bg-[#3F3F46]');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- PrStateBadge.test.ts`
Expected: FAIL — `./PrStateBadge` doesn't exist yet.

- [ ] **Step 5: Implement `PrStateBadge`**

```tsx
import { GitMerge, GitPullRequestClosed } from 'lucide-react';
import { Badge } from './ui/badge';

export type PrState = 'merged' | 'closed';

const LABELS: Record<PrState, string> = {
  merged: 'Merged',
  closed: 'Closed',
};

const ICONS: Record<PrState, typeof GitMerge> = {
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

const CLASSES: Record<PrState, string> = {
  merged: 'bg-gradient-to-r from-[#A78BFA] to-[#8B5CF6] text-white border-transparent',
  closed: 'bg-[#3F3F46] text-[#A1A1AA] border-transparent',
};

export function PrStateBadge({ state }: { state: PrState }) {
  const Icon = ICONS[state];
  return (
    <Badge className={CLASSES[state]}>
      <Icon className="h-3 w-3" />
      {LABELS[state]}
    </Badge>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- PrStateBadge.test.ts`
Expected: PASS

- [ ] **Step 7: Lint/type-check**

Run: `npm run lint && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/components/PrStateBadge.tsx src/app/components/PrStateBadge.test.tsx
git commit -m "feat: add PrStateBadge component for merged/closed PR status

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 7: Thread `prState`/`closedAt` through `listPageViewModel`

**Files:**
- Modify: `src/lib/listPageViewModel.ts`
- Test: `src/lib/listPageViewModel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/listPageViewModel.test.ts`:

```ts
it('is never in-progress for a merged PR, even if review_status is still "pending"', () => {
  const vm = buildListRowViewModel(row({ reviewStatus: 'pending', prState: 'merged' }));
  expect(vm.isInProgress).toBe(false);
  expect(vm.prState).toBe('merged');
});

it('is in-progress for an open PR with review_status "reviewing"', () => {
  const vm = buildListRowViewModel(row({ reviewStatus: 'reviewing', prState: 'open' }));
  expect(vm.isInProgress).toBe(true);
});

it('marks a closed PR as such in the view model', () => {
  const vm = buildListRowViewModel(row({ prState: 'closed', reviewStatus: 'done' }));
  expect(vm.prState).toBe('closed');
});
```

Update the `row()` test helper at the top of the file to include a
`prState` default:

```ts
function row(overrides: Partial<ListPageRowInput>): ListPageRowInput {
  return {
    prNumber: 1,
    title: 'Add feature',
    branch: 'feat/x',
    author: 'alice',
    reviewStatus: 'done',
    prState: 'open',
    verdict: 'approve',
    severityCritical: 0,
    severityHigh: 0,
    lastReviewedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}
```

Also update `prRow()` (the `PullRequestRow`-shaped test helper further down
the same file) to include `pr_state` (already present, defaulting to
`'open'`) and add `closed_at: null` to its defaults, since `PullRequestRow`
now has that field.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- listPageViewModel.test.ts`
Expected: FAIL — `prState` doesn't exist on the input/output types yet, and
`isInProgress` doesn't account for it.

- [ ] **Step 3: Implement the view model changes**

In `src/lib/listPageViewModel.ts`:

```ts
export interface ListPageRowInput {
  prNumber: number;
  title: string;
  branch: string;
  author: string;
  reviewStatus: 'pending' | 'reviewing' | 'done' | 'failed';
  prState: 'open' | 'merged' | 'closed';
  verdict: string | null;
  severityCritical: number;
  severityHigh: number;
  lastReviewedAt: string | null;
}

export interface ListPageRowViewModel {
  prNumber: number;
  title: string;
  branch: string;
  author: string;
  isInProgress: boolean;
  prState: 'open' | 'merged' | 'closed';
  badgeVerdict: BadgeVerdict;
  criticalHighCount: number | null;
  lastReviewedAt: string | null;
}

export function buildListRowViewModel(input: ListPageRowInput): ListPageRowViewModel {
  // A row can still carry review_status='pending'/'reviewing' after its
  // PR has merged/closed (e.g. it was enqueued for a commit change, then
  // merged before the queue got to it) — gating on prState here means it
  // can never render as "Reviewing…" once it's left the open state,
  // regardless of what review_status happens to still say.
  const isInProgress = input.prState === 'open' && (input.reviewStatus === 'reviewing' || input.reviewStatus === 'pending');
  const isFailed = input.reviewStatus === 'failed';

  const hasPriorSuccess = input.lastReviewedAt !== null;
  const criticalHighCount = isFailed && !hasPriorSuccess ? null : input.severityCritical + input.severityHigh;

  return {
    prNumber: input.prNumber,
    title: input.title,
    branch: input.branch,
    author: input.author,
    isInProgress,
    prState: input.prState,
    badgeVerdict: isFailed ? 'failed' : ((input.verdict ?? 'needs_review') as BadgeVerdict),
    criticalHighCount,
    lastReviewedAt: input.lastReviewedAt,
  };
}
```

In `buildListPageViewModel`, add `prState: pr.pr_state` to the object
passed into `buildListRowViewModel`:

```ts
        buildListRowViewModel({
          prNumber: pr.pr_number,
          title: pr.title,
          branch: pr.branch,
          author: pr.author,
          reviewStatus: pr.review_status,
          prState: pr.pr_state,
          verdict: pr.verdict,
          severityCritical: pr.severity_critical,
          severityHigh: pr.severity_high,
          lastReviewedAt: pr.last_reviewed_at,
        })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- listPageViewModel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/listPageViewModel.ts src/lib/listPageViewModel.test.ts
git commit -m "feat: thread prState through listPageViewModel, gate in-progress on open state

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 8: Update `src/app/page.tsx` (list page) to use `getVisiblePrs`, `PrStateBadge`, and hide Re-check for merged/closed

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Read the current file**

Run: `cat src/app/page.tsx`

- [ ] **Step 2: Update the data-fetching and severity summary source**

Replace the `getOpenPrs` import/call with `getVisiblePrs` for the rows shown
in the list, but keep the severity summary scoped to **open PRs only** (per
spec: a lingering merged/closed PR shouldn't skew the live severity counts
at the top of the page):

```tsx
import { getVisiblePrs } from '../db/pullRequests';
```

```tsx
  const visiblePrs = getVisiblePrs(db, repo);
  const vm = buildListPageViewModel({
    repo,
    lastPollAt: getConfig(db, 'last_poll_at') ?? null,
    lastPollStatus: (getConfig(db, 'last_poll_status') as 'ok' | 'error' | undefined) ?? null,
    lastPollError: getConfig(db, 'last_poll_error') ?? null,
    prs: visiblePrs,
  });
  const severitySummary = buildSeveritySummary(visiblePrs.filter((pr) => pr.pr_state === 'open'));
```

- [ ] **Step 3: Add the `PrStateBadge`, dim closed/merged cards, and hide Re-check**

Import `PrStateBadge`:

```tsx
import { PrStateBadge } from './components/PrStateBadge';
```

In the card's `className`, extend the existing conditional dimming (which
today only applies `opacity-70` for `row.isInProgress`) to also dim
merged/closed rows slightly more:

```tsx
              className={`relative flex flex-col items-stretch gap-3 card-glass p-4 transition-colors duration-200 ease-out hover:border-primary/40 sm:flex-row sm:items-center sm:justify-between ${
                row.isInProgress ? 'opacity-70' : row.prState !== 'open' ? 'opacity-60' : ''
              }`}
```

Per the spec, `PrStateBadge` is shown **next to** the existing verdict/
"Reviewing…" indicator, not instead of it (a merged/closed row's
`isInProgress` is always `false` per Chunk 3's gating, so this renders the
last-known `VerdictBadge` alongside the new "Merged"/"Closed" badge):

```tsx
                <div className="flex items-center gap-4">
                  {row.prState !== 'open' && <PrStateBadge state={row.prState} />}
                  {row.isInProgress ? (
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                      Reviewing…
                    </span>
                  ) : (
                    <VerdictBadge verdict={row.badgeVerdict} />
                  )}
                  <span className="text-sm text-muted-foreground">Crit+High: {row.criticalHighCount ?? '-'}</span>
                </div>
```

Hide `RecheckButton` entirely for merged/closed rows (its branch/worktree
no longer exists to review):

```tsx
              {row.prState === 'open' && (
                <div className="relative z-10 pointer-events-auto">
                  <RecheckButton prNumber={row.prNumber} disabled={row.isInProgress} />
                </div>
              )}
```

- [ ] **Step 4: Lint/type-check**

Run: `npm run lint && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Manual verification**

Run: `npm run dev` and load the list page. Confirm:
- open PRs render exactly as before (verdict badge / "Reviewing…" + Re-check button),
- if you have any merged/closed PRs within the retention window, they show
  the new "Merged"/"Closed" badge next to their last-known verdict badge,
  no Re-check button, and slightly reduced card opacity,
- the top severity summary bar's counts match only the open PRs.

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: show merged/closed PR badges on the list page, hide Re-check for them

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 9: Thread `prState` through `detailPageViewModel` and update the detail page

**Files:**
- Modify: `src/lib/detailPageViewModel.ts`
- Modify: `src/app/pr/[number]/page.tsx`
- Test: `src/lib/detailPageViewModel.test.ts`

- [ ] **Step 1: Read the current detail view model test file**

Run: `cat src/lib/detailPageViewModel.test.ts`

- [ ] **Step 2: Write the failing test**

Add a test asserting `prState` passes through into the view model
(matching whatever helper pattern that test file already uses to build a
`PullRequestRow` fixture — reuse it rather than duplicating):

```ts
it('passes prState through into the view model', () => {
  const vm = buildDetailPageViewModel(prRow({ pr_state: 'merged' }), []);
  expect(vm.prState).toBe('merged');
});
```

(If the existing test file's fixture helper is named differently than
`prRow`, use its actual name — check the file first.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- detailPageViewModel.test.ts`
Expected: FAIL — `prState` doesn't exist on `DetailPageViewModel` yet.

- [ ] **Step 4: Implement the view model change**

In `src/lib/detailPageViewModel.ts`, add `prState` to the
`DetailPageViewModel` interface and populate it in `buildDetailPageViewModel`:

```ts
export interface DetailPageViewModel {
  state: DetailPageState;
  prNumber: number;
  title: string;
  prState: 'open' | 'merged' | 'closed';
  verdict: string | null;
  severityCritical: number;
  severityHigh: number;
  severityMedium: number;
  severityLow: number;
  topRisks: FindingRow[];
  mediumLow: FindingRow[];
  rawReportMd: string | null;
  failureBanner: FailureBanner | null;
}
```

```ts
  return {
    state,
    prNumber: pr.pr_number,
    title: pr.title,
    prState: pr.pr_state,
    verdict: pr.verdict,
    ...
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- detailPageViewModel.test.ts`
Expected: PASS

- [ ] **Step 6: Update `src/app/pr/[number]/page.tsx`**

Read the current file (`cat src/app/pr/[number]/page.tsx`) and make these
changes:

1. Gate `isInProgress` on `pr.pr_state === 'open'`, same reasoning as the
   list page (a stale `pending`/`reviewing` `review_status` must never
   present as active once the PR has merged/closed):

```tsx
  const isInProgress = pr.pr_state === 'open' && (pr.review_status === 'pending' || pr.review_status === 'reviewing');
```

2. Import `PrStateBadge` and render it in the header's action row (the
   `flex items-center gap-3` div next to the title, alongside the
   timestamp/Re-check button) when the PR isn't open, and hide
   `RecheckButton` for non-open PRs:

```tsx
import { PrStateBadge } from '../../components/PrStateBadge';
```

```tsx
        <div className="flex items-center gap-3">
          {vm.prState !== 'open' && <PrStateBadge state={vm.prState} />}
          {!vm.failureBanner && <TimeStamp iso={pr.last_reviewed_at} label="Last reviewed" />}
          {vm.prState === 'open' && <RecheckButton prNumber={vm.prNumber} disabled={isInProgress} />}
        </div>
```

- [ ] **Step 7: Lint/type-check and run full suite**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: no new errors, all tests PASS.

- [ ] **Step 8: Manual verification**

Run: `npm run dev`, open the detail page for an open PR (unchanged
behavior expected), then for a merged/closed PR still within the retention
window (badge shown, no Re-check button, "Reviewing…"/in-progress state
never shown even if DB has a stale `pending` row — you can simulate this
by manually setting `review_status='pending'` on a merged row via sqlite3
against the dev DB, per the migration section's `PR_DASHBOARD_DB_PATH`
env var, and confirming the button/status don't show as active).

- [ ] **Step 9: Commit**

```bash
git add src/lib/detailPageViewModel.ts src/lib/detailPageViewModel.test.ts src/app/pr/[number]/page.tsx
git commit -m "feat: show PrStateBadge on detail page, gate in-progress/recheck on open state

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 10: Guard `forceRecheck` against merged/closed PRs

**Files:**
- Modify: `src/lib/recheck.ts`
- Test: `src/lib/recheck.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/recheck.test.ts` (matching its existing
`upsertOpenPr`/`db.prepare(...).run()` fixture-setup style seen in the
other tests in that file):

```ts
it('returns not-found for a merged/closed PR, even if review_status is still pending (defensive guard; UI never shows Re-check for these)', async () => {
  upsertOpenPr(db, {
    repo: 'owner/name', prNumber: 1, title: 't', author: 'a', branch: 'b',
    baseBranch: 'main', headSha: 'sha1', prUrl: 'u', isDraft: false,
  });
  db.prepare("UPDATE pull_requests SET pr_state = 'merged', closed_at = datetime('now') WHERE pr_number = 1").run();

  const result = await forceRecheck(db, 'owner/name', 1);

  expect(result).toEqual({ status: 'not-found' });
  expect(fetchOpenPrsMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- recheck.test.ts`
Expected: FAIL — currently, a `pending` `review_status` on this row would
hit the existing "already-in-progress" branch instead of "not-found"
(since `pr_state` isn't checked at all yet).

- [ ] **Step 3: Implement the guard**

In `src/lib/recheck.ts`, add a `pr_state` check right after the existing
`if (!existing) return { status: 'not-found' };` line, before the
`already-in-progress` check:

```ts
  const existing = getByNumber(db, repo, prNumber);
  if (!existing) return { status: 'not-found' };
  if (existing.pr_state !== 'open') return { status: 'not-found' };
  if (existing.review_status === 'pending' || existing.review_status === 'reviewing') {
    return { status: 'already-in-progress' };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- recheck.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite one final time**

Run: `npm test`
Expected: PASS — all tests across the whole project green.

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/recheck.ts src/lib/recheck.test.ts
git commit -m "fix: guard forceRecheck against merged/closed PRs

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final verification checklist

- [ ] `npm test` — full suite passes
- [ ] `npm run lint` — no errors
- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npm run build` — production build succeeds
- [ ] Manual: rapid navigate-away-and-back on the list page no longer freezes card opacity (Chunk 1)
- [ ] Manual: a merged PR shows a "Merged" badge, dimmed card, no Re-check button, and disappears from the list (but not the DB) once you backdate its `closed_at` past 3 days and re-run a poll tick / call `deleteStaleClosedPrs` directly — confirm it's then also gone from the DB entirely (`sqlite3 <db path> "SELECT * FROM pull_requests WHERE pr_number = <n>"` returns nothing)
- [ ] Manual: a closed-without-merge PR shows a "Closed" badge (distinct styling from "Merged")
