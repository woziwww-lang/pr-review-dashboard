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
pullRequests: 11, findings: 3, decision: 9, gh: 3, parseReviewOutput: 7,
reviewPrompt: 1 — 39 tests total).

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
reviewPrompt: 1, repoCache: 6, reviewRunner: 4 — 49 tests total).

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "test: verify chunk 3 repo cache and review execution passes as a whole" --allow-empty
```

---
