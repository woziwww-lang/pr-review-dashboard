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
  instrumentation.ts          # registers cron job + crash recovery, once per process
  vitest.config.ts
  src/
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
      gh.ts                     # listOpenPrs(repo): shells out to `gh pr list`, parses JSON
      gh.test.ts
      repoCache.ts              # ensureBareClone, fetchAll, ensureWorktree(prNumber, headSha, baseBranch)
      repoCache.test.ts
      reviewPrompt.ts           # buildReviewPrompt(pr): returns the string passed to `copilot -p`
      reviewPrompt.test.ts
      reviewRunner.ts           # runReview(worktreePath, prompt): spawns `copilot -p`, enforces timeout, returns {stdout, exitCode}
      reviewRunner.test.ts
      parseReviewOutput.ts      # parseReviewOutput(rawOutput): extracts trailing JSON block -> {findings, verdict} + rawMarkdown
      parseReviewOutput.test.ts
      decision.ts                # shouldEnqueue(existingRow, freshPr): pure function, the "new or head_sha changed and not pending/reviewing" rule
      decision.test.ts
      queue.ts                    # in-process single-flight tracking + poll-tick mutex
      queue.test.ts
      poller.ts                   # orchestrates one full poll tick end-to-end
      poller.test.ts
      startup.ts                  # resets stuck pending/reviewing rows to failed on boot
      startup.test.ts
    app/
      layout.tsx
      page.tsx                    # List Page (Server Component)
      pr/[number]/page.tsx        # Detail Page (Server Component)
      api/recheck/[number]/route.ts   # POST: force immediate review for one PR
      components/
        VerdictBadge.tsx
        SeverityBadge.tsx
        PollStatusBanner.tsx
        FindingCard.tsx
```

**Responsibilities:**
- `db/*`: all SQLite access. Nothing outside this folder touches `better-sqlite3` directly.
- `lib/gh.ts`, `lib/repoCache.ts`, `lib/reviewRunner.ts`: thin wrappers around external processes (`gh`, `git`, `copilot`). Each does one external-process concern and is independently mockable.
- `lib/parseReviewOutput.ts`, `lib/decision.ts`: pure functions, no I/O — the easiest things to unit test exhaustively.
- `lib/poller.ts`: the only place that wires `gh.ts` + `repoCache.ts` + `reviewRunner.ts` + `parseReviewOutput.ts` + `db/*` together for one poll tick. This is also called directly by the "Re-check now" API route for a single PR.
- `lib/queue.ts`: in-memory (not persisted) single-flight + mutex state, isolated so it can be unit tested without spawning real processes.
- `app/*`: Next.js UI, reads only through `db/*` functions, never touches `gh`/`git`/`copilot` directly.

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
  return db
    .prepare('SELECT * FROM findings WHERE pull_request_id = ? ORDER BY severity, line')
    .all(pullRequestId) as FindingRow[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/db/findings.test.ts`
Expected: PASS, 3 tests.

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
