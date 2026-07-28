# PR Review Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Next.js dashboard that polls a single configured GitHub repo every 5 minutes for open, non-draft PRs, automatically runs the `local-advanced-code-review` skill (via headless `copilot -p`) on new/changed PRs, and shows results in a List Page + Detail Page.

**Architecture:** Single Next.js process. `instrumentation.ts` registers a `node-cron` job on boot. Each tick: `gh pr list` → diff against SQLite `pull_requests` table → serially process a queue of new/changed PRs by fetching into a local bare clone, checking out a per-PR `git worktree`, spawning `copilot -p` headless, parsing its output, and writing results to SQLite (only the latest review per PR is kept). Server Components read directly from SQLite for rendering. All git operations against the remote are read-only (clone/fetch only, never push).

**Tech Stack:** Next.js (App Router, TypeScript), `better-sqlite3`, `node-cron`, `gh` CLI, `copilot` CLI (headless), Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-07-28-pr-review-dashboard-design.md` — read this first for full rationale; this plan implements it task-by-task.

---

## File Structure

```
pr-review-dashboard/
  package.json
  tsconfig.json
  next.config.ts
  .env.local.example          # TARGET_REPO=owner/name
  vitest.config.ts
  vitest-setup.ts              # imports @testing-library/jest-dom/vitest for component tests
  src/
    instrumentation.ts        # registers cron job + crash recovery, once per process
                               # (lives under src/ per Next.js --src-dir convention)
    instrumentation.test.ts
    db/
      schema.sql              # CREATE TABLE statements (config, pull_requests, findings)
      client.ts                # opens/creates the sqlite file, runs schema.sql once, exports db singleton
      client.test.ts
      config.ts                # getConfig/setConfig key-value helpers
      config.test.ts
      pullRequests.ts          # upsertOpenPr, markClosed, markReviewing, markDone, markFailed, getAll, getByNumber
      pullRequests.test.ts
      findings.ts              # replaceFindings(prId, findings[]), getByPrId
      findings.test.ts
    lib/
      gh.ts                     # fetchOpenPrs(repo): shells out to `gh pr list`, parses JSON
      gh.test.ts
      repoCache.ts              # ensureBareRepo(repo), addOrUpdateWorktree(repo, prNumber, headSha)
      repoCache.test.ts
      reviewPrompt.ts           # buildReviewPrompt(pr): returns the string passed to `copilot -p`
      reviewPrompt.test.ts
      reviewRunner.ts           # runReview(cwd, prompt, timeoutMs): spawns `copilot -p`, enforces timeout, returns {success, output, errorMessage?}
      reviewRunner.test.ts
      parseReviewOutput.ts      # parseReviewOutput(rawOutput): extracts trailing JSON block -> {findings, verdict} + rawMarkdown
      parseReviewOutput.test.ts
      decision.ts                # shouldEnqueue(existingRow, freshPr): pure function, the "new or head_sha changed and not pending/reviewing" rule
      decision.test.ts
      queue.ts                    # in-process single-flight tracking + poll-tick mutex
      queue.test.ts
      poller.ts                   # orchestrates one full poll tick end-to-end
      poller.test.ts
      startupConfig.ts             # pure TARGET_REPO env-var validation (owner/name format check)
      startupConfig.test.ts
      listPageViewModel.ts          # buildListRowViewModel/buildListPageViewModel: pure data-shaping for the List Page
      listPageViewModel.test.ts
      detailPageViewModel.ts        # buildDetailPageViewModel: pure data-shaping + failed-state logic for the Detail Page
      detailPageViewModel.test.ts
      recheck.ts                    # forceRecheck(db, repo, prNumber): the "Re-check now" button's shared logic
      recheck.test.ts
    app/
      layout.tsx                  # created by the Task 1.1 scaffold, unmodified
      page.tsx                    # List Page (Server Component)
      pr/[number]/page.tsx        # Detail Page (Server Component)
      api/recheck/[number]/route.ts   # POST: force immediate review for one PR
      api/recheck/[number]/route.test.ts
      components/
        VerdictBadge.tsx
        VerdictBadge.test.tsx
        SeverityBadge.tsx
        SeverityBadge.test.tsx
        PollStatusBanner.tsx
        PollStatusBanner.test.tsx
        FindingCard.tsx
        FindingCard.test.tsx
```

**Responsibilities:**
- `db/*`: all SQLite access. Nothing outside this folder touches `better-sqlite3` directly.
- `lib/gh.ts`, `lib/repoCache.ts`, `lib/reviewRunner.ts`: thin wrappers around external processes (`gh`, `git`, `copilot`). Each does one external-process concern and is independently mockable.
- `lib/parseReviewOutput.ts`, `lib/decision.ts`, `lib/startupConfig.ts`: pure functions, no I/O — the easiest things to unit test exhaustively.
- `lib/poller.ts`: the only place that wires `gh.ts` + `repoCache.ts` + `reviewRunner.ts` + `parseReviewOutput.ts` + `db/*` together for one poll tick. `processOnePr` is also exported for `lib/recheck.ts` to reuse for a single forced PR.
- `lib/recheck.ts`: shared logic behind the "Re-check now" button — refetches the PR's current `head_sha`, bypasses `decision.ts`'s gate, and kicks off `poller.ts`'s `processOnePr` under `queue.ts`'s poll-tick mutex.
- `lib/listPageViewModel.ts`, `lib/detailPageViewModel.ts`: pure data-shaping functions consumed by `app/page.tsx` and `app/pr/[number]/page.tsx` respectively — kept out of the Server Components themselves so the badge/banner/failed-state branching logic is unit-testable without a React render pipeline.
- `lib/queue.ts`: in-memory (not persisted) single-flight + mutex state, isolated so it can be unit tested without spawning real processes.
- `instrumentation.ts`: the only place that wires `lib/startupConfig.ts` (validate env, exit on failure) + `db/pullRequests.ts`'s `resetStuckReviews` (crash recovery) + `node-cron` + `lib/queue.ts` + `lib/poller.ts` together at process boot. Deliberately not split into a separate `lib/startup.ts` — the boot sequence is a handful of sequential calls with no independent reusable logic, so a wrapper module would just add indirection.
- `app/*`: Next.js UI, reads only through `db/*` functions (Server Components) or `lib/recheck.ts` (the API route), never touches `gh`/`git`/`copilot` directly. `app/components/*` are small presentational components tested with `@testing-library/react` under a per-file `jsdom` environment override (see Chunk 5, Task 5.1) while every other test file in the project runs under the default `node` environment.

---

## Chunk 1: Project scaffold + SQLite data layer

### Task 1.1: Scaffold the Next.js project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.local.example`, `.gitignore` (extend existing one)

- [ ] **Step 1: Scaffold with create-next-app in a temp dir, then merge**

`create-next-app` refuses to run non-interactively in a non-empty directory
(this repo already has `.git`, `.gitignore`, `docs/`), so scaffold into a
fresh temp directory and merge the generated files in:

```bash
# Run from the repository root (all commands in this plan assume the
# current working directory is the project root unless stated otherwise).
REPO_ROOT="$(pwd)"
SCAFFOLD_DIR="$(mktemp -d -t pr-review-dashboard-scaffold)"
npx --yes create-next-app@latest "$SCAFFOLD_DIR" \
  --typescript --eslint --app --src-dir --import-alias "@/*" \
  --use-npm --no-tailwind --yes

# Copy everything except the scaffold's own .git and .gitignore — our
# existing .gitignore (node_modules/, .env*, .superpowers/) must not be
# overwritten. Append any scaffold-specific ignore lines we don't already
# have instead of clobbering the file.
rsync -a --exclude='.git' --exclude='.gitignore' "$SCAFFOLD_DIR"/ "$REPO_ROOT"/
comm -13 <(sort "$REPO_ROOT/.gitignore") <(sort "$SCAFFOLD_DIR/.gitignore") \
  >> "$REPO_ROOT/.gitignore"
rm -rf "$SCAFFOLD_DIR"
```

Expected: `package.json`, `next.config.ts`, `src/app/page.tsx`, `tsconfig.json`
now exist directly under the repository root, and `.gitignore` still
contains the pre-existing `.superpowers/` entry alongside the scaffold's
standard Next.js ignores.

- [ ] **Step 2: Install additional dependencies**

Run:
```bash
npm install better-sqlite3 node-cron
npm install -D @types/better-sqlite3 @types/node-cron vitest @vitest/coverage-v8
```

- [ ] **Step 3: Add `.env.local.example`**

```
# Copy to .env.local and set to the repo you want to monitor.
TARGET_REPO=owner/name
```

- [ ] **Step 4: Add vitest config**

`vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

- [ ] **Step 5: Add test script to package.json**

Modify `package.json` `scripts` to add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 6: Verify the scaffold builds**

Run: `npm run build`
Expected: build succeeds with the default Next.js starter page.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js project with vitest, better-sqlite3, node-cron"
```

---

### Task 1.2: Database schema and client singleton

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/client.ts`
- Test: `src/db/client.test.ts`

- [ ] **Step 1: Write the failing test**

`src/db/client.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { createTestDb } from './client';

describe('createTestDb', () => {
  it('creates all expected tables', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining(['config', 'pull_requests', 'findings'])
    );
  });

  it('enforces UNIQUE(repo, pr_number) on pull_requests', () => {
    const db = createTestDb();
    const insert = db.prepare(
      'INSERT INTO pull_requests (repo, pr_number) VALUES (?, ?)'
    );
    insert.run('owner/repo', 1);
    expect(() => insert.run('owner/repo', 1)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/db/client.test.ts`
Expected: FAIL — `Cannot find module './client'`.

- [ ] **Step 3: Write `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT,
  author TEXT,
  branch TEXT,
  base_branch TEXT,
  head_sha TEXT,
  pr_url TEXT,
  is_draft INTEGER DEFAULT 0,
  pr_state TEXT DEFAULT 'open',
  review_status TEXT DEFAULT 'pending',
  verdict TEXT,
  severity_critical INTEGER DEFAULT 0,
  severity_high INTEGER DEFAULT 0,
  severity_medium INTEGER DEFAULT 0,
  severity_low INTEGER DEFAULT 0,
  reviewed_head_sha TEXT,
  last_reviewed_at TEXT,
  last_attempted_at TEXT,
  raw_report_md TEXT,
  error_message TEXT,
  UNIQUE(repo, pr_number)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_request_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  file TEXT,
  line INTEGER,
  severity TEXT,
  summary TEXT,
  failure_scenario TEXT,
  evidence TEXT,
  fix_suggestion TEXT,
  code_snippet TEXT
);

CREATE INDEX IF NOT EXISTS idx_findings_pr ON findings(pull_request_id);
```

- [ ] **Step 4: Write `src/db/client.ts`**

```typescript
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let dbInstance: Database.Database | null = null;

export function getDbPath(): string {
  return process.env.PR_DASHBOARD_DB_PATH
    ?? path.join(os.homedir(), '.pr-review-dashboard', 'dashboard.sqlite');
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(readSchema());

  dbInstance = db;
  return db;
}

// `__dirname` is not reliable here: Next.js bundles/transpiles server code
// into `.next/server/...` at build time, so a path relative to the
// compiled file's directory would not point at the real `src/db/schema.sql`
// in a production build. `process.cwd()` is stable across `npm run dev`,
// `npm run build && npm start`, and tests, because Next.js always runs
// with the project root as the working directory.
function readSchema(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf-8');
}

// Test-only: allows each test file to get a fresh in-memory database.
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readSchema());
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/db/client.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/client.ts src/db/client.test.ts
git commit -m "feat(db): add sqlite schema and client singleton"
```

---

### Task 1.3: Config key-value helpers

**Files:**
- Create: `src/db/config.ts`
- Test: `src/db/config.test.ts`

- [ ] **Step 1: Write the failing test**

`src/db/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { createTestDb } from './client';
import { getConfig, setConfig } from './config';

describe('config helpers', () => {
  it('returns undefined for a missing key', () => {
    const db = createTestDb();
    expect(getConfig(db, 'target_repo')).toBeUndefined();
  });

  it('sets and gets a value', () => {
    const db = createTestDb();
    setConfig(db, 'target_repo', 'owner/name');
    expect(getConfig(db, 'target_repo')).toBe('owner/name');
  });

  it('overwrites an existing value', () => {
    const db = createTestDb();
    setConfig(db, 'last_poll_status', 'error');
    setConfig(db, 'last_poll_status', 'ok');
    expect(getConfig(db, 'last_poll_status')).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/db/config.test.ts`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Write `src/db/config.ts`**

```typescript
import type Database from 'better-sqlite3';

export function getConfig(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setConfig(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/db/config.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/config.ts src/db/config.test.ts
git commit -m "feat(db): add config key-value helpers"
```

---

### Task 1.4: pull_requests repository functions

**Files:**
- Create: `src/db/pullRequests.ts`
- Test: `src/db/pullRequests.test.ts`

- [ ] **Step 1: Write the failing test**

`src/db/pullRequests.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './client';
import {
  upsertOpenPr,
  markClosedExcept,
  markReviewing,
  markDone,
  markFailed,
  getOpenPrs,
  getByNumber,
  resetStuckReviews,
  type OpenPrInput,
} from './pullRequests';

const basePr: OpenPrInput = {
  repo: 'owner/name',
  prNumber: 1,
  title: 'Add feature',
  author: 'alice',
  branch: 'feat/x',
  baseBranch: 'main',
  headSha: 'sha1',
  prUrl: 'https://github.com/owner/name/pull/1',
  isDraft: false,
};

describe('pullRequests repository', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it('inserts a new PR as pending, pr_state=open', () => {
    upsertOpenPr(db, basePr);
    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('pending');
    expect(row.pr_state).toBe('open');
    expect(row.head_sha).toBe('sha1');
  });

  it('re-opens a previously closed PR on upsert, regardless of head_sha', () => {
    upsertOpenPr(db, basePr);
    markClosedExcept(db, 'owner/name', []); // closes it
    expect(getByNumber(db, 'owner/name', 1)!.pr_state).toBe('closed');

    upsertOpenPr(db, basePr); // same head_sha, reappears in open list
    expect(getByNumber(db, 'owner/name', 1)!.pr_state).toBe('open');
  });

  it('marks PRs not in the keep-list as closed, leaves others open', () => {
    upsertOpenPr(db, basePr);
    upsertOpenPr(db, { ...basePr, prNumber: 2 });

    markClosedExcept(db, 'owner/name', [1]);

    expect(getByNumber(db, 'owner/name', 1)!.pr_state).toBe('open');
    expect(getByNumber(db, 'owner/name', 2)!.pr_state).toBe('closed');
  });

  it('closes every tracked PR when the keep-list is empty (e.g. gh returned zero open PRs)', () => {
    upsertOpenPr(db, basePr);
    upsertOpenPr(db, { ...basePr, prNumber: 2 });

    markClosedExcept(db, 'owner/name', []);

    expect(getByNumber(db, 'owner/name', 1)!.pr_state).toBe('closed');
    expect(getByNumber(db, 'owner/name', 2)!.pr_state).toBe('closed');
  });

  it('getOpenPrs only returns pr_state=open and is_draft=0', () => {
    upsertOpenPr(db, basePr);
    upsertOpenPr(db, { ...basePr, prNumber: 2, isDraft: true });
    upsertOpenPr(db, { ...basePr, prNumber: 3 });
    markClosedExcept(db, 'owner/name', [1, 2]);

    const open = getOpenPrs(db, 'owner/name');
    expect(open.map((r) => r.pr_number)).toEqual([1]);
  });

  it('metadata-only update (same head_sha) does not reset review_status back to pending', () => {
    upsertOpenPr(db, basePr);
    const row = getByNumber(db, 'owner/name', 1)!;
    markDone(db, row.id, {
      verdict: 'approve',
      severityCritical: 0,
      severityHigh: 0,
      severityMedium: 0,
      severityLow: 0,
      reviewedHeadSha: 'sha1',
      rawReportMd: '# ok',
    });
    expect(getByNumber(db, 'owner/name', 1)!.review_status).toBe('done');

    // gh pr list re-polls the same PR with unchanged head_sha and a new title
    upsertOpenPr(db, { ...basePr, title: 'Add feature (renamed)' });

    const updated = getByNumber(db, 'owner/name', 1)!;
    expect(updated.title).toBe('Add feature (renamed)');
    expect(updated.review_status).toBe('done'); // untouched by metadata sync
  });

  it('markReviewing/markDone update status and clear failure banner data path', () => {
    upsertOpenPr(db, basePr);
    const row = getByNumber(db, 'owner/name', 1)!;

    // Simulate a prior failed attempt before this successful run, to
    // verify markDone() actually clears the stale failure banner data.
    markFailed(db, row.id, 'previous attempt: copilot timed out');
    expect(getByNumber(db, 'owner/name', 1)!.error_message).toBe(
      'previous attempt: copilot timed out'
    );

    markReviewing(db, row.id);
    expect(getByNumber(db, 'owner/name', 1)!.review_status).toBe('reviewing');

    markDone(db, row.id, {
      verdict: 'needs_fix',
      severityCritical: 1,
      severityHigh: 0,
      severityMedium: 2,
      severityLow: 0,
      reviewedHeadSha: 'sha1',
      rawReportMd: '# report',
    });

    const done = getByNumber(db, 'owner/name', 1)!;
    expect(done.review_status).toBe('done');
    expect(done.verdict).toBe('needs_fix');
    expect(done.reviewed_head_sha).toBe('sha1');
    expect(done.last_reviewed_at).toBeTruthy();
    expect(done.last_attempted_at).toBeTruthy();
    expect(done.error_message).toBeNull(); // stale failure banner cleared
  });

  it('markFailed sets error fields but preserves prior success fields', () => {
    upsertOpenPr(db, basePr);
    const row = getByNumber(db, 'owner/name', 1)!;
    markDone(db, row.id, {
      verdict: 'approve',
      severityCritical: 0,
      severityHigh: 0,
      severityMedium: 0,
      severityLow: 0,
      reviewedHeadSha: 'sha1',
      rawReportMd: '# ok',
    });
    const previousReviewedAt = getByNumber(db, 'owner/name', 1)!.last_reviewed_at;

    markFailed(db, row.id, 'copilot timed out');

    const failed = getByNumber(db, 'owner/name', 1)!;
    expect(failed.review_status).toBe('failed');
    expect(failed.error_message).toBe('copilot timed out');
    expect(failed.verdict).toBe('approve'); // preserved
    expect(failed.last_reviewed_at).toBe(previousReviewedAt); // preserved
    expect(failed.last_attempted_at).toBeTruthy();
  });

  it('resetStuckReviews flips pending/reviewing rows to failed', () => {
    upsertOpenPr(db, basePr); // pending
    upsertOpenPr(db, { ...basePr, prNumber: 2 });
    markReviewing(db, getByNumber(db, 'owner/name', 2)!.id);

    resetStuckReviews(db);

    expect(getByNumber(db, 'owner/name', 1)!.review_status).toBe('failed');
    expect(getByNumber(db, 'owner/name', 1)!.error_message).toBe(
      'Interrupted by process restart'
    );
    expect(getByNumber(db, 'owner/name', 2)!.review_status).toBe('failed');
  });

  it('resetStuckReviews does not touch draft PRs left at pending (never enqueued)', () => {
    upsertOpenPr(db, { ...basePr, prNumber: 3, isDraft: true });

    resetStuckReviews(db);

    const draft = getByNumber(db, 'owner/name', 3)!;
    expect(draft.review_status).toBe('pending');
    expect(draft.error_message).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/db/pullRequests.test.ts`
Expected: FAIL — `Cannot find module './pullRequests'`.

- [ ] **Step 3: Write `src/db/pullRequests.ts`**

```typescript
import type Database from 'better-sqlite3';

export interface OpenPrInput {
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  prUrl: string;
  isDraft: boolean;
}

export interface PullRequestRow {
  id: number;
  repo: string;
  pr_number: number;
  title: string;
  author: string;
  branch: string;
  base_branch: string;
  head_sha: string;
  pr_url: string;
  is_draft: number;
  pr_state: 'open' | 'closed';
  review_status: 'pending' | 'reviewing' | 'done' | 'failed';
  verdict: string | null;
  severity_critical: number;
  severity_high: number;
  severity_medium: number;
  severity_low: number;
  reviewed_head_sha: string | null;
  last_reviewed_at: string | null;
  last_attempted_at: string | null;
  raw_report_md: string | null;
  error_message: string | null;
}

/**
 * Syncs one PR's metadata from `gh pr list` into the database. This is a
 * pure metadata sync, NOT an enqueue decision:
 * - On INSERT (first time this PR is seen), `review_status` starts at the
 *   schema default `'pending'` — including for drafts. That's harmless:
 *   a draft's row just sits at `pending` indefinitely because it's
 *   filtered out of `getOpenPrs()` (see below), the Chunk 3 poller's
 *   enqueue decision explicitly skips any row with `is_draft=1`
 *   regardless of `review_status`, and `resetStuckReviews()` (below)
 *   likewise excludes `is_draft=1` rows so a never-enqueued draft is
 *   never fabricated into a "review failed" state after a restart.
 * - On UPDATE (PR already tracked), `review_status` is deliberately left
 *   untouched here — whether an existing PR needs re-review because its
 *   `head_sha` changed is decided separately by `lib/decision.ts` in
 *   Chunk 2, which compares the freshly upserted `head_sha` against the
 *   previously stored `reviewed_head_sha` and only then flips
 *   `review_status` back to `'pending'` to enqueue it.
 */
export function upsertOpenPr(db: Database.Database, pr: OpenPrInput): void {
  db.prepare(
    `INSERT INTO pull_requests
       (repo, pr_number, title, author, branch, base_branch, head_sha, pr_url, is_draft, pr_state, review_status)
     VALUES (@repo, @prNumber, @title, @author, @branch, @baseBranch, @headSha, @prUrl, @isDraft, 'open', 'pending')
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       title = excluded.title,
       author = excluded.author,
       branch = excluded.branch,
       base_branch = excluded.base_branch,
       head_sha = excluded.head_sha,
       pr_url = excluded.pr_url,
       is_draft = excluded.is_draft,
       pr_state = 'open'`
  ).run({ ...pr, isDraft: pr.isDraft ? 1 : 0 });
}

export function markClosedExcept(
  db: Database.Database,
  repo: string,
  keepPrNumbers: number[]
): void {
  if (keepPrNumbers.length === 0) {
    // No PRs currently open for this repo (or gh returned an empty list):
    // close everything. `NOT IN ()` is invalid SQL and `NOT IN (NULL)`
    // silently matches nothing in SQLite, so this case must be handled
    // separately rather than falling through to the parameterized query.
    db.prepare(`UPDATE pull_requests SET pr_state = 'closed' WHERE repo = ?`).run(repo);
    return;
  }
  const placeholders = keepPrNumbers.map(() => '?').join(',');
  db.prepare(
    `UPDATE pull_requests SET pr_state = 'closed'
     WHERE repo = ? AND pr_number NOT IN (${placeholders})`
  ).run(repo, ...keepPrNumbers);
}

export function getOpenPrs(db: Database.Database, repo: string): PullRequestRow[] {
  return db
    .prepare(
      `SELECT * FROM pull_requests WHERE repo = ? AND pr_state = 'open' AND is_draft = 0
       ORDER BY pr_number DESC`
    )
    .all(repo) as PullRequestRow[];
}

export function getByNumber(
  db: Database.Database,
  repo: string,
  prNumber: number
): PullRequestRow | undefined {
  return db
    .prepare('SELECT * FROM pull_requests WHERE repo = ? AND pr_number = ?')
    .get(repo, prNumber) as PullRequestRow | undefined;
}

export function markReviewing(db: Database.Database, id: number): void {
  db.prepare("UPDATE pull_requests SET review_status = 'reviewing' WHERE id = ?").run(id);
}

export interface MarkDoneInput {
  verdict: string;
  severityCritical: number;
  severityHigh: number;
  severityMedium: number;
  severityLow: number;
  reviewedHeadSha: string;
  rawReportMd: string;
}

export function markDone(db: Database.Database, id: number, input: MarkDoneInput): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pull_requests SET
       review_status = 'done',
       verdict = @verdict,
       severity_critical = @severityCritical,
       severity_high = @severityHigh,
       severity_medium = @severityMedium,
       severity_low = @severityLow,
       reviewed_head_sha = @reviewedHeadSha,
       raw_report_md = @rawReportMd,
       last_reviewed_at = @now,
       last_attempted_at = @now,
       error_message = NULL
     WHERE id = @id`
  ).run({ ...input, id, now });
}

export function markFailed(db: Database.Database, id: number, errorMessage: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pull_requests SET
       review_status = 'failed',
       error_message = @errorMessage,
       last_attempted_at = @now
     WHERE id = @id`
  ).run({ id, errorMessage, now });
}

export function resetStuckReviews(db: Database.Database): void {
  // Only touches non-draft rows: draft PRs are inserted with the schema
  // default review_status='pending' too (see upsertOpenPr above), but they
  // were never actually enqueued for review (the poller skips is_draft=1
  // rows), so they must not be flipped to 'failed' here — that would
  // fabricate a bogus "review failed" banner for a PR that was never
  // reviewed in the first place.
  db.prepare(
    `UPDATE pull_requests SET
       review_status = 'failed',
       error_message = 'Interrupted by process restart',
       last_attempted_at = @now
     WHERE review_status IN ('pending', 'reviewing') AND is_draft = 0`
  ).run({ now: new Date().toISOString() });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/db/pullRequests.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/pullRequests.ts src/db/pullRequests.test.ts
git commit -m "feat(db): add pull_requests repository functions"
```

---

### Task 1.5: findings repository functions

**Files:**
- Create: `src/db/findings.ts`
- Test: `src/db/findings.test.ts`

- [ ] **Step 1: Write the failing test**

`src/db/findings.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './client';
import { upsertOpenPr, getByNumber } from './pullRequests';
import { replaceFindings, getFindingsByPrId } from './findings';

describe('findings repository', () => {
  let db: Database.Database;
  let prId: number;

  beforeEach(() => {
    db = createTestDb();
    upsertOpenPr(db, {
      repo: 'owner/name',
      prNumber: 1,
      title: 't',
      author: 'a',
      branch: 'b',
      baseBranch: 'main',
      headSha: 'sha1',
      prUrl: 'url',
      isDraft: false,
    });
    prId = getByNumber(db, 'owner/name', 1)!.id;
  });

  it('inserts findings for a PR', () => {
    replaceFindings(db, prId, [
      {
        file: 'src/a.ts',
        line: 10,
        severity: 'CRITICAL',
        summary: 'bug',
        failureScenario: 'x happens',
        evidence: 'a.ts:10',
        fixSuggestion: 'do y',
        codeSnippet: 'fix();',
      },
    ]);
    const rows = getFindingsByPrId(db, prId);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('CRITICAL');
  });

  it('replaces old findings rather than accumulating them', () => {
    replaceFindings(db, prId, [
      { file: 'a.ts', line: 1, severity: 'HIGH', summary: 'first', failureScenario: '', evidence: '', fixSuggestion: '', codeSnippet: '' },
    ]);
    replaceFindings(db, prId, [
      { file: 'b.ts', line: 2, severity: 'LOW', summary: 'second', failureScenario: '', evidence: '', fixSuggestion: '', codeSnippet: '' },
    ]);

    const rows = getFindingsByPrId(db, prId);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('second');
  });

  it('cascades delete when the parent PR row is deleted', () => {
    replaceFindings(db, prId, [
      { file: 'a.ts', line: 1, severity: 'HIGH', summary: 'x', failureScenario: '', evidence: '', fixSuggestion: '', codeSnippet: '' },
    ]);
    db.prepare('DELETE FROM pull_requests WHERE id = ?').run(prId);
    expect(getFindingsByPrId(db, prId)).toHaveLength(0);
  });

  it('returns camelCase fields, not raw snake_case DB column names', () => {
    replaceFindings(db, prId, [
      {
        file: 'a.ts',
        line: 1,
        severity: 'HIGH',
        summary: 'x',
        failureScenario: 'scenario text',
        evidence: 'evidence text',
        fixSuggestion: 'fix text',
        codeSnippet: 'snippet text',
      },
    ]);
    const [row] = getFindingsByPrId(db, prId);
    // A naive `SELECT *` would return snake_case columns (failure_scenario,
    // fix_suggestion, code_snippet) cast to this camelCase interface,
    // silently leaving these fields `undefined` at runtime even though
    // TypeScript wouldn't catch it - this test guards against that.
    expect(row.failureScenario).toBe('scenario text');
    expect(row.fixSuggestion).toBe('fix text');
    expect(row.codeSnippet).toBe('snippet text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/db/findings.test.ts`
Expected: FAIL — `Cannot find module './findings'`.

- [ ] **Step 3: Write `src/db/findings.ts`**

```typescript
import type Database from 'better-sqlite3';

export interface FindingInput {
  file: string;
  line: number;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;
  failureScenario: string;
  evidence: string;
  fixSuggestion: string;
  codeSnippet: string;
}

export interface FindingRow extends FindingInput {
  id: number;
  pull_request_id: number;
}

export function replaceFindings(
  db: Database.Database,
  pullRequestId: number,
  findings: FindingInput[]
): void {
  const tx = db.transaction((items: FindingInput[]) => {
    db.prepare('DELETE FROM findings WHERE pull_request_id = ?').run(pullRequestId);
    const insert = db.prepare(
      `INSERT INTO findings
         (pull_request_id, file, line, severity, summary, failure_scenario, evidence, fix_suggestion, code_snippet)
       VALUES (@pullRequestId, @file, @line, @severity, @summary, @failureScenario, @evidence, @fixSuggestion, @codeSnippet)`
    );
    for (const item of items) {
      insert.run({ ...item, pullRequestId });
    }
  });
  tx(findings);
}

export function getFindingsByPrId(db: Database.Database, pullRequestId: number): FindingRow[] {
  // Explicit column aliasing, not `SELECT *`: the `findings` table's
  // columns are snake_case (failure_scenario, fix_suggestion,
  // code_snippet) but `FindingRow` is camelCase to match `FindingInput`.
  // `SELECT *` would silently produce rows with `undefined` camelCase
  // fields at runtime despite the `as FindingRow` cast type-checking fine.
  return db
    .prepare(
      `SELECT id, pull_request_id, file, line, severity, summary,
              failure_scenario AS failureScenario,
              evidence,
              fix_suggestion AS fixSuggestion,
              code_snippet AS codeSnippet
       FROM findings WHERE pull_request_id = ? ORDER BY severity, line`
    )
    .all(pullRequestId) as FindingRow[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/db/findings.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/findings.ts src/db/findings.test.ts
git commit -m "feat(db): add findings repository functions"
```

---

### Task 1.6: Run full test suite for Chunk 1

- [ ] **Step 1: Run all tests**

Run: `npm run test`
Expected: All db tests pass (client, config, pullRequests, findings).

- [ ] **Step 2: Commit if any fixups were needed**

```bash
git add -A
git commit -m "test: verify chunk 1 db layer passes as a whole" --allow-empty
```

## Chunk 2: `gh` integration + pure decision/parsing logic

This chunk adds the pieces needed to decide which tracked PRs need a
review and to prepare/interpret a review run, without touching git
worktrees or spawning `copilot` yet (that's Chunk 3): the pure
enqueue-vs-skip decision logic, the `gh pr list` wrapper, the trailing-
JSON-block parser for copilot's output, and the prompt builder. The `gh`
call here only reads PR metadata — it never mutates anything on GitHub.

### Task 2.1: Pure decision logic for enqueue-vs-skip

**Files:**
- Create: `src/lib/decision.ts`
- Test: `src/lib/decision.test.ts`

The poller (Chunk 3) will call `decidePrAction()` once per already-tracked
PR row, comparing the row's `head_sha` *as it was before this poll tick's
upsert* against the freshly-fetched `head_sha` from `gh pr list`. This
must NOT be confused with `reviewed_head_sha` (which only updates on a
*successful* review): a PR whose first-ever review attempt failed has
`review_status='failed'` and `reviewed_head_sha=NULL` forever, but its
`head_sha` doesn't change just because the attempt failed — comparing
against the previous `head_sha` (not `reviewed_head_sha`) is what makes a
failed PR with no new commits correctly stay terminal (skip) instead of
being retried on every single poll tick.

- [ ] **Step 1: Write the failing test**

`src/lib/decision.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { decidePrAction, type DecisionInput } from './decision';

function input(overrides: Partial<DecisionInput>): DecisionInput {
  return {
    isDraft: false,
    previousHeadSha: 'sha1',
    newHeadSha: 'sha1',
    reviewStatus: 'done',
    ...overrides,
  };
}

describe('decidePrAction', () => {
  it('enqueues a brand new row (reviewStatus is null)', () => {
    expect(
      decidePrAction(input({ reviewStatus: null, previousHeadSha: null, newHeadSha: 'sha1' }))
    ).toBe('enqueue');
  });

  it('skips a brand new draft row', () => {
    expect(
      decidePrAction(input({ reviewStatus: null, previousHeadSha: null, isDraft: true }))
    ).toBe('skip');
  });

  it('skips any draft regardless of head_sha change', () => {
    expect(
      decidePrAction(input({ isDraft: true, previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('skip');
  });

  it('skips a row already pending (single-flight)', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'pending', previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('skip');
  });

  it('skips a row already reviewing (single-flight)', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'reviewing', previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('skip');
  });

  it('skips a done row when head_sha is unchanged', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'done', previousHeadSha: 'sha1', newHeadSha: 'sha1' }))
    ).toBe('skip');
  });

  it('enqueues a done row when head_sha changed', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'done', previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('enqueue');
  });

  it('skips a failed row when head_sha is unchanged (terminal, no auto-retry)', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'failed', previousHeadSha: 'sha1', newHeadSha: 'sha1' }))
    ).toBe('skip');
  });

  it('enqueues a failed row when head_sha changed', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'failed', previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('enqueue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/decision.test.ts`
Expected: FAIL — `Cannot find module './decision'`.

- [ ] **Step 3: Write `src/lib/decision.ts`**

```typescript
export interface DecisionInput {
  isDraft: boolean;
  /** This PR's head_sha as stored before this poll tick's upsert; null for a brand new row. */
  previousHeadSha: string | null;
  /** head_sha just fetched from `gh pr list` for this poll tick. */
  newHeadSha: string;
  /** null means this row does not exist yet (about to be INSERTed). */
  reviewStatus: 'pending' | 'reviewing' | 'done' | 'failed' | null;
}

export type Decision = 'enqueue' | 'skip';

export function decidePrAction(input: DecisionInput): Decision {
  if (input.isDraft) return 'skip'; // drafts are tracked but never reviewed

  if (input.reviewStatus === null) return 'enqueue'; // brand new PR

  // Single-flight: never re-enqueue work that's already in progress.
  if (input.reviewStatus === 'pending' || input.reviewStatus === 'reviewing') {
    return 'skip';
  }

  // reviewStatus is 'done' or 'failed' — both are terminal states until
  // the commit actually changes, or a manual re-check/retry bypasses
  // this function entirely (see Chunk 3 poller).
  if (input.previousHeadSha !== input.newHeadSha) return 'enqueue';
  return 'skip';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/decision.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/decision.ts src/lib/decision.test.ts
git commit -m "feat(lib): add pure enqueue-vs-skip decision logic"
```

---

### Task 2.2: `markPending()` on the pull_requests repository

**Files:**
- Modify: `src/db/pullRequests.ts`
- Modify: `src/db/pullRequests.test.ts`

When `decidePrAction()` returns `'enqueue'` for an *already-tracked* row
(brand new rows are already `'pending'` from `upsertOpenPr()`'s INSERT
default), the poller needs a setter to flip that row back to `'pending'`
and clear any stale failure banner, without touching the previous
successful review data (`raw_report_md`, findings, `verdict`,
`reviewed_head_sha`, `last_reviewed_at` all stay as-is until the new
review completes).

- [ ] **Step 1: Write the failing test**

Add to `src/db/pullRequests.test.ts` (import `markPending` alongside the
existing imports at the top of the file):

```typescript
  it('markPending resets status to pending and clears error, preserving prior review data', () => {
    upsertOpenPr(db, basePr);
    const row = getByNumber(db, 'owner/name', 1)!;
    markDone(db, row.id, {
      verdict: 'approve',
      severityCritical: 0,
      severityHigh: 0,
      severityMedium: 0,
      severityLow: 0,
      reviewedHeadSha: 'sha1',
      rawReportMd: '# ok',
    });
    markFailed(db, row.id, 'transient error');

    markPending(db, row.id);

    const pending = getByNumber(db, 'owner/name', 1)!;
    expect(pending.review_status).toBe('pending');
    expect(pending.error_message).toBeNull();
    expect(pending.verdict).toBe('approve'); // preserved until new review completes
    expect(pending.reviewed_head_sha).toBe('sha1'); // preserved
    expect(pending.raw_report_md).toBe('# ok'); // preserved
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/db/pullRequests.test.ts`
Expected: FAIL — `markPending is not a function` / `Cannot find export`.

- [ ] **Step 3: Add `markPending()` to `src/db/pullRequests.ts`**

Add this export alongside the existing `markReviewing`/`markDone`/`markFailed`:

```typescript
export function markPending(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE pull_requests SET
       review_status = 'pending',
       error_message = NULL
     WHERE id = @id`
  ).run({ id });
}
```

Also add `markPending` to the `import { ... } from './pullRequests'` list
at the top of `src/db/pullRequests.test.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/db/pullRequests.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/pullRequests.ts src/db/pullRequests.test.ts
git commit -m "feat(db): add markPending to re-enqueue a tracked PR for review"
```

---

### Task 2.3: `gh pr list` wrapper

**Files:**
- Create: `src/lib/gh.ts`
- Test: `src/lib/gh.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/gh.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { fetchOpenPrs } = await import('./gh');

describe('fetchOpenPrs', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('parses gh pr list JSON output into a typed PR list', async () => {
    const fixture = [
      {
        number: 1,
        title: 'Add feature',
        author: { login: 'alice' },
        headRefName: 'feat/x',
        baseRefName: 'main',
        headRefOid: 'sha1',
        url: 'https://github.com/o/r/pull/1',
        isDraft: false,
      },
    ];
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, JSON.stringify(fixture), ''));

    const result = await fetchOpenPrs('o/r');

    expect(result).toEqual([
      {
        number: 1,
        title: 'Add feature',
        author: 'alice',
        headRefName: 'feat/x',
        baseRefName: 'main',
        headRefOid: 'sha1',
        url: 'https://github.com/o/r/pull/1',
        isDraft: false,
      },
    ]);
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      [
        'pr', 'list',
        '--repo', 'o/r',
        '--state', 'open',
        '--json', 'number,title,author,headRefName,baseRefName,headRefOid,url,isDraft',
      ],
      expect.any(Function)
    );
  });

  it('returns an empty array when there are no open PRs', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '[]', ''));
    const result = await fetchOpenPrs('o/r');
    expect(result).toEqual([]);
  });

  it('rejects when gh exits non-zero (e.g. auth/network error)', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(new Error('gh: command not found'), '', ''));
    await expect(fetchOpenPrs('o/r')).rejects.toThrow('gh: command not found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/gh.test.ts`
Expected: FAIL — `Cannot find module './gh'`.

- [ ] **Step 3: Write `src/lib/gh.ts`**

```typescript
import { execFile } from 'node:child_process';

export interface GhPrListItem {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url: string;
  isDraft: boolean;
}

interface RawGhPr {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url: string;
  isDraft: boolean;
}

// A hand-written Promise wrapper rather than `util.promisify(execFile)`:
// promisify's multi-value (stdout, stderr) support for execFile relies on
// Node internally tagging the real `execFile` with the
// `util.promisify.custom` symbol. A plain callback-style mock (as used in
// tests) doesn't carry that symbol, so `promisify` would silently fall
// back to resolving with only the raw stdout *string* instead of
// `{ stdout, stderr }` — breaking both real usage assumptions and test
// mockability. This wrapper works identically against the real
// `execFile` and against a simple `(cmd, args, callback) => ...` mock.
function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

// Read-only against the remote: `gh pr list` only reads PR metadata, it
// never mutates anything on GitHub.
export async function fetchOpenPrs(repo: string): Promise<GhPrListItem[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', repo,
    '--state', 'open',
    '--json', 'number,title,author,headRefName,baseRefName,headRefOid,url,isDraft',
  ]);
  const raw = JSON.parse(stdout) as RawGhPr[];
  return raw.map((r) => ({
    number: r.number,
    title: r.title,
    author: r.author.login,
    headRefName: r.headRefName,
    baseRefName: r.baseRefName,
    headRefOid: r.headRefOid,
    url: r.url,
    isDraft: r.isDraft,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/gh.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gh.ts src/lib/gh.test.ts
git commit -m "feat(lib): add gh pr list wrapper"
```

---

### Task 2.4: Parse copilot's review output

**Files:**
- Create: `src/lib/parseReviewOutput.ts`
- Test: `src/lib/parseReviewOutput.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/parseReviewOutput.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parseReviewOutput } from './parseReviewOutput';

const wellFormed = `# Code Review

## Executive Summary
Some markdown report text.

\`\`\`json
{
  "verdict": "needs_fix",
  "findings": [
    {
      "file": "src/auth.ts",
      "line": 42,
      "severity": "HIGH",
      "summary": "Missing input validation",
      "failureScenario": "Malformed input crashes the server",
      "evidence": "line 42 reads req.body.token without checking type",
      "fixSuggestion": "Validate token is a non-empty string before use",
      "codeSnippet": "if (typeof token !== 'string') throw new Error('invalid token');"
    }
  ]
}
\`\`\`
`;

describe('parseReviewOutput', () => {
  it('extracts verdict and findings from a well-formed trailing JSON block', () => {
    const result = parseReviewOutput(wellFormed);
    expect(result.verdict).toBe('needs_fix');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'src/auth.ts',
      line: 42,
      severity: 'HIGH',
      summary: 'Missing input validation',
    });
    expect(result.rawReportMd).toBe(wellFormed);
  });

  it('falls back to needs_review with no findings when the JSON block is missing', () => {
    const noJson = '# Code Review\n\nJust markdown, no fenced block.';
    const result = parseReviewOutput(noJson);
    expect(result.verdict).toBe('needs_review');
    expect(result.findings).toEqual([]);
    expect(result.rawReportMd).toBe(noJson);
  });

  it('falls back to needs_review with no findings when the JSON block is malformed', () => {
    const badJson = '# Report\n\n```json\n{ this is not valid json \n```\n';
    const result = parseReviewOutput(badJson);
    expect(result.verdict).toBe('needs_review');
    expect(result.findings).toEqual([]);
    expect(result.rawReportMd).toBe(badJson);
  });

  it('falls back to needs_review when JSON is valid but has an unexpected shape', () => {
    const wrongShape = '# Report\n\n```json\n{"verdict": "bogus", "findings": "not-an-array"}\n```\n';
    const result = parseReviewOutput(wrongShape);
    expect(result.verdict).toBe('needs_review');
    expect(result.findings).toEqual([]);
  });

  it('defaults missing optional finding fields to null rather than throwing', () => {
    const sparse = '# Report\n\n```json\n{"verdict": "approve", "findings": [{"summary": "ok", "severity": "LOW"}]}\n```\n';
    const result = parseReviewOutput(sparse);
    expect(result.verdict).toBe('approve');
    expect(result.findings[0]).toEqual({
      file: null,
      line: null,
      severity: 'LOW',
      summary: 'ok',
      failureScenario: null,
      evidence: null,
      fixSuggestion: null,
      codeSnippet: null,
    });
  });

  it('drops individual malformed finding entries but keeps well-formed ones from the same block', () => {
    const mixed = `# Report

\`\`\`json
{
  "verdict": "needs_fix",
  "findings": [
    { "summary": "missing severity entirely" },
    { "summary": "bad severity value", "severity": "SUPER_BAD" },
    { "severity": "HIGH" },
    null,
    "not an object either",
    { "summary": "valid finding", "severity": "HIGH", "file": "a.ts", "line": 1 }
  ]
}
\`\`\`
`;
    const result = parseReviewOutput(mixed);
    expect(result.verdict).toBe('needs_fix');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ summary: 'valid finding', severity: 'HIGH' });
  });

  it('does not parse a ```json block that is not the trailing content', () => {
    const midText = '# Report\n\n```json\n{"verdict": "approve", "findings": []}\n```\n\nSome trailing prose after the block.';
    const result = parseReviewOutput(midText);
    expect(result.verdict).toBe('needs_review');
    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/parseReviewOutput.test.ts`
Expected: FAIL — `Cannot find module './parseReviewOutput'`.

- [ ] **Step 3: Write `src/lib/parseReviewOutput.ts`**

```typescript
export type Verdict = 'approve' | 'needs_fix' | 'needs_review';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ParsedFinding {
  file: string | null;
  line: number | null;
  severity: Severity;
  summary: string;
  failureScenario: string | null;
  evidence: string | null;
  fixSuggestion: string | null;
  codeSnippet: string | null;
}

export interface ParsedReview {
  verdict: Verdict;
  findings: ParsedFinding[];
  rawReportMd: string;
}

const VALID_VERDICTS: Verdict[] = ['approve', 'needs_fix', 'needs_review'];
const VALID_SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
// Matches a fenced ```json ... ``` block anchored at the very end of the
// output (trailing whitespace allowed), per the prompt contract in
// reviewPrompt.ts.
const TRAILING_JSON_BLOCK = /```json\s*([\s\S]*?)\s*```\s*$/;

function emptyResult(rawReportMd: string): ParsedReview {
  return { verdict: 'needs_review', findings: [], rawReportMd };
}

export function parseReviewOutput(rawOutput: string): ParsedReview {
  const match = rawOutput.match(TRAILING_JSON_BLOCK);
  if (!match) return emptyResult(rawOutput);

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return emptyResult(rawOutput);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !VALID_VERDICTS.includes((parsed as { verdict?: string }).verdict as Verdict) ||
    !Array.isArray((parsed as { findings?: unknown }).findings)
  ) {
    return emptyResult(rawOutput);
  }

  const { verdict, findings: rawFindings } = parsed as {
    verdict: Verdict;
    findings: Array<Record<string, unknown>>;
  };

  // A finding entry must have at least a non-empty `summary` and a valid
  // `severity` to be usable — rather than silently coercing bad data
  // (e.g. defaulting an invalid severity to LOW), entries missing these
  // required fields are dropped so we don't persist misleading findings
  // or skew severity counts. This only drops the individual malformed
  // entry; the rest of a well-formed block (and its verdict) still apply.
  const findings: ParsedFinding[] = rawFindings
    .filter(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        typeof f.summary === 'string' &&
        f.summary.length > 0 &&
        VALID_SEVERITIES.includes(f.severity as Severity)
    )
    .map((f) => ({
      file: typeof f.file === 'string' ? f.file : null,
      line: typeof f.line === 'number' ? f.line : null,
      severity: f.severity as Severity,
      summary: f.summary as string,
      failureScenario: typeof f.failureScenario === 'string' ? f.failureScenario : null,
      evidence: typeof f.evidence === 'string' ? f.evidence : null,
      fixSuggestion: typeof f.fixSuggestion === 'string' ? f.fixSuggestion : null,
      codeSnippet: typeof f.codeSnippet === 'string' ? f.codeSnippet : null,
    }));

  return { verdict, findings, rawReportMd: rawOutput };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/parseReviewOutput.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parseReviewOutput.ts src/lib/parseReviewOutput.test.ts
git commit -m "feat(lib): parse copilot review output into structured findings"
```

---

### Task 2.5: Build the review prompt

**Files:**
- Create: `src/lib/reviewPrompt.ts`
- Test: `src/lib/reviewPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/reviewPrompt.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildReviewPrompt } from './reviewPrompt';

describe('buildReviewPrompt', () => {
  it('includes PR identity, branch info, and the JSON contract', () => {
    const prompt = buildReviewPrompt({
      repo: 'owner/name',
      prNumber: 42,
      title: 'Add login form',
      branch: 'feat/login',
      baseBranch: 'main',
    });

    expect(prompt).toContain('owner/name');
    expect(prompt).toContain('#42');
    expect(prompt).toContain('Add login form');
    expect(prompt).toContain('feat/login');
    expect(prompt).toContain('main');
    expect(prompt).toContain('local-advanced-code-review');
    expect(prompt).toContain('```json');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"findings"');
    expect(prompt.toLowerCase()).toContain('do not push');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/reviewPrompt.test.ts`
Expected: FAIL — `Cannot find module './reviewPrompt'`.

- [ ] **Step 3: Write `src/lib/reviewPrompt.ts`**

```typescript
export interface ReviewPromptInput {
  repo: string;
  prNumber: number;
  title: string;
  branch: string;
  baseBranch: string;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  return `You are reviewing pull request #${input.prNumber} "${input.title}" in ${input.repo}.
Branch: ${input.branch} -> ${input.baseBranch}

This working directory is a local, read-only git worktree checked out at
this PR's head commit. Do not push, commit, or modify any remote branch —
only read the code to produce a review.

Invoke the local-advanced-code-review skill and perform its full review
flow against the diff between ${input.baseBranch} and this branch.

After the normal markdown report, append exactly one trailing fenced code
block labeled \`\`\`json containing ONLY this JSON shape (no commentary
after it, no markdown inside it):

\`\`\`json
{
  "verdict": "approve" | "needs_fix" | "needs_review",
  "findings": [
    {
      "file": "path/to/file",
      "line": 123,
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "summary": "one-line description",
      "failureScenario": "what goes wrong and when",
      "evidence": "why you believe this, e.g. quoted code or trace",
      "fixSuggestion": "concrete suggested fix",
      "codeSnippet": "optional short snippet illustrating the fix"
    }
  ]
}
\`\`\`
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/reviewPrompt.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reviewPrompt.ts src/lib/reviewPrompt.test.ts
git commit -m "feat(lib): build the headless review prompt"
```

---

### Task 2.6: Run full test suite for Chunk 2

- [ ] **Step 1: Run the whole suite**

Run: `npm run test`
Expected: all Chunk 1 and Chunk 2 test files pass (client: 2, config: 3,
pullRequests: 11, findings: 4, decision: 9, gh: 3, parseReviewOutput: 7,
reviewPrompt: 1 — 40 tests total).

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "test: verify chunk 2 decision/gh/parse/prompt layer passes as a whole" --allow-empty
```

---

## Chunk 3: Repo cache + review execution

This chunk adds the local git worktree management and the headless
`copilot -p` process runner — the two remaining pieces needed before
Chunk 4 can wire everything into the poller loop. As with Chunk 2, every
git operation here is read-only against the remote (`clone --bare` and
`fetch` only).

### Task 3.1: Repo cache — bare clone, fetch, and per-PR worktrees

**Files:**
- Create: `src/lib/repoCache.ts`
- Test: `src/lib/repoCache.test.ts`

Layout (matches the spec): a single bare/mirror clone per repo at
`~/.pr-review-dashboard/repos/<owner>__<name>/repo.git`, with one worktree
per PR at `.../worktrees/pr-<number>`. Only `git clone --bare` and
`git fetch` ever touch the remote; `git worktree add` operates purely
locally against the bare repo.

- [ ] **Step 1: Write the failing test**

`src/lib/repoCache.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn((_cmd, _args, cb) => cb(null, '', ''));
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  },
}));

const {
  getBareRepoPath,
  getWorktreePath,
  ensureBareRepo,
  addOrUpdateWorktree,
} = await import('./repoCache');

describe('repoCache paths', () => {
  it('derives the bare repo path from owner/name, replacing the slash', () => {
    expect(getBareRepoPath('owner/name')).toMatch(/owner__name[/\\]repo\.git$/);
  });

  it('derives a per-PR worktree path', () => {
    expect(getWorktreePath('owner/name', 42)).toMatch(/worktrees[/\\]pr-42$/);
  });
});

describe('ensureBareRepo', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
  });

  it('clones --bare when the repo does not exist locally yet', async () => {
    existsSyncMock.mockReturnValue(false);

    await ensureBareRepo('owner/name');

    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone', '--bare']),
      expect.any(Function)
    );
  });

  it('fetches instead of cloning when the bare repo already exists', async () => {
    existsSyncMock.mockReturnValue(true);

    await ensureBareRepo('owner/name');

    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['fetch']),
      expect.any(Function)
    );
    expect(execFileMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone']),
      expect.any(Function)
    );
  });
});

describe('addOrUpdateWorktree', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
  });

  it('adds a fresh worktree when none exists for this PR yet', async () => {
    existsSyncMock.mockReturnValue(false);

    const dir = await addOrUpdateWorktree('owner/name', 42, 'sha1');

    expect(dir).toMatch(/worktrees[/\\]pr-42$/);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['worktree', 'add', '--detach', dir, 'sha1']));
    expect(args).not.toContain('--force');
  });

  it('force re-points an existing worktree to the new head_sha', async () => {
    existsSyncMock.mockReturnValue(true);

    const dir = await addOrUpdateWorktree('owner/name', 42, 'sha2');

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining(['worktree', 'add', '--force', '--detach', dir, 'sha2'])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/repoCache.test.ts`
Expected: FAIL — `Cannot find module './repoCache'`.

- [ ] **Step 3: Write `src/lib/repoCache.ts`**

```typescript
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// See gh.ts for why this is a hand-written wrapper rather than
// `util.promisify(execFile)` (promisify's execFile-specific behavior
// depends on a symbol real Node sets internally, which plain test mocks
// don't carry).
function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export function getReposRootDir(): string {
  return (
    process.env.PR_DASHBOARD_REPOS_DIR ??
    path.join(os.homedir(), '.pr-review-dashboard', 'repos')
  );
}

function repoDirName(repo: string): string {
  return repo.replace('/', '__');
}

export function getBareRepoPath(repo: string): string {
  return path.join(getReposRootDir(), repoDirName(repo), 'repo.git');
}

export function getWorktreePath(repo: string, prNumber: number): string {
  return path.join(getReposRootDir(), repoDirName(repo), 'worktrees', `pr-${prNumber}`);
}

// Read-only against the remote: only `clone --bare` (first use) and
// `fetch` (subsequent polls) are ever run against the remote. Nothing
// here ever pushes or mutates a remote ref.
export async function ensureBareRepo(repo: string): Promise<void> {
  const bareDir = getBareRepoPath(repo);
  if (fs.existsSync(bareDir)) {
    await execFileAsync('git', [
      '--git-dir', bareDir,
      'fetch', 'origin', '+refs/heads/*:refs/heads/*',
    ]);
    return;
  }
  fs.mkdirSync(path.dirname(bareDir), { recursive: true });
  await execFileAsync('git', ['clone', '--bare', `https://github.com/${repo}.git`, bareDir]);
}

// Purely local: `git worktree add` never touches the remote. Re-points an
// existing worktree with `--force` when re-reviewing at a new head_sha.
export async function addOrUpdateWorktree(
  repo: string,
  prNumber: number,
  headSha: string
): Promise<string> {
  const bareDir = getBareRepoPath(repo);
  const worktreeDir = getWorktreePath(repo, prNumber);
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

  const args = ['--git-dir', bareDir, 'worktree', 'add'];
  if (fs.existsSync(worktreeDir)) args.push('--force');
  args.push('--detach', worktreeDir, headSha);

  await execFileAsync('git', args);
  return worktreeDir;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/repoCache.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/repoCache.ts src/lib/repoCache.test.ts
git commit -m "feat(lib): add bare-clone/fetch/worktree repo cache (read-only against remote)"
```

---

### Task 3.2: Run `copilot -p` headless with a timeout

**Files:**
- Create: `src/lib/reviewRunner.ts`
- Test: `src/lib/reviewRunner.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/reviewRunner.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(signal?: string) {
    this.killed = true;
    this.emit('__killed__', signal);
  }
}

let fakeChild: FakeChildProcess;
const spawnMock = vi.fn(() => fakeChild);
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { runReview } = await import('./reviewRunner');

describe('runReview', () => {
  beforeEach(() => {
    fakeChild = new FakeChildProcess();
    spawnMock.mockClear();
  });

  it('resolves success=true with captured stdout on a zero exit code', async () => {
    const promise = runReview('/tmp/worktree', 'review this PR');
    fakeChild.stdout.emit('data', Buffer.from('# Report\n'));
    fakeChild.emit('close', 0);

    const result = await promise;
    expect(result).toEqual({ success: true, output: '# Report\n' });
    expect(spawnMock).toHaveBeenCalledWith('copilot', ['-p', 'review this PR'], { cwd: '/tmp/worktree' });
  });

  it('resolves success=false with the exit code and stderr on a non-zero exit', async () => {
    const promise = runReview('/tmp/worktree', 'review this PR');
    fakeChild.stdout.emit('data', Buffer.from('partial output'));
    fakeChild.stderr.emit('data', Buffer.from('boom'));
    fakeChild.emit('close', 1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.output).toBe('partial output');
    expect(result.errorMessage).toContain('exited with code 1');
    expect(result.errorMessage).toContain('boom');
  });

  it('resolves success=false when the process errors to spawn (e.g. binary not found)', async () => {
    const promise = runReview('/tmp/worktree', 'review this PR');
    fakeChild.emit('error', new Error('spawn copilot ENOENT'));

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('spawn copilot ENOENT');
  });

  it('kills the process and resolves success=false after the timeout elapses', async () => {
    vi.useFakeTimers();
    const promise = runReview('/tmp/worktree', 'review this PR', 1000);

    vi.advanceTimersByTime(1000);
    expect(fakeChild.killed).toBe(true);
    fakeChild.emit('close', null); // killed processes report a null exit code

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/reviewRunner.test.ts`
Expected: FAIL — `Cannot find module './reviewRunner'`.

- [ ] **Step 3: Write `src/lib/reviewRunner.ts`**

```typescript
import { spawn } from 'node:child_process';

export interface RunReviewResult {
  success: boolean;
  output: string;
  errorMessage?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, per spec

export function runReview(
  cwd: string,
  prompt: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<RunReviewResult> {
  return new Promise((resolve) => {
    const child = spawn('copilot', ['-p', prompt], { cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const settle = (result: RunReviewResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: Error) => {
      settle({ success: false, output: stdout, errorMessage: err.message });
    });

    child.on('close', (code: number | null) => {
      if (timedOut) {
        settle({
          success: false,
          output: stdout,
          errorMessage: `copilot timed out after ${timeoutMs}ms`,
        });
        return;
      }
      if (code !== 0) {
        settle({
          success: false,
          output: stdout,
          errorMessage: `copilot exited with code ${code}: ${stderr}`,
        });
        return;
      }
      settle({ success: true, output: stdout });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/reviewRunner.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reviewRunner.ts src/lib/reviewRunner.test.ts
git commit -m "feat(lib): spawn copilot -p headless with a timeout"
```
---

### Task 3.3: Run full test suite for Chunk 3

- [ ] **Step 1: Run the whole suite**

Run: `npm run test`
Expected: all Chunk 1, 2, and 3 test files pass (client: 2, config: 3,
pullRequests: 11, findings: 3, decision: 9, gh: 3, parseReviewOutput: 7,
reviewPrompt: 1, repoCache: 6, reviewRunner: 4 — 50 tests total).

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "test: verify chunk 3 repo cache and review execution passes as a whole" --allow-empty
```

---

## Chunk 4: Poller orchestration + cron scheduling

This chunk wires Chunks 1–3 together into the actual poll loop: fetching
open PRs, deciding what needs review, running reviews serially with the
single-flight rule, and registering the whole thing on a 5-minute cron
inside the single Next.js process. It also adds startup-time validation
of `TARGET_REPO` and crash recovery for rows stuck `pending`/`reviewing`
from a previous process.

### Task 4.1: `getPendingPrs()` on the pull_requests repository

**Files:**
- Modify: `src/db/pullRequests.ts`
- Modify: `src/db/pullRequests.test.ts`

The poller needs to fetch the queue of PRs awaiting review after each
poll's upsert/decision pass.

- [ ] **Step 1: Write the failing test**

Add to `src/db/pullRequests.test.ts` (import `getPendingPrs` alongside the
existing imports):

```typescript
  it('getPendingPrs returns only pending, non-draft rows for the given repo, oldest first', () => {
    upsertOpenPr(db, basePr); // pending
    upsertOpenPr(db, { ...basePr, prNumber: 2 });
    markReviewing(db, getByNumber(db, 'owner/name', 2)!.id); // not pending anymore
    upsertOpenPr(db, { ...basePr, prNumber: 3 }); // pending
    upsertOpenPr(db, { ...basePr, prNumber: 4, isDraft: true }); // pending but a draft — never queued
    upsertOpenPr(db, { ...basePr, repo: 'other/repo', prNumber: 1 }); // different repo

    const pending = getPendingPrs(db, 'owner/name');

    expect(pending.map((r) => r.pr_number)).toEqual([1, 3]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/db/pullRequests.test.ts`
Expected: FAIL — `getPendingPrs is not a function`.

- [ ] **Step 3: Add `getPendingPrs()` to `src/db/pullRequests.ts`**

```typescript
// Excludes drafts: a draft PR's row can sit at review_status='pending'
// indefinitely (upsertOpenPr's insert default, see Chunk 1), but drafts
// are never actually supposed to be reviewed or shown — this is the
// query the poller's queue-processing loop uses, so it must filter them
// out here rather than relying on callers to remember to do so.
export function getPendingPrs(db: Database.Database, repo: string): PullRequestRow[] {
  return db
    .prepare(
      `SELECT * FROM pull_requests WHERE repo = ? AND review_status = 'pending' AND is_draft = 0
       ORDER BY id ASC`
    )
    .all(repo) as PullRequestRow[];
}
```

Also add `getPendingPrs` to the import list at the top of
`src/db/pullRequests.test.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/db/pullRequests.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/pullRequests.ts src/db/pullRequests.test.ts
git commit -m "feat(db): add getPendingPrs to fetch the review queue"
```

---

### Task 4.2: Poll-tick mutex

**Files:**
- Create: `src/lib/queue.ts`
- Test: `src/lib/queue.test.ts`

This is distinct from the single-flight rule already enforced by
`decision.ts`/`review_status` (which prevents re-enqueuing one PR that's
already `pending`/`reviewing`). This mutex prevents two *entire poll
ticks* from running concurrently — e.g. if a slow `copilot` invocation is
still processing the queue from the previous tick when the next 5-minute
cron fires, the new tick must be skipped entirely rather than starting a
second overlapping poll. Uses a `globalThis`-keyed flag (not a plain
module-level variable) for the same reason `instrumentation.ts` needs one
in Task 4.5: Next.js dev mode can reload this module without restarting
the process, which would reset a plain module-level variable but not a
`globalThis` property.

- [ ] **Step 1: Write the failing test**

`src/lib/queue.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { isPollInProgress, withPollLock } from './queue';

describe('poll-tick mutex', () => {
  beforeEach(() => {
    // Reset the globalThis-keyed flag between tests.
    (globalThis as any).__prDashboardPollInProgress = undefined;
  });

  it('is not in progress initially', () => {
    expect(isPollInProgress()).toBe(false);
  });

  it('runs the callback and marks in-progress for its duration', async () => {
    let sawInProgress = false;
    await withPollLock(async () => {
      sawInProgress = isPollInProgress();
    });
    expect(sawInProgress).toBe(true);
    expect(isPollInProgress()).toBe(false); // released after completion
  });

  it('releases the lock even if the callback throws', async () => {
    await expect(
      withPollLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isPollInProgress()).toBe(false);
  });

  it('skips a second overlapping call while the first is still running', async () => {
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const firstCallPromise = withPollLock(async () => {
      await firstDone;
      return 'first-result';
    });

    // Second call happens while the first is still in-flight.
    const secondResult = await withPollLock(async () => 'second-result');
    expect(secondResult).toBe('skipped');

    resolveFirst();
    const firstResult = await firstCallPromise;
    expect(firstResult).toBe('first-result');
    expect(isPollInProgress()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/queue.test.ts`
Expected: FAIL — `Cannot find module './queue'`.

- [ ] **Step 3: Write `src/lib/queue.ts`**

```typescript
declare global {
  // eslint-disable-next-line no-var
  var __prDashboardPollInProgress: boolean | undefined;
}

export function isPollInProgress(): boolean {
  return globalThis.__prDashboardPollInProgress === true;
}

/**
 * Runs `fn` only if no other poll tick is currently in progress. Returns
 * `'skipped'` immediately (without calling `fn`) if one is. The lock is
 * always released — even if `fn` throws — so a crashed poll tick can
 * never permanently wedge future ticks.
 */
export async function withPollLock<T>(fn: () => Promise<T>): Promise<T | 'skipped'> {
  if (isPollInProgress()) return 'skipped';
  globalThis.__prDashboardPollInProgress = true;
  try {
    return await fn();
  } finally {
    globalThis.__prDashboardPollInProgress = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/queue.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue.ts src/lib/queue.test.ts
git commit -m "feat(lib): add poll-tick mutex to prevent overlapping poll ticks"
```

---

### Task 4.3: Poller orchestration

**Files:**
- Create: `src/lib/poller.ts`
- Test: `src/lib/poller.test.ts`

This is the integration point: given a real (in-memory, for tests)
SQLite DB and a target repo, `runPollTick()` fetches open PRs, upserts
and decides which need review, processes the review queue serially, and
records poll success/failure in `config`. `gh`, `repoCache`, and
`reviewRunner` are mocked in this test; the DB layer is exercised for
real against an in-memory instance so the whole data-flow path is
verified end-to-end except for the actual external processes.

- [ ] **Step 1: Write the failing test**

`src/lib/poller.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../db/client';
import { getByNumber, getOpenPrs } from '../db/pullRequests';
import { getConfig } from '../db/config';
import { getFindingsByPrId } from '../db/findings';

const fetchOpenPrsMock = vi.fn();
vi.mock('./gh', () => ({ fetchOpenPrs: (...args: unknown[]) => fetchOpenPrsMock(...args) }));

const ensureBareRepoMock = vi.fn().mockResolvedValue(undefined);
const addOrUpdateWorktreeMock = vi.fn().mockResolvedValue('/tmp/worktrees/pr-1');
vi.mock('./repoCache', () => ({
  ensureBareRepo: (...args: unknown[]) => ensureBareRepoMock(...args),
  addOrUpdateWorktree: (...args: unknown[]) => addOrUpdateWorktreeMock(...args),
}));

const runReviewMock = vi.fn();
vi.mock('./reviewRunner', () => ({ runReview: (...args: unknown[]) => runReviewMock(...args) }));

const { runPollTick } = await import('./poller');

const basePrFromGh = {
  number: 1,
  title: 'Add feature',
  author: 'alice',
  headRefName: 'feat/x',
  baseRefName: 'main',
  headRefOid: 'sha1',
  url: 'https://github.com/owner/name/pull/1',
  isDraft: false,
};

describe('runPollTick', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    fetchOpenPrsMock.mockReset();
    ensureBareRepoMock.mockClear();
    addOrUpdateWorktreeMock.mockClear();
    runReviewMock.mockReset();
  });

  it('reviews a brand new PR end-to-end and records a successful review', async () => {
    fetchOpenPrsMock.mockResolvedValue([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: true,
      output: `# Report\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });

    await runPollTick(db, 'owner/name');

    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('done');
    expect(row.verdict).toBe('approve');
    expect(row.reviewed_head_sha).toBe('sha1');
    expect(getConfig(db, 'last_poll_status')).toBe('ok');
    expect(ensureBareRepoMock).toHaveBeenCalledWith('owner/name');
    expect(addOrUpdateWorktreeMock).toHaveBeenCalledWith('owner/name', 1, 'sha1');
  });

  it('skips a draft PR entirely (tracked but never reviewed)', async () => {
    fetchOpenPrsMock.mockResolvedValue([{ ...basePrFromGh, isDraft: true }]);

    await runPollTick(db, 'owner/name');

    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('pending'); // insert default, never actually run
    expect(runReviewMock).not.toHaveBeenCalled();
    expect(getOpenPrs(db, 'owner/name')).toEqual([]); // filtered out of the visible list
  });

  it('re-reviews an existing PR when head_sha changed, storing new findings and clearing old ones', async () => {
    fetchOpenPrsMock.mockResolvedValueOnce([basePrFromGh]);
    runReviewMock.mockResolvedValueOnce({
      success: true,
      output: `# R1\n\n\`\`\`json\n{"verdict": "needs_fix", "findings": [{"summary": "old finding", "severity": "HIGH"}]}\n\`\`\`\n`,
    });
    await runPollTick(db, 'owner/name');
    const firstRow = getByNumber(db, 'owner/name', 1)!;
    expect(getFindingsByPrId(db, firstRow.id)).toHaveLength(1);

    fetchOpenPrsMock.mockResolvedValueOnce([{ ...basePrFromGh, headRefOid: 'sha2' }]);
    runReviewMock.mockResolvedValueOnce({
      success: true,
      output: `# R2\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });
    await runPollTick(db, 'owner/name');

    const secondRow = getByNumber(db, 'owner/name', 1)!;
    expect(secondRow.reviewed_head_sha).toBe('sha2');
    expect(secondRow.verdict).toBe('approve');
    expect(getFindingsByPrId(db, secondRow.id)).toHaveLength(0); // old finding replaced
    expect(runReviewMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-review an unchanged PR on a second poll tick', async () => {
    fetchOpenPrsMock.mockResolvedValue([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: true,
      output: `# R\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });

    await runPollTick(db, 'owner/name');
    await runPollTick(db, 'owner/name');

    expect(runReviewMock).toHaveBeenCalledTimes(1);
  });

  it('marks a PR failed when the review run fails, preserving no prior successful data to lose', async () => {
    fetchOpenPrsMock.mockResolvedValue([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: false,
      output: '',
      errorMessage: 'copilot timed out after 600000ms',
    });

    await runPollTick(db, 'owner/name');

    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('failed');
    expect(row.error_message).toBe('copilot timed out after 600000ms');
    expect(row.reviewed_head_sha).toBeNull();
    expect(row.last_reviewed_at).toBeNull();
  });

  it('marks the poll itself failed and leaves existing data untouched when gh pr list throws', async () => {
    fetchOpenPrsMock.mockResolvedValue([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: true,
      output: `# R\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });
    await runPollTick(db, 'owner/name'); // establish a successful baseline

    fetchOpenPrsMock.mockRejectedValueOnce(new Error('gh: authentication required'));
    await runPollTick(db, 'owner/name');

    expect(getConfig(db, 'last_poll_status')).toBe('error');
    expect(getConfig(db, 'last_poll_error')).toBe('gh: authentication required');
    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('done'); // untouched by the failed poll
  });

  it('marks PRs absent from the gh result as closed', async () => {
    fetchOpenPrsMock.mockResolvedValueOnce([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: true,
      output: `# R\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });
    await runPollTick(db, 'owner/name');

    fetchOpenPrsMock.mockResolvedValueOnce([]); // PR #1 merged/closed upstream
    await runPollTick(db, 'owner/name');

    expect(getByNumber(db, 'owner/name', 1)!.pr_state).toBe('closed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/poller.test.ts`
Expected: FAIL — `Cannot find module './poller'`.

- [ ] **Step 3: Write `src/lib/poller.ts`**

```typescript
import type Database from 'better-sqlite3';
import { fetchOpenPrs } from './gh';
import { ensureBareRepo, addOrUpdateWorktree } from './repoCache';
import { runReview } from './reviewRunner';
import { buildReviewPrompt } from './reviewPrompt';
import { parseReviewOutput } from './parseReviewOutput';
import { decidePrAction } from './decision';
import { getConfig, setConfig } from '../db/config';
import {
  upsertOpenPr,
  markClosedExcept,
  markPending,
  markReviewing,
  markDone,
  markFailed,
  getByNumber,
  getPendingPrs,
} from '../db/pullRequests';
import { replaceFindings, type FindingInput } from '../db/findings';

const REVIEW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, per spec

export async function runPollTick(db: Database.Database, repo: string): Promise<void> {
  let prs;
  try {
    prs = await fetchOpenPrs(repo);
  } catch (err) {
    setConfig(db, 'last_poll_status', 'error');
    setConfig(db, 'last_poll_error', err instanceof Error ? err.message : String(err));
    return; // this tick's upsert/close/enqueue step is skipped entirely
  }

  const keepPrNumbers: number[] = [];
  for (const pr of prs) {
    keepPrNumbers.push(pr.number);
    const existing = getByNumber(db, repo, pr.number);
    const previousHeadSha = existing?.head_sha ?? null;
    const reviewStatus = existing?.review_status ?? null;

    upsertOpenPr(db, {
      repo,
      prNumber: pr.number,
      title: pr.title,
      author: pr.author,
      branch: pr.headRefName,
      baseBranch: pr.baseRefName,
      headSha: pr.headRefOid,
      prUrl: pr.url,
      isDraft: pr.isDraft,
    });

    // Brand new rows are already 'pending' from upsertOpenPr's INSERT
    // default; only an *existing* tracked row needs to be explicitly
    // flipped back to 'pending' here.
    if (existing) {
      const decision = decidePrAction({
        isDraft: pr.isDraft,
        previousHeadSha,
        newHeadSha: pr.headRefOid,
        reviewStatus,
      });
      if (decision === 'enqueue') {
        markPending(db, existing.id);
      }
    }
  }

  markClosedExcept(db, repo, keepPrNumbers);
  setConfig(db, 'last_poll_at', new Date().toISOString());
  setConfig(db, 'last_poll_status', 'ok');
  setConfig(db, 'last_poll_error', '');

  await processQueue(db, repo);
}

async function processQueue(db: Database.Database, repo: string): Promise<void> {
  // Re-read the queue before each item: this loop only ever runs within
  // a single poll tick (or a single manual re-check, in Chunk 5), so no
  // other writer can enqueue more work concurrently in-process.
  for (const pr of getPendingPrs(db, repo)) {
    await processOnePr(db, repo, pr.id, pr.pr_number, pr.title, pr.branch, pr.base_branch, pr.head_sha);
  }
}

async function processOnePr(
  db: Database.Database,
  repo: string,
  id: number,
  prNumber: number,
  title: string,
  branch: string,
  baseBranch: string,
  headSha: string
): Promise<void> {
  markReviewing(db, id);

  let worktreeDir: string;
  try {
    await ensureBareRepo(repo);
    worktreeDir = await addOrUpdateWorktree(repo, prNumber, headSha);
  } catch (err) {
    markFailed(db, id, err instanceof Error ? err.message : String(err));
    return;
  }

  const prompt = buildReviewPrompt({ repo, prNumber, title, branch, baseBranch });
  const result = await runReview(worktreeDir, prompt, REVIEW_TIMEOUT_MS);

  if (!result.success) {
    markFailed(db, id, result.errorMessage ?? 'Review failed for an unknown reason');
    return;
  }

  const parsed = parseReviewOutput(result.output);
  const findingInputs: FindingInput[] = parsed.findings.map((f) => ({
    file: f.file ?? '',
    line: f.line ?? 0,
    severity: f.severity,
    summary: f.summary,
    failureScenario: f.failureScenario ?? '',
    evidence: f.evidence ?? '',
    fixSuggestion: f.fixSuggestion ?? '',
    codeSnippet: f.codeSnippet ?? '',
  }));

  replaceFindings(db, id, findingInputs);
  markDone(db, id, {
    verdict: parsed.verdict,
    severityCritical: countSeverity(parsed.findings, 'CRITICAL'),
    severityHigh: countSeverity(parsed.findings, 'HIGH'),
    severityMedium: countSeverity(parsed.findings, 'MEDIUM'),
    severityLow: countSeverity(parsed.findings, 'LOW'),
    reviewedHeadSha: headSha,
    rawReportMd: parsed.rawReportMd,
  });
}

function countSeverity(findings: { severity: string }[], severity: string): number {
  return findings.filter((f) => f.severity === severity).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/poller.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/poller.ts src/lib/poller.test.ts
git commit -m "feat(lib): wire gh/decision/repoCache/reviewRunner into full poll tick orchestration"
```

---

### Task 4.4: Startup `TARGET_REPO` validation

**Files:**
- Create: `src/lib/startupConfig.ts`
- Test: `src/lib/startupConfig.test.ts`

Per spec: if `TARGET_REPO` is unset or not a valid `owner/name` string at
startup, the process must log a fatal error and exit immediately rather
than start in a half-configured state. The validation itself is a pure
function so it's fully unit-testable without touching `process.exit()`
(that side effect lives in Task 4.5's `instrumentation.ts`).

- [ ] **Step 1: Write the failing test**

`src/lib/startupConfig.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parseTargetRepo } from './startupConfig';

describe('parseTargetRepo', () => {
  it('accepts a well-formed owner/name value', () => {
    expect(parseTargetRepo('octocat/hello-world')).toEqual({ ok: true, repo: 'octocat/hello-world' });
  });

  it('rejects an unset value', () => {
    const result = parseTargetRepo(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not set/i);
  });

  it('rejects an empty string', () => {
    const result = parseTargetRepo('');
    expect(result.ok).toBe(false);
  });

  it('rejects a value with no slash', () => {
    const result = parseTargetRepo('justaname');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/owner\/name/i);
  });

  it('rejects a value with more than one slash', () => {
    const result = parseTargetRepo('owner/name/extra');
    expect(result.ok).toBe(false);
  });

  it('rejects a value containing whitespace', () => {
    const result = parseTargetRepo('owner/name with space');
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/startupConfig.test.ts`
Expected: FAIL — `Cannot find module './startupConfig'`.

- [ ] **Step 3: Write `src/lib/startupConfig.ts`**

```typescript
export interface TargetRepoResult {
  ok: boolean;
  repo?: string;
  error?: string;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseTargetRepo(value: string | undefined): TargetRepoResult {
  if (!value) {
    return { ok: false, error: 'TARGET_REPO environment variable is not set' };
  }
  if (!REPO_PATTERN.test(value)) {
    return {
      ok: false,
      error: `TARGET_REPO "${value}" is not a valid "owner/name" repo identifier`,
    };
  }
  return { ok: true, repo: value };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/startupConfig.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/startupConfig.ts src/lib/startupConfig.test.ts
git commit -m "feat(lib): validate TARGET_REPO at startup"
```

---

### Task 4.5: Cron registration via `instrumentation.ts`

**Files:**
- Create: `src/instrumentation.ts`
- Test: `src/instrumentation.test.ts`

Next.js automatically calls `register()` from `src/instrumentation.ts`
once per server process — but can invoke it more than once in dev mode
across hot reloads, so it must guard itself with a `globalThis`-keyed
flag (same pattern as Task 4.2's poll-tick mutex). On successful startup
it validates `TARGET_REPO`, persists it to `config.target_repo`, resets
any rows stuck `pending`/`reviewing` from a previous process, registers
the 5-minute cron job, and kicks off one immediate poll tick (rather than
waiting a full 5 minutes for the first result after starting the app).

- [ ] **Step 1: Write the failing test**

`src/instrumentation.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scheduleMock = vi.fn();
vi.mock('node-cron', () => ({ default: { schedule: (...args: unknown[]) => scheduleMock(...args) } }));

const dbStub = { __fake: 'db' };
const getDbMock = vi.fn(() => dbStub);
vi.mock('./db/client', () => ({ getDb: (...args: unknown[]) => getDbMock(...args) }));

const setConfigMock = vi.fn();
vi.mock('./db/config', () => ({ setConfig: (...args: unknown[]) => setConfigMock(...args) }));

const resetStuckReviewsMock = vi.fn();
vi.mock('./db/pullRequests', () => ({
  resetStuckReviews: (...args: unknown[]) => resetStuckReviewsMock(...args),
}));

const withPollLockMock = vi.fn((fn: () => unknown) => fn());
vi.mock('./lib/queue', () => ({ withPollLock: (...args: unknown[]) => withPollLockMock(...args) }));

const runPollTickMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./lib/poller', () => ({ runPollTick: (...args: unknown[]) => runPollTickMock(...args) }));

describe('instrumentation register()', () => {
  const originalEnv = process.env.TARGET_REPO;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    scheduleMock.mockClear();
    getDbMock.mockClear();
    setConfigMock.mockClear();
    resetStuckReviewsMock.mockClear();
    withPollLockMock.mockClear();
    runPollTickMock.mockClear();
    (globalThis as any).__prDashboardCronRegistered = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);
  });

  afterEach(() => {
    process.env.TARGET_REPO = originalEnv;
    exitSpy.mockRestore();
  });

  it('validates TARGET_REPO, resets stuck reviews, schedules cron, and polls once immediately', async () => {
    process.env.TARGET_REPO = 'owner/name';
    const { register } = await import('./instrumentation');

    await register();

    expect(setConfigMock).toHaveBeenCalledWith(dbStub, 'target_repo', 'owner/name');
    expect(resetStuckReviewsMock).toHaveBeenCalledWith(dbStub);
    expect(scheduleMock).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function));
    expect(withPollLockMock).toHaveBeenCalledTimes(1); // immediate startup poll
    expect(runPollTickMock).toHaveBeenCalledWith(dbStub, 'owner/name');
  });

  it('is a no-op on a second call in the same process (dev hot-reload guard)', async () => {
    process.env.TARGET_REPO = 'owner/name';
    const { register } = await import('./instrumentation');

    await register();
    await register();

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(withPollLockMock).toHaveBeenCalledTimes(1);
  });

  it('logs a fatal error and exits when TARGET_REPO is missing', async () => {
    delete process.env.TARGET_REPO;
    const { register } = await import('./instrumentation');

    await expect(register()).rejects.toThrow('process.exit(1) called');

    expect(scheduleMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/instrumentation.test.ts`
Expected: FAIL — `Cannot find module './instrumentation'`.

- [ ] **Step 3: Write `src/instrumentation.ts`**

```typescript
import cron from 'node-cron';
import { getDb } from './db/client';
import { setConfig } from './db/config';
import { resetStuckReviews } from './db/pullRequests';
import { parseTargetRepo } from './lib/startupConfig';
import { withPollLock } from './lib/queue';
import { runPollTick } from './lib/poller';

declare global {
  // eslint-disable-next-line no-var
  var __prDashboardCronRegistered: boolean | undefined;
}

export async function register(): Promise<void> {
  // Next.js can call register() more than once per process (e.g. across
  // dev-mode hot reloads); a plain module-level flag would be reset by a
  // module reload, so this must be keyed off globalThis to survive it.
  if (globalThis.__prDashboardCronRegistered) return;
  globalThis.__prDashboardCronRegistered = true;

  const result = parseTargetRepo(process.env.TARGET_REPO);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: ${result.error}`);
    process.exit(1);
    return;
  }
  const repo = result.repo as string;

  const db = getDb();
  setConfig(db, 'target_repo', repo);
  // Any row left pending/reviewing from a previous process would
  // otherwise be permanently stuck against the single-flight rule.
  resetStuckReviews(db);

  cron.schedule('*/5 * * * *', () => {
    void withPollLock(() => runPollTick(db, repo));
  });

  // Also poll immediately on startup, rather than waiting a full 5
  // minutes for the first result after the app comes up.
  await withPollLock(() => runPollTick(db, repo));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/instrumentation.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/instrumentation.ts src/instrumentation.test.ts
git commit -m "feat: register 5-minute cron poll via instrumentation.ts with dev-reload guard"
```

---

### Task 4.6: Run full test suite for Chunk 4

- [ ] **Step 1: Run the whole suite**

Run: `npm run test`
Expected: all Chunk 1–4 test files pass (client: 2, config: 3,
pullRequests: 12, findings: 3, decision: 9, gh: 3, parseReviewOutput: 7,
reviewPrompt: 1, repoCache: 6, reviewRunner: 4, queue: 4, poller: 7,
startupConfig: 6, instrumentation: 3 — 71 tests total).

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "test: verify chunk 4 poller orchestration and cron scheduling passes as a whole" --allow-empty
```

---

## Chunk 5: Next.js UI — List Page and components

This chunk builds the shared UI foundation on top of everything from
Chunks 1–4: presentational components (`VerdictBadge`, `SeverityBadge`,
`PollStatusBanner`), the component-test tooling they need, and the List
Page along with its pure "view model" builder function (the testable
logic deciding which badge/banner to show for each row). The Detail
Page (Chunk 6) and the "Re-check now" API route (Chunk 7) build on top
of this.

### Task 5.1: Add component test tooling + `VerdictBadge`/`SeverityBadge`

**Files:**
- Modify: `package.json` (add test deps)
- Create: `src/app/components/VerdictBadge.tsx`
- Test: `src/app/components/VerdictBadge.test.tsx`
- Create: `src/app/components/SeverityBadge.tsx`
- Test: `src/app/components/SeverityBadge.test.tsx`
- Create: `vitest-setup.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Install component test dependencies**

Run:
```bash
npm install -D jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: Add a jsdom project to `vitest.config.ts` for component tests**

Component tests need a `jsdom` environment while every other test file in
this plan relies on the default `node` environment (for `better-sqlite3`
and child_process mocking) — rather than changing the global environment
and risking breaking Chunks 1–4's tests, add a per-file override using
Vitest's environment glob matching:

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [['src/app/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./vitest-setup.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

`vitest-setup.ts`:
```typescript
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Write the failing tests**

`src/app/components/VerdictBadge.test.tsx`:
```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerdictBadge } from './VerdictBadge';

describe('VerdictBadge', () => {
  it('renders an approve badge', () => {
    render(<VerdictBadge verdict="approve" />);
    expect(screen.getByText(/approve/i)).toBeInTheDocument();
  });

  it('renders a needs_fix badge', () => {
    render(<VerdictBadge verdict="needs_fix" />);
    expect(screen.getByText(/needs fix/i)).toBeInTheDocument();
  });

  it('renders a needs_review badge', () => {
    render(<VerdictBadge verdict="needs_review" />);
    expect(screen.getByText(/needs review/i)).toBeInTheDocument();
  });

  it('renders a failed badge distinct from any verdict', () => {
    render(<VerdictBadge verdict="failed" />);
    expect(screen.getByText(/review failed/i)).toBeInTheDocument();
  });
});
```

`src/app/components/SeverityBadge.test.tsx`:
```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityBadge } from './SeverityBadge';

describe('SeverityBadge', () => {
  it.each(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const)('renders %s', (severity) => {
    render(<SeverityBadge severity={severity} />);
    expect(screen.getByText(severity)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm run test -- src/app/components/VerdictBadge.test.tsx src/app/components/SeverityBadge.test.tsx`
Expected: FAIL — `Cannot find module './VerdictBadge'` / `'./SeverityBadge'`.

- [ ] **Step 5: Write the components**

`src/app/components/VerdictBadge.tsx`:
```typescript
export type BadgeVerdict = 'approve' | 'needs_fix' | 'needs_review' | 'failed';

const LABELS: Record<BadgeVerdict, string> = {
  approve: 'Approve',
  needs_fix: 'Needs Fix',
  needs_review: 'Needs Review',
  failed: 'Review Failed',
};

const COLORS: Record<BadgeVerdict, string> = {
  approve: '#1a7f37',
  needs_fix: '#cf222e',
  needs_review: '#9a6700',
  failed: '#57606a',
};

export function VerdictBadge({ verdict }: { verdict: BadgeVerdict }) {
  return (
    <span
      style={{ color: 'white', background: COLORS[verdict], padding: '2px 8px', borderRadius: 4 }}
    >
      {LABELS[verdict]}
    </span>
  );
}
```

`src/app/components/SeverityBadge.tsx`:
```typescript
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

const COLORS: Record<Severity, string> = {
  CRITICAL: '#82071e',
  HIGH: '#cf222e',
  MEDIUM: '#9a6700',
  LOW: '#57606a',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      style={{ color: 'white', background: COLORS[severity], padding: '1px 6px', borderRadius: 4, fontSize: '0.8em' }}
    >
      {severity}
    </span>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test -- src/app/components/VerdictBadge.test.tsx src/app/components/SeverityBadge.test.tsx`
Expected: PASS, 8 tests (4 `VerdictBadge` cases + 4 `SeverityBadge` cases,
the latter from one `it.each` producing 4 individually-counted cases; see
Task 7.2 for the full-suite running total).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts vitest-setup.ts src/app/components/VerdictBadge.tsx src/app/components/VerdictBadge.test.tsx src/app/components/SeverityBadge.tsx src/app/components/SeverityBadge.test.tsx
git commit -m "feat(ui): add VerdictBadge/SeverityBadge components and jsdom test tooling"
```

---

### Task 5.2: List Page view model + `PollStatusBanner`

**Files:**
- Create: `src/lib/listPageViewModel.ts`
- Test: `src/lib/listPageViewModel.test.ts`
- Create: `src/app/components/PollStatusBanner.tsx`
- Test: `src/app/components/PollStatusBanner.test.tsx`

The List Page's actual data-shaping logic (which badge to show, whether
counts reflect a stale prior review) is pulled out into a pure,
DB-independent function so it's fully unit-tested; `page.tsx` in Task 5.3
will just call `getOpenPrs()` + this function + render.

- [ ] **Step 1: Write the failing tests**

`src/lib/listPageViewModel.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildListRowViewModel, type ListPageRowInput } from './listPageViewModel';

function row(overrides: Partial<ListPageRowInput>): ListPageRowInput {
  return {
    prNumber: 1,
    title: 'Add feature',
    branch: 'feat/x',
    author: 'alice',
    reviewStatus: 'done',
    verdict: 'approve',
    severityCritical: 0,
    severityHigh: 0,
    lastReviewedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildListRowViewModel', () => {
  it('shows the verdict badge and severity count for a done review', () => {
    const vm = buildListRowViewModel(row({ verdict: 'needs_fix', severityCritical: 1, severityHigh: 2 }));
    expect(vm.badgeVerdict).toBe('needs_fix');
    expect(vm.criticalHighCount).toBe(3);
    expect(vm.isInProgress).toBe(false);
  });

  it('shows an in-progress indicator for a reviewing row', () => {
    const vm = buildListRowViewModel(row({ reviewStatus: 'reviewing' }));
    expect(vm.isInProgress).toBe(true);
  });

  it('shows a failed badge and last successful counts when a prior review exists', () => {
    const vm = buildListRowViewModel(
      row({ reviewStatus: 'failed', verdict: 'approve', severityCritical: 0, severityHigh: 1, lastReviewedAt: '2026-07-28T00:00:00.000Z' })
    );
    expect(vm.badgeVerdict).toBe('failed');
    expect(vm.criticalHighCount).toBe(1); // last successful counts, not blanked out
  });

  it('shows a failed badge with no count ("-") when there is no prior successful review', () => {
    const vm = buildListRowViewModel(row({ reviewStatus: 'failed', lastReviewedAt: null }));
    expect(vm.badgeVerdict).toBe('failed');
    expect(vm.criticalHighCount).toBeNull();
  });
});
```

`src/app/components/PollStatusBanner.test.tsx`:
```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PollStatusBanner } from './PollStatusBanner';

describe('PollStatusBanner', () => {
  it('shows only the last poll time when the last poll succeeded', () => {
    render(<PollStatusBanner lastPollAt="2026-07-28T00:00:00.000Z" lastPollStatus="ok" lastPollError={null} />);
    expect(screen.queryByText(/last poll failed/i)).not.toBeInTheDocument();
  });

  it('shows a warning banner with the error message when the last poll failed', () => {
    render(
      <PollStatusBanner
        lastPollAt="2026-07-28T00:00:00.000Z"
        lastPollStatus="error"
        lastPollError="gh: authentication required"
      />
    );
    expect(screen.getByText(/last poll failed/i)).toBeInTheDocument();
    expect(screen.getByText(/gh: authentication required/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/lib/listPageViewModel.test.ts src/app/components/PollStatusBanner.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`src/lib/listPageViewModel.ts`:
```typescript
import type { BadgeVerdict } from '../app/components/VerdictBadge';

export interface ListPageRowInput {
  prNumber: number;
  title: string;
  branch: string;
  author: string;
  reviewStatus: 'pending' | 'reviewing' | 'done' | 'failed';
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
  badgeVerdict: BadgeVerdict;
  criticalHighCount: number | null;
  lastReviewedAt: string | null;
}

export function buildListRowViewModel(input: ListPageRowInput): ListPageRowViewModel {
  const isInProgress = input.reviewStatus === 'reviewing' || input.reviewStatus === 'pending';
  const isFailed = input.reviewStatus === 'failed';

  const hasPriorSuccess = input.lastReviewedAt !== null;
  // severityCritical/severityHigh always hold the counts from the last
  // *successful* review (markFailed never touches them - see Chunk 1's
  // pullRequests.ts) so they're safe to show whenever a prior success
  // exists, even if the row's current status is 'failed'.
  const criticalHighCount = isFailed && !hasPriorSuccess ? null : input.severityCritical + input.severityHigh;

  return {
    prNumber: input.prNumber,
    title: input.title,
    branch: input.branch,
    author: input.author,
    isInProgress,
    badgeVerdict: isFailed ? 'failed' : ((input.verdict ?? 'needs_review') as BadgeVerdict),
    criticalHighCount,
    lastReviewedAt: input.lastReviewedAt,
  };
}
```

`src/app/components/PollStatusBanner.tsx`:
```typescript
export function PollStatusBanner({
  lastPollAt,
  lastPollStatus,
  lastPollError,
}: {
  lastPollAt: string | null;
  lastPollStatus: 'ok' | 'error' | null;
  lastPollError: string | null;
}) {
  return (
    <div>
      <p>Last poll: {lastPollAt ?? 'never'}</p>
      {lastPollStatus === 'error' && (
        <div role="alert" style={{ background: '#fff8c5', padding: 8, borderRadius: 4 }}>
          ⚠ Last poll failed: {lastPollError}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/lib/listPageViewModel.test.ts src/app/components/PollStatusBanner.test.tsx`
Expected: PASS, 6 tests (4 + 2).

- [ ] **Step 5: Commit**

```bash
git add src/lib/listPageViewModel.ts src/lib/listPageViewModel.test.ts src/app/components/PollStatusBanner.tsx src/app/components/PollStatusBanner.test.tsx
git commit -m "feat(ui): add list page view model and poll status banner"
```

---

### Task 5.3: List Page (`app/page.tsx`)

**Files:**
- Modify: `src/lib/listPageViewModel.ts` (add `buildListPageViewModel`)
- Modify: `src/lib/listPageViewModel.test.ts`
- Create: `src/app/page.tsx`

- [ ] **Step 1: Write the failing test for the page-level view model**

Append to `src/lib/listPageViewModel.test.ts`:
```typescript
import { buildListPageViewModel } from './listPageViewModel';
import type { PullRequestRow } from '../db/pullRequests';

function prRow(overrides: Partial<PullRequestRow>): PullRequestRow {
  return {
    id: 1,
    repo: 'owner/name',
    pr_number: 42,
    title: 'Add feature',
    author: 'alice',
    branch: 'feat/x',
    base_branch: 'main',
    head_sha: 'abc123',
    pr_url: 'https://github.com/owner/name/pull/42',
    is_draft: 0,
    pr_state: 'open',
    review_status: 'done',
    verdict: 'approve',
    severity_critical: 0,
    severity_high: 0,
    severity_medium: 0,
    severity_low: 0,
    reviewed_head_sha: 'abc123',
    last_reviewed_at: '2026-07-28T00:00:00.000Z',
    last_attempted_at: '2026-07-28T00:00:00.000Z',
    raw_report_md: '# report',
    error_message: null,
    ...overrides,
  };
}

describe('buildListPageViewModel', () => {
  it('maps DB rows into row view models sorted by PR number descending', () => {
    const vm = buildListPageViewModel({
      repo: 'owner/name',
      lastPollAt: '2026-07-28T00:05:00.000Z',
      lastPollStatus: 'ok',
      lastPollError: null,
      // Deliberately passed in ascending order so this test actually
      // exercises the sort, rather than passing already-descending input
      // that would pass even with a no-op or ascending sort.
      prs: [prRow({ pr_number: 1 }), prRow({ pr_number: 2 })],
    });
    expect(vm.repo).toBe('owner/name');
    expect(vm.rows.map((r) => r.prNumber)).toEqual([2, 1]);
    expect(vm.pollStatus).toBe('ok');
  });

  it('propagates a failed poll error message into the view model', () => {
    const vm = buildListPageViewModel({
      repo: 'owner/name',
      lastPollAt: '2026-07-28T00:05:00.000Z',
      lastPollStatus: 'error',
      lastPollError: 'gh: authentication required',
      prs: [],
    });
    expect(vm.pollError).toBe('gh: authentication required');
    expect(vm.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/listPageViewModel.test.ts`
Expected: FAIL — `buildListPageViewModel is not exported`.

- [ ] **Step 3: Add `buildListPageViewModel` to `src/lib/listPageViewModel.ts`**

Append to the file (below the existing `buildListRowViewModel`):
```typescript
import type { PullRequestRow } from '../db/pullRequests';

export interface ListPageViewModelInput {
  repo: string;
  lastPollAt: string | null;
  lastPollStatus: 'ok' | 'error' | null;
  lastPollError: string | null;
  prs: PullRequestRow[];
}

export interface ListPageViewModel {
  repo: string;
  lastPollAt: string | null;
  pollStatus: 'ok' | 'error' | null;
  pollError: string | null;
  rows: ListPageRowViewModel[];
}

export function buildListPageViewModel(input: ListPageViewModelInput): ListPageViewModel {
  return {
    repo: input.repo,
    lastPollAt: input.lastPollAt,
    pollStatus: input.lastPollStatus,
    // An empty string means "no error recorded" (see poller.ts's success
    // path, which calls setConfig(db, 'last_poll_error', '')) - normalize
    // that to null so the banner and this view model share one "no error"
    // representation.
    pollError: input.lastPollError || null,
    rows: input.prs
      .map((pr) =>
        buildListRowViewModel({
          prNumber: pr.pr_number,
          title: pr.title,
          branch: pr.branch,
          author: pr.author,
          reviewStatus: pr.review_status,
          verdict: pr.verdict,
          severityCritical: pr.severity_critical,
          severityHigh: pr.severity_high,
          lastReviewedAt: pr.last_reviewed_at,
        })
      )
      // `getOpenPrs()` (db/pullRequests.ts) already queries with
      // `ORDER BY pr_number DESC`, but this view model re-sorts
      // defensively rather than trusting caller ordering, since it's a
      // pure function that may be called with data from other sources
      // (e.g. tests, future callers).
      .sort((a, b) => b.prNumber - a.prNumber),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/listPageViewModel.test.ts`
Expected: PASS, 6 tests (4 existing + 2 new).

- [ ] **Step 5: Write `src/app/page.tsx`**

This is deliberately a thin Server Component: it fetches from SQLite and
the `config` table, builds the view model, and renders. Per the design
spec, no client-side data fetching is needed for initial render — the
page re-runs on every navigation/refresh since it's an uncached Server
Component (no `export const revalidate` / `fetch cache` is configured
elsewhere in this plan).

```tsx
import Link from 'next/link';
import { getDb } from '../db/client';
import { getConfig } from '../db/config';
import { getOpenPrs } from '../db/pullRequests';
import { buildListPageViewModel } from '../lib/listPageViewModel';
import { VerdictBadge } from './components/VerdictBadge';
import { PollStatusBanner } from './components/PollStatusBanner';

export const dynamic = 'force-dynamic';

export default function ListPage() {
  const db = getDb();
  const repo = getConfig(db, 'target_repo') ?? '(not configured)';
  const vm = buildListPageViewModel({
    repo,
    lastPollAt: getConfig(db, 'last_poll_at') ?? null,
    lastPollStatus: (getConfig(db, 'last_poll_status') as 'ok' | 'error' | undefined) ?? null,
    lastPollError: getConfig(db, 'last_poll_error') ?? null,
    prs: getOpenPrs(db, repo),
  });

  return (
    <main>
      <h1>{vm.repo}</h1>
      <PollStatusBanner lastPollAt={vm.lastPollAt} lastPollStatus={vm.pollStatus} lastPollError={vm.pollError} />
      <table>
        <thead>
          <tr>
            <th>PR</th>
            <th>Title</th>
            <th>Branch</th>
            <th>Author</th>
            <th>Verdict</th>
            <th>Critical+High</th>
            <th>Last reviewed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {vm.rows.map((row) => (
            // Server Components can't attach an onClick handler to the
            // <tr> itself (that would require a Client Component), so
            // "clicking a row navigates" is satisfied instead by making
            // every data cell in the row a full-cell <Link> (styled to
            // `display: block` so the whole cell area, not just the
            // text, is clickable) - only the "Re-check now" form/button
            // cell is excluded, since it must submit a POST rather than
            // navigate.
            <tr key={row.prNumber}>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  #{row.prNumber}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.title}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.branch}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.author}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.isInProgress ? 'Reviewing…' : <VerdictBadge verdict={row.badgeVerdict} />}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.criticalHighCount ?? '-'}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.lastReviewedAt ?? '-'}
                </Link>
              </td>
              <td>
                <form action={`/api/recheck/${row.prNumber}`} method="post">
                  <button type="submit">Re-check now</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

- [ ] **Step 6: Manually verify the page renders**

Run: `npm run dev`, then open `http://localhost:3000` in a browser (or
`curl -s http://localhost:3000 | grep -o '<h1>[^<]*</h1>'`) with a
populated database (from Chunk 4's poller having run at least once,
writing to `$PR_DASHBOARD_DB_PATH`, default `~/.pr-review-dashboard/dashboard.sqlite`). Server Components with direct DB access aren't unit-testable
without a real Next.js render pipeline, so this manual check is the
verification step for `page.tsx` itself — the view model it depends on
is already fully unit-tested above.
Expected: page loads without error, shows the configured repo name,
clicking anywhere in a row (not just the PR number) navigates to
`/pr/<number>`, and each row's "Re-check now" button submits without a
client-side error (the route itself isn't built until Chunk 7, so a 404
response here is expected and fine for this check).

- [ ] **Step 7: Commit**

```bash
git add src/lib/listPageViewModel.ts src/lib/listPageViewModel.test.ts src/app/page.tsx
git commit -m "feat(ui): add list page with view model and manual verification"
```

---

## Chunk 6: Next.js UI — Detail Page

This chunk depends on Chunk 5 (`VerdictBadge`, `SeverityBadge` and the
overall `app/` structure) and adds the Detail Page along with its own
view model and the `FindingCard` component.

### Task 6.1: Detail Page (`app/pr/[number]/page.tsx`) + `FindingCard`

**Files:**
- Create: `src/lib/detailPageViewModel.ts`
- Test: `src/lib/detailPageViewModel.test.ts`
- Create: `src/app/components/FindingCard.tsx`
- Test: `src/app/components/FindingCard.test.tsx`
- Create: `src/app/pr/[number]/page.tsx`

- [ ] **Step 1: Write the failing tests**

`src/lib/detailPageViewModel.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildDetailPageViewModel } from './detailPageViewModel';
import type { PullRequestRow } from '../db/pullRequests';
import type { FindingRow } from '../db/findings';

function prRow(overrides: Partial<PullRequestRow>): PullRequestRow {
  return {
    id: 1,
    repo: 'owner/name',
    pr_number: 42,
    title: 'Add feature',
    author: 'alice',
    branch: 'feat/x',
    base_branch: 'main',
    head_sha: 'abc123',
    pr_url: 'https://github.com/owner/name/pull/42',
    is_draft: 0,
    pr_state: 'open',
    review_status: 'done',
    verdict: 'approve',
    severity_critical: 0,
    severity_high: 0,
    severity_medium: 0,
    severity_low: 0,
    reviewed_head_sha: 'abc123',
    last_reviewed_at: '2026-07-28T00:00:00.000Z',
    last_attempted_at: '2026-07-28T00:00:00.000Z',
    raw_report_md: '# report',
    error_message: null,
    ...overrides,
  };
}

function findingRow(overrides: Partial<FindingRow>): FindingRow {
  return {
    id: 1,
    pull_request_id: 1,
    file: 'src/a.ts',
    line: 10,
    severity: 'HIGH',
    summary: 'Missing null check',
    failureScenario: 'Crashes when input is null',
    evidence: 'a.ts:10',
    fixSuggestion: 'Add a null guard',
    codeSnippet: 'if (!x) return;',
    ...overrides,
  };
}

describe('buildDetailPageViewModel', () => {
  it('shows the normal state for a done review, splitting top risks from medium/low', () => {
    const vm = buildDetailPageViewModel(
      prRow({}),
      [findingRow({ severity: 'CRITICAL' }), findingRow({ severity: 'LOW', id: 2 })]
    );
    expect(vm.state).toBe('normal');
    expect(vm.topRisks).toHaveLength(1);
    expect(vm.mediumLow).toHaveLength(1);
  });

  it('shows the "failed with prior success" state and still renders prior findings', () => {
    const vm = buildDetailPageViewModel(
      prRow({
        review_status: 'failed',
        error_message: 'copilot timed out',
        last_attempted_at: '2026-07-28T01:00:00.000Z',
        last_reviewed_at: '2026-07-28T00:00:00.000Z',
        reviewed_head_sha: 'abc123',
      }),
      [findingRow({ severity: 'CRITICAL' })]
    );
    expect(vm.state).toBe('failed-with-prior-success');
    expect(vm.topRisks).toHaveLength(1);
    expect(vm.failureBanner).toMatchObject({
      lastAttemptedAt: '2026-07-28T01:00:00.000Z',
      errorMessage: 'copilot timed out',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
      reviewedHeadSha: 'abc123',
    });
  });

  it('shows the "failed with no prior success" state with no findings sections, even if stray findings rows exist', () => {
    const vm = buildDetailPageViewModel(
      prRow({
        review_status: 'failed',
        error_message: 'git fetch failed',
        last_attempted_at: '2026-07-28T01:00:00.000Z',
        last_reviewed_at: null,
        reviewed_head_sha: null,
        raw_report_md: '# stray leftover report',
      }),
      // Non-empty on purpose: this state must suppress findings/report
      // sections regardless of what's in the DB, not just because the
      // inputs happen to be empty.
      [findingRow({ severity: 'CRITICAL' }), findingRow({ severity: 'LOW', id: 2 })]
    );
    expect(vm.state).toBe('failed-no-prior-success');
    expect(vm.topRisks).toHaveLength(0);
    expect(vm.mediumLow).toHaveLength(0);
    expect(vm.rawReportMd).toBeNull();
  });
});
```

`src/app/components/FindingCard.test.tsx`:
```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingCard } from './FindingCard';

describe('FindingCard', () => {
  it('renders all finding fields', () => {
    render(
      <FindingCard
        finding={{
          file: 'src/a.ts',
          line: 10,
          severity: 'CRITICAL',
          summary: 'Missing null check',
          failureScenario: 'Crashes when input is null',
          evidence: 'a.ts:10',
          fixSuggestion: 'Add a null guard',
          codeSnippet: 'if (!x) return;',
        }}
      />
    );
    expect(screen.getByText('Missing null check')).toBeInTheDocument();
    expect(screen.getByText(/src\/a.ts:10/)).toBeInTheDocument();
    expect(screen.getByText('Crashes when input is null')).toBeInTheDocument();
    expect(screen.getByText('Add a null guard')).toBeInTheDocument();
    expect(screen.getByText('if (!x) return;')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/lib/detailPageViewModel.test.ts src/app/components/FindingCard.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`src/lib/detailPageViewModel.ts`:
```typescript
import type { PullRequestRow } from '../db/pullRequests';
import type { FindingRow } from '../db/findings';

export type DetailPageState = 'normal' | 'failed-with-prior-success' | 'failed-no-prior-success';

export interface FailureBanner {
  lastAttemptedAt: string | null;
  errorMessage: string | null;
  lastReviewedAt: string | null;
  reviewedHeadSha: string | null;
}

export interface DetailPageViewModel {
  state: DetailPageState;
  prNumber: number;
  title: string;
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

export function buildDetailPageViewModel(pr: PullRequestRow, findings: FindingRow[]): DetailPageViewModel {
  const isFailed = pr.review_status === 'failed';
  const hasPriorSuccess = pr.last_reviewed_at !== null;

  let state: DetailPageState = 'normal';
  if (isFailed) {
    state = hasPriorSuccess ? 'failed-with-prior-success' : 'failed-no-prior-success';
  }

  // In the no-prior-success failed state there's nothing meaningful to
  // show (findings/raw_report_md belong to the last *successful* review,
  // which doesn't exist yet), so the findings/report sections are
  // suppressed entirely per spec even though the DB columns are just
  // empty/null naturally in that case too.
  const showFindings = state !== 'failed-no-prior-success';

  return {
    state,
    prNumber: pr.pr_number,
    title: pr.title,
    verdict: pr.verdict,
    severityCritical: pr.severity_critical,
    severityHigh: pr.severity_high,
    severityMedium: pr.severity_medium,
    severityLow: pr.severity_low,
    topRisks: showFindings ? findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH') : [],
    mediumLow: showFindings ? findings.filter((f) => f.severity === 'MEDIUM' || f.severity === 'LOW') : [],
    rawReportMd: showFindings ? pr.raw_report_md : null,
    failureBanner: isFailed
      ? {
          lastAttemptedAt: pr.last_attempted_at,
          errorMessage: pr.error_message,
          lastReviewedAt: pr.last_reviewed_at,
          reviewedHeadSha: pr.reviewed_head_sha,
        }
      : null,
  };
}
```

`src/app/components/FindingCard.tsx`:
```typescript
import { SeverityBadge, type Severity } from './SeverityBadge';

export interface FindingCardInput {
  file: string;
  line: number;
  severity: Severity;
  summary: string;
  failureScenario: string;
  evidence: string;
  fixSuggestion: string;
  codeSnippet: string;
}

export function FindingCard({ finding }: { finding: FindingCardInput }) {
  return (
    <div style={{ border: '1px solid #d0d7de', borderRadius: 6, padding: 12, marginBottom: 8 }}>
      <div>
        <SeverityBadge severity={finding.severity} /> <strong>{finding.summary}</strong>
      </div>
      <p>
        {finding.file}:{finding.line}
      </p>
      <p>
        <em>Failure scenario:</em> {finding.failureScenario}
      </p>
      <p>
        <em>Evidence:</em> {finding.evidence}
      </p>
      <p>
        <em>Fix:</em> {finding.fixSuggestion}
      </p>
      <pre>{finding.codeSnippet}</pre>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/lib/detailPageViewModel.test.ts src/app/components/FindingCard.test.tsx`
Expected: PASS, 4 tests (3 + 1).

- [ ] **Step 5: Write `src/app/pr/[number]/page.tsx`**

```tsx
import { notFound } from 'next/navigation';
import { getDb } from '../../../db/client';
import { getConfig } from '../../../db/config';
import { getByNumber } from '../../../db/pullRequests';
import { getFindingsByPrId } from '../../../db/findings';
import { buildDetailPageViewModel } from '../../../lib/detailPageViewModel';
import { VerdictBadge } from '../../components/VerdictBadge';
import { FindingCard } from '../../components/FindingCard';

export const dynamic = 'force-dynamic';

export default function DetailPage({ params }: { params: { number: string } }) {
  const db = getDb();
  const repo = getConfig(db, 'target_repo') ?? '(not configured)';
  const prNumber = Number(params.number);
  const pr = getByNumber(db, repo, prNumber);
  if (!pr) {
    notFound();
  }

  const findings = getFindingsByPrId(db, pr.id);
  const vm = buildDetailPageViewModel(pr, findings);

  return (
    <main>
      <h1>
        #{vm.prNumber} {vm.title}
      </h1>
      <form action={`/api/recheck/${vm.prNumber}`} method="post">
        <button type="submit">Re-check now</button>
      </form>

      {vm.failureBanner && vm.state === 'failed-with-prior-success' && (
        <div role="alert">
          ⚠ Latest re-check failed at {vm.failureBanner.lastAttemptedAt}: {vm.failureBanner.errorMessage}. Showing
          results from the last successful review ({vm.failureBanner.lastReviewedAt}, commit{' '}
          {vm.failureBanner.reviewedHeadSha}).
        </div>
      )}

      {vm.failureBanner && vm.state === 'failed-no-prior-success' && (
        <div role="alert">
          Review failed at {vm.failureBanner.lastAttemptedAt}: {vm.failureBanner.errorMessage}. No successful review
          yet.
        </div>
      )}

      {vm.state !== 'failed-no-prior-success' && (
        <>
          <section>
            <h2>Executive Summary</h2>
            {vm.verdict && <VerdictBadge verdict={vm.verdict as 'approve' | 'needs_fix' | 'needs_review'} />}
            <p>
              Critical: {vm.severityCritical}, High: {vm.severityHigh}, Medium: {vm.severityMedium}, Low:{' '}
              {vm.severityLow}
            </p>
          </section>

          <section>
            <h2>Top Risks</h2>
            {vm.topRisks.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </section>

          <section>
            <h2>Medium/Low</h2>
            <ul>
              {vm.mediumLow.map((f) => (
                <li key={f.id}>
                  {f.severity}: {f.summary} ({f.file}:{f.line})
                </li>
              ))}
            </ul>
          </section>

          {vm.rawReportMd && (
            <details>
              <summary>Raw report</summary>
              <pre>{vm.rawReportMd}</pre>
            </details>
          )}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Manually verify the page renders both normal and failed states**

The app's real database path is `$PR_DASHBOARD_DB_PATH`, defaulting to
`~/.pr-review-dashboard/dashboard.sqlite` (see `getDb()` in Chunk 1) —
**not** `data/dashboard.db`. It runs in WAL mode, so a plain `cp` of the
main file can miss in-flight writes recorded in the `-wal`/`-shm`
sidecar files and produce a corrupt or stale backup/restore. Resolve the
real path once and use `sqlite3`'s own `.backup`/`.restore` commands
(which checkpoint the WAL correctly) instead of `cp`:

```bash
DB="${PR_DASHBOARD_DB_PATH:-$HOME/.pr-review-dashboard/dashboard.sqlite}"
echo "$DB"
```

**Stop `npm run dev` before backing up** (a live connection can hold WAL
state that a snapshot outside `sqlite3` won't see) — start it again only
after the backup completes:
```bash
sqlite3 "$DB" ".backup /tmp/dashboard.db.bak"
npm run dev
```

Then pick a real PR number to test against:
```bash
sqlite3 "$DB" "SELECT pr_number, review_status, last_reviewed_at FROM pull_requests WHERE pr_state='open' AND is_draft=0"
```
Pick one row with `review_status='done'` (a PR that reviewed
successfully) and note its `pr_number` — call it `<n>` below.

Visit `http://localhost:3000/pr/<n>` (substituting the real number) and
confirm the normal state renders Executive Summary/Top Risks/Medium-Low/
raw report. Then force each of the two distinct failed states in turn,
reloading `/pr/<n>` after each `sqlite3` command below (substituting the
same real PR number for `<n>` in both the SQL and the URL):

1. **failed-with-prior-success** (this same PR, which just succeeded, now
   has a later re-check fail — `last_reviewed_at` stays set from the
   prior success):
   ```bash
   sqlite3 "$DB" "UPDATE pull_requests SET review_status='failed', error_message='manual test: timeout', last_attempted_at=datetime('now') WHERE pr_number=<n>"
   ```
   Expected: the "⚠ Latest re-check failed..." banner appears above a
   fully rendered Executive Summary/Top Risks/Medium-Low/raw report
   (the prior successful review's data, unchanged from before this
   `UPDATE`).

2. **failed-no-prior-success** (same PR, now simulating that it never
   succeeded at all):
   ```bash
   sqlite3 "$DB" "UPDATE pull_requests SET review_status='failed', error_message='manual test: git fetch failed', last_attempted_at=datetime('now'), last_reviewed_at=NULL, reviewed_head_sha=NULL WHERE pr_number=<n>"
   ```
   Expected: only the "Review failed... No successful review yet." banner
   appears; no Executive Summary/Top Risks/Medium-Low/raw report sections
   are rendered.

Restore the database afterwards so Chunk 7's manual verification and any
further local testing start from real data again. **Stop `npm run dev`
first**, restore via `.restore` (which correctly replaces any WAL state
too), then restart:
```bash
# stop npm run dev
sqlite3 "$DB" ".restore /tmp/dashboard.db.bak"
npm run dev
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/detailPageViewModel.ts src/lib/detailPageViewModel.test.ts src/app/components/FindingCard.tsx src/app/components/FindingCard.test.tsx src/app/pr/\[number\]/page.tsx
git commit -m "feat(ui): add detail page with normal/failed view model states"
```

---

## Chunk 7: Re-check API route + final verification

This chunk covers the "Re-check now" button's backend and the
end-to-end manual verification pass. It depends on everything in
Chunks 1-6 (the List Page in Chunk 5 and the Detail Page in Chunk 6 both
link to the API route this chunk builds).

### Task 7.1: "Re-check now" — `forceRecheck` + API route

**Files:**
- Modify: `src/lib/poller.ts:2591` (export `processOnePr` instead of leaving it module-private)
- Create: `src/lib/recheck.ts`
- Test: `src/lib/recheck.test.ts`
- Create: `src/app/api/recheck/[number]/route.ts`
- Test: `src/app/api/recheck/[number]/route.test.ts`

`forceRecheck()` is the shared logic behind the "Re-check now" button on
both pages. Per the design spec, it must: (1) respect the single-flight
rule — no-op if the PR is already `pending`/`reviewing`; (2) fetch the
PR's current `head_sha` from GitHub first (read-only `gh pr list`, same
as the poller — no writes to the remote), so the forced run reviews the
PR's actual current code rather than a stale cached `head_sha`; (3)
bypass `decidePrAction()`'s "new or head_sha changed" gate entirely,
since this is an explicit user request, not a routine poll decision.

- [ ] **Step 1: Export `processOnePr` from `poller.ts`**

Change the module-private declaration:
```typescript
async function processOnePr(
```
to:
```typescript
export async function processOnePr(
```

This is a pure visibility change — no behavior differs. Run the
existing suite to confirm nothing broke before continuing:

Run: `npm run test -- src/lib/poller.test.ts`
Expected: PASS, 7 tests (unchanged from Chunk 4).

- [ ] **Step 2: Write the failing tests for `forceRecheck`**

`src/lib/recheck.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchOpenPrsMock = vi.fn();
vi.mock('./gh', () => ({ fetchOpenPrs: (...args: unknown[]) => fetchOpenPrsMock(...args) }));

const processOnePrMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./poller', () => ({ processOnePr: (...args: unknown[]) => processOnePrMock(...args) }));

// Mirrors the real withPollLock's actual contract: when `skipNext` is
// true (simulating a scheduled poll tick already holding the mutex), it
// resolves to 'skipped' WITHOUT ever invoking `fn` - matching queue.ts's
// real `if (isPollInProgress()) return 'skipped';` short-circuit. This
// is what lets the "already running" test below exercise the real
// synchronous-dispatch-detection logic in `forceRecheck`, rather than
// just asserting on a separately-mocked `isPollInProgress()` call.
let skipNext = false;
const withPollLockMock = vi.fn((fn: () => Promise<unknown>) => {
  if (skipNext) return Promise.resolve('skipped');
  return fn();
});
vi.mock('./queue', () => ({ withPollLock: (...args: unknown[]) => withPollLockMock(...args) }));

const { forceRecheck } = await import('./recheck');
const { createTestDb } = await import('../db/client');
const { upsertOpenPr } = await import('../db/pullRequests');

describe('forceRecheck', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    fetchOpenPrsMock.mockReset();
    processOnePrMock.mockClear();
    skipNext = false;
    withPollLockMock.mockClear();
  });

  it('returns not-found when the PR is not tracked at all', async () => {
    const result = await forceRecheck(db, 'owner/name', 999);
    expect(result).toEqual({ status: 'not-found' });
    expect(fetchOpenPrsMock).not.toHaveBeenCalled();
  });

  it('returns already-in-progress and does not re-enqueue when review_status is pending', async () => {
    upsertOpenPr(db, {
      repo: 'owner/name', prNumber: 1, title: 't', author: 'a', branch: 'b',
      baseBranch: 'main', headSha: 'sha1', prUrl: 'u', isDraft: false,
    });
    const result = await forceRecheck(db, 'owner/name', 1);
    expect(result).toEqual({ status: 'already-in-progress' });
    expect(fetchOpenPrsMock).not.toHaveBeenCalled();
  });

  it('returns not-found when the PR is no longer in the fresh gh pr list (closed/merged)', async () => {
    upsertOpenPr(db, {
      repo: 'owner/name', prNumber: 1, title: 't', author: 'a', branch: 'b',
      baseBranch: 'main', headSha: 'sha1', prUrl: 'u', isDraft: false,
    });
    db.prepare("UPDATE pull_requests SET review_status = 'done' WHERE pr_number = 1").run();
    fetchOpenPrsMock.mockResolvedValue([]);
    const result = await forceRecheck(db, 'owner/name', 1);
    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns error when gh pr list fails', async () => {
    upsertOpenPr(db, {
      repo: 'owner/name', prNumber: 1, title: 't', author: 'a', branch: 'b',
      baseBranch: 'main', headSha: 'sha1', prUrl: 'u', isDraft: false,
    });
    db.prepare("UPDATE pull_requests SET review_status = 'done' WHERE pr_number = 1").run();
    fetchOpenPrsMock.mockRejectedValue(new Error('gh: authentication required'));
    const result = await forceRecheck(db, 'owner/name', 1);
    expect(result).toEqual({ status: 'error', message: 'gh: authentication required' });
  });

  it('refreshes metadata, marks pending, and kicks off processOnePr under the poll lock on success', async () => {
    upsertOpenPr(db, {
      repo: 'owner/name', prNumber: 1, title: 'old title', author: 'a', branch: 'b',
      baseBranch: 'main', headSha: 'sha1', prUrl: 'u', isDraft: false,
    });
    db.prepare("UPDATE pull_requests SET review_status = 'failed' WHERE pr_number = 1").run();
    fetchOpenPrsMock.mockResolvedValue([
      { number: 1, title: 'new title', author: 'a', headRefName: 'b', baseRefName: 'main', headRefOid: 'sha2', url: 'u', isDraft: false },
    ]);

    const result = await forceRecheck(db, 'owner/name', 1);

    expect(result).toEqual({ status: 'started' });
    const row = db.prepare('SELECT * FROM pull_requests WHERE pr_number = 1').get() as { title: string; head_sha: string; review_status: string };
    expect(row.title).toBe('new title');
    expect(row.head_sha).toBe('sha2');
    expect(row.review_status).toBe('pending');
    expect(withPollLockMock).toHaveBeenCalledTimes(1);
    expect(processOnePrMock).toHaveBeenCalledWith(db, 'owner/name', expect.any(Number), 1, 'new title', 'b', 'main', 'sha2');
  });

  it('still refreshes metadata and marks pending, but reports queued (not started) when a scheduled poll tick already holds the mutex', async () => {
    upsertOpenPr(db, {
      repo: 'owner/name', prNumber: 1, title: 'old title', author: 'a', branch: 'b',
      baseBranch: 'main', headSha: 'sha1', prUrl: 'u', isDraft: false,
    });
    db.prepare("UPDATE pull_requests SET review_status = 'failed' WHERE pr_number = 1").run();
    fetchOpenPrsMock.mockResolvedValue([
      { number: 1, title: 'new title', author: 'a', headRefName: 'b', baseRefName: 'main', headRefOid: 'sha2', url: 'u', isDraft: false },
    ]);
    skipNext = true;

    const result = await forceRecheck(db, 'owner/name', 1);

    // A concurrently-running scheduled poll tick already holds the
    // mutex, so withPollLockMock resolves 'skipped' without ever
    // invoking processOnePr. The row is still guaranteed to be reviewed
    // eventually - getPendingPrs() (poller.ts) picks up any
    // review_status='pending' row on the next scheduled tick, regardless
    // of how it got set to 'pending' - but reporting 'started' here
    // would be misleading, since no processOnePr call was actually
    // dispatched this time.
    expect(result).toEqual({
      status: 'queued',
      message: 'A poll tick is already running; this PR will be reviewed automatically on the current or next poll cycle.',
    });
    const row = db.prepare('SELECT * FROM pull_requests WHERE pr_number = 1').get() as { review_status: string };
    expect(row.review_status).toBe('pending');
    expect(withPollLockMock).toHaveBeenCalledTimes(1);
    expect(processOnePrMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -- src/lib/recheck.test.ts`
Expected: FAIL — `Cannot find module './recheck'`.

- [ ] **Step 4: Write `src/lib/recheck.ts`**

```typescript
import type Database from 'better-sqlite3';
import { getByNumber, markPending, upsertOpenPr } from '../db/pullRequests';
import { fetchOpenPrs } from './gh';
import { withPollLock } from './queue';
import { processOnePr } from './poller';

export type RecheckOutcome =
  | { status: 'started' }
  | { status: 'queued'; message: string }
  | { status: 'already-in-progress' }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export async function forceRecheck(
  db: Database.Database,
  repo: string,
  prNumber: number
): Promise<RecheckOutcome> {
  const existing = getByNumber(db, repo, prNumber);
  if (!existing) return { status: 'not-found' };
  if (existing.review_status === 'pending' || existing.review_status === 'reviewing') {
    return { status: 'already-in-progress' };
  }

  let freshPrs;
  try {
    freshPrs = await fetchOpenPrs(repo);
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  const fresh = freshPrs.find((p) => p.number === prNumber);
  if (!fresh) return { status: 'not-found' }; // closed/merged since the last poll

  upsertOpenPr(db, {
    repo,
    prNumber: fresh.number,
    title: fresh.title,
    author: fresh.author,
    branch: fresh.headRefName,
    baseBranch: fresh.baseRefName,
    headSha: fresh.headRefOid,
    prUrl: fresh.url,
    isDraft: fresh.isDraft,
  });

  const row = getByNumber(db, repo, prNumber);
  if (!row) return { status: 'not-found' };

  // Bypass decidePrAction()'s gate entirely - this is an explicit user
  // request, not a routine "did head_sha change" poll decision. Marking
  // pending here is unconditional and safe regardless of what happens
  // next: getPendingPrs() (poller.ts) reads any review_status='pending'
  // row on its next scheduled tick, no matter how it got set to
  // 'pending', so this row is now guaranteed to be reviewed eventually
  // even in the worst case below.
  markPending(db, row.id);

  // Whether withPollLock() actually dispatches processOnePr (vs skipping
  // because a scheduled poll tick already holds the mutex) is decided
  // *synchronously* inside withPollLock/queue.ts's `isPollInProgress()`
  // check, before its own internal `await fn()` ever yields control.
  // Setting `dispatched = true` as the very first line of the callback
  // below - itself an async function that also runs synchronously up to
  // its own first `await` - means `dispatched` is already correct by the
  // time the `withPollLock(...)` call expression finishes evaluating (no
  // `await` of our own happens in between). This avoids a separate
  // up-front `isPollInProgress()` check, which would leave a race window
  // between that check and this call for a poll tick to start in.
  let dispatched = false;
  const lockPromise = withPollLock(async () => {
    dispatched = true;
    await processOnePr(db, repo, row.id, row.pr_number, row.title, row.branch, row.base_branch, row.head_sha);
  });

  if (!dispatched) {
    // A scheduled poll tick already holds the mutex. The row is still
    // guaranteed to be reviewed eventually - getPendingPrs() (poller.ts)
    // picks up any review_status='pending' row on the next scheduled
    // tick, regardless of how it got set to 'pending' - just not via
    // this call, so reporting 'started' here would be misleading.
    return {
      status: 'queued',
      message: 'A poll tick is already running; this PR will be reviewed automatically on the current or next poll cycle.',
    };
  }

  // Fire-and-forget: the actual review can take up to REVIEW_TIMEOUT_MS
  // (10 minutes in poller.ts), far longer than an HTTP request should
  // block for. The caller just needs to know the request was accepted;
  // review_status transitions through 'reviewing' -> 'done'/'failed' are
  // visible on the next page load, same as with a scheduled poll tick.
  void lockPromise;

  return { status: 'started' };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- src/lib/recheck.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the failing test for the API route**

`src/app/api/recheck/[number]/route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDbMock = vi.fn();
vi.mock('../../../../db/client', () => ({ getDb: () => getDbMock() }));

const getConfigMock = vi.fn();
vi.mock('../../../../db/config', () => ({ getConfig: (...args: unknown[]) => getConfigMock(...args) }));

const forceRecheckMock = vi.fn();
vi.mock('../../../../lib/recheck', () => ({ forceRecheck: (...args: unknown[]) => forceRecheckMock(...args) }));

const { POST } = await import('./route');

describe('POST /api/recheck/[number]', () => {
  const dbStub = {};

  beforeEach(() => {
    getDbMock.mockReturnValue(dbStub);
    getConfigMock.mockReset();
    forceRecheckMock.mockReset();
  });

  it('returns 500 when target_repo is not configured', async () => {
    getConfigMock.mockReturnValue(undefined);
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), { params: { number: '1' } });
    expect(res.status).toBe(500);
  });

  it('returns 400 for a non-numeric PR number', async () => {
    getConfigMock.mockReturnValue('owner/name');
    const res = await POST(new Request('http://localhost/api/recheck/abc', { method: 'POST' }), { params: { number: 'abc' } });
    expect(res.status).toBe(400);
  });

  it('returns 202 when forceRecheck starts a review', async () => {
    getConfigMock.mockReturnValue('owner/name');
    forceRecheckMock.mockResolvedValue({ status: 'started' });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), { params: { number: '1' } });
    expect(res.status).toBe(202);
    expect(forceRecheckMock).toHaveBeenCalledWith(dbStub, 'owner/name', 1);
  });

  it('returns 202 with a queued message when a scheduled poll tick is already running', async () => {
    getConfigMock.mockReturnValue('owner/name');
    const queuedMessage = 'A poll tick is already running; this PR will be reviewed automatically on the current or next poll cycle.';
    forceRecheckMock.mockResolvedValue({ status: 'queued', message: queuedMessage });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), { params: { number: '1' } });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.message).toBe(queuedMessage);
  });

  it('returns 409 when a review is already in progress', async () => {
    getConfigMock.mockReturnValue('owner/name');
    forceRecheckMock.mockResolvedValue({ status: 'already-in-progress' });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), { params: { number: '1' } });
    expect(res.status).toBe(409);
  });

  it('returns 404 when the PR is not found', async () => {
    getConfigMock.mockReturnValue('owner/name');
    forceRecheckMock.mockResolvedValue({ status: 'not-found' });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), { params: { number: '1' } });
    expect(res.status).toBe(404);
  });

  it('returns 502 when fetching fresh PR data fails', async () => {
    getConfigMock.mockReturnValue('owner/name');
    forceRecheckMock.mockResolvedValue({ status: 'error', message: 'gh: authentication required' });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), { params: { number: '1' } });
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm run test -- src/app/api/recheck/\[number\]/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 8: Write `src/app/api/recheck/[number]/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { getDb } from '../../../../db/client';
import { getConfig } from '../../../../db/config';
import { forceRecheck } from '../../../../lib/recheck';

export async function POST(_request: Request, { params }: { params: { number: string } }) {
  const db = getDb();
  const repo = getConfig(db, 'target_repo');
  if (!repo) {
    return NextResponse.json({ error: 'target_repo is not configured' }, { status: 500 });
  }

  const prNumber = Number(params.number);
  if (!Number.isInteger(prNumber)) {
    return NextResponse.json({ error: 'invalid PR number' }, { status: 400 });
  }

  const outcome = await forceRecheck(db, repo, prNumber);
  switch (outcome.status) {
    case 'started':
      return NextResponse.json({ status: 'started' }, { status: 202 });
    case 'queued':
      return NextResponse.json({ status: 'queued', message: outcome.message }, { status: 202 });
    case 'already-in-progress':
      return NextResponse.json({ status: 'already-in-progress' }, { status: 409 });
    case 'not-found':
      return NextResponse.json({ error: 'PR not found or no longer open' }, { status: 404 });
    case 'error':
      return NextResponse.json({ error: outcome.message }, { status: 502 });
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm run test -- src/app/api/recheck/\[number\]/route.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 10: Commit**

```bash
git add src/lib/poller.ts src/lib/recheck.ts src/lib/recheck.test.ts src/app/api/recheck/\[number\]/route.ts src/app/api/recheck/\[number\]/route.test.ts
git commit -m "feat(ui): add force-recheck API route with single-flight and fresh head_sha fetch"
```

---

### Task 7.2: Full chunk test run

**Files:** None (verification only).

- [ ] **Step 1: Run the entire test suite**

Run: `npm run test`
Expected: PASS. Running total across all 7 chunks: 71 (Chunks 1-4) + 8
(VerdictBadge/SeverityBadge) + 6 (listPageViewModel) + 2
(PollStatusBanner) + 4 (detailPageViewModel is 3, FindingCard is 1) + 6
(recheck) + 7 (route) = **104 tests total**. (Recount precisely from
actual test runner output — this is an approximate running total for
sanity-checking, not a hard assertion.)

- [ ] **Step 2: Manually verify the end-to-end flow once**

With `TARGET_REPO` set to a real repo you have `gh` access to:
```bash
npm run dev
```
Then in a browser:
1. Visit `/` and confirm the repo name, poll status, and PR table render.
2. Click into a PR's detail page and confirm Executive Summary / Top
   Risks / Medium-Low / raw report render for a PR that has already been
   reviewed by the Chunk 4 poller.
3. Click "Re-check now" and confirm the row's `review_status` flips to
   `reviewing` (visible on the next page reload) and eventually resolves
   to `done`/`failed`.

Expected: no console/server errors; the PR that was re-checked ends up
with an updated `last_attempted_at` (and `last_reviewed_at`/findings if
the review succeeds).

- [ ] **Step 3: Commit** (only if Step 2 required any fixes; otherwise
skip — this task is verification-only)

