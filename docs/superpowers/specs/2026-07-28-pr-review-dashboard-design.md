# PR Review Dashboard — Design Spec

Date: 2026-07-28

## Summary

A local-only web dashboard that watches a single configured GitHub repository
for open (non-draft) pull requests, automatically runs an in-depth code
review on each PR (and re-runs when new commits are pushed), and presents the
results in a list/detail dashboard UI. All product UI, code, and docs are in
English; this design conversation was conducted in Chinese per user
preference, but the product itself targets English-speaking developers.

## Goals

- Monitor a single, user-configured `owner/repo` for open, non-draft PRs.
- Poll every 5 minutes via the `gh` CLI (no public ingress required).
- Automatically (re-)review a PR when it is first seen, or when its
  `head_sha` changes (new commits pushed).
- Perform the review by invoking the `copilot` CLI in headless mode
  (`copilot -p "..."`) against a local checkout of the PR branch, triggering
  the repository's `local-advanced-code-review` skill.
- Persist only the latest review result per PR (no historical review
  versions).
- Present results in a List Page (all tracked PRs + summary) and a Detail
  Page (full findings for one PR), following the `local-advanced-code-review`
  output structure: Executive Summary → Top Risks (CRITICAL/HIGH) →
  Medium/Low summary → supporting diff/evidence.
- Run everything from a single process (`npm run dev`) for simplicity in a
  local dev context.

## Non-Goals

- Multi-repo monitoring (explicitly deferred; schema should not block adding
  it later, but v1 only supports one repo).
- Webhook-based real-time triggering (deferred in favor of polling).
- Review history / trend tracking (only the latest review is kept).
- Auto-fixing code (the underlying skill is review-only by default).
- Authentication/multi-user support (single local user, relies on local `gh`
  and `copilot` CLI auth).

## Architecture

- **Stack**: Next.js (App Router, TypeScript), SQLite via `better-sqlite3`,
  `node-cron` for scheduling, `gh` CLI for PR metadata, `copilot` CLI in
  headless mode for review execution.
- **Single process**: `npm run dev` starts Next.js. An `instrumentation.ts`
  `register()` hook registers a cron job that runs every 5 minutes.
- **Data flow**:
  1. Cron job runs `gh pr list --repo <owner/repo> --state open --json
     number,title,author,headRefName,headRefOid` (drafts excluded by
     default in this query, but the implementation must also explicitly
     filter `isDraft=false` since `gh pr list --state open` includes
     drafts).
  2. Compare results against the `pull_requests` table: a PR is new, or its
     `head_sha` differs from `reviewed_head_sha` → enqueue for review.
  3. The queue is processed in-process, serially (avoid contention on the
     local machine). Each queued PR:
     - `git fetch` + checkout (via `git worktree add`) the PR branch into a
       local cache directory: `~/.pr-review-dashboard/repos/<owner>__<repo>`.
     - Mark `review_status = 'reviewing'` in the DB immediately so the UI
       reflects in-progress state.
     - Spawn `copilot -p "<prompt>"` headless in the worktree directory. The
       prompt includes PR number/title/branch/base and instructs Copilot to
       perform the `local-advanced-code-review` skill's review flow, and to
       append a fenced JSON block at the end with structured findings (see
       Data Model) in addition to the normal markdown report.
     - Parse the process output: extract the trailing JSON block for
       structured `findings` + `verdict`; store the full raw text as
       `raw_report_md` regardless of JSON parse success.
     - Delete old `findings` rows for the PR, insert new ones, update
       `pull_requests` (verdict, severity counts, `reviewed_head_sha`,
       `last_reviewed_at`, `review_status='done'`).
     - On any failure (fetch/checkout/spawn/timeout/non-zero exit), set
       `review_status='failed'` and `error_message`, but leave the
       previous successful review data (`raw_report_md`, findings, verdict)
       untouched so the UI doesn't regress to a blank state.
  4. Pages are Next.js Server Components that read directly from SQLite —
     no separate polling API needed for rendering.
  5. A manual "Re-check now" action (API route) lets a user force an
     immediate poll+review cycle for one PR without waiting for the next
     cron tick — primarily for local development/debugging.

## Data Model (SQLite)

```sql
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT
); -- e.g. ('target_repo', 'owner/name')

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT,
  author TEXT,
  branch TEXT,
  head_sha TEXT,
  pr_url TEXT,
  review_status TEXT,      -- 'pending' | 'reviewing' | 'done' | 'failed'
  verdict TEXT,            -- 'approve' | 'needs_fix' | 'needs_review' | NULL
  severity_critical INTEGER DEFAULT 0,
  severity_high INTEGER DEFAULT 0,
  severity_medium INTEGER DEFAULT 0,
  severity_low INTEGER DEFAULT 0,
  reviewed_head_sha TEXT,  -- head_sha as of the last completed review
  last_reviewed_at TEXT,
  raw_report_md TEXT,      -- full markdown report for the detail page
  error_message TEXT,      -- populated when review_status='failed'
  UNIQUE(repo, pr_number)
);

CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_request_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  file TEXT,
  line INTEGER,
  severity TEXT,           -- CRITICAL | HIGH | MEDIUM | LOW
  summary TEXT,
  failure_scenario TEXT,
  evidence TEXT,
  fix_suggestion TEXT,
  code_snippet TEXT
);
```

Only the latest review per PR is kept: on each re-review, existing
`findings` rows for that `pull_request_id` are deleted before inserting the
new set, and `pull_requests` fields are overwritten in place.

## Pages & Components

- **List Page (`/`)**: Server Component querying `pull_requests`. Table
  columns: PR number, title, branch, author, last reviewed time, verdict
  badge, CRITICAL+HIGH count. Rows in `review_status='reviewing'` show an
  in-progress indicator. Header shows the configured repo and last poll
  time. Clicking a row navigates to `/pr/[number]`.
- **Detail Page (`/pr/[number]`)**:
  - Executive Summary (verdict + severity counts).
  - Top Risks (CRITICAL/HIGH), each with: summary, failure scenario,
    evidence, fix suggestion, code snippet.
  - Medium/Low findings summarized as a list.
  - Collapsible full `raw_report_md` as a fallback (protects against gaps
    in structured parsing).
  - If `review_status='failed'`: show `error_message` and a "Retry" action.
- Both pages expose a "Re-check now" button that calls an API route to
  force an immediate review cycle for that PR.

## Error Handling

- `gh pr list` failure (network/auth): log and retry on the next poll tick;
  does not affect already-rendered data.
- `git fetch`/checkout failure: mark that PR `review_status='failed'` with
  `error_message`; other PRs in the same poll cycle are unaffected.
- `copilot -p` timeout (e.g., 10 minutes) or non-zero exit: mark
  `review_status='failed'`; previous successful review data is preserved
  rather than overwritten.
- Structured JSON block missing/malformed in the copilot output: still
  persist `raw_report_md` in full; leave `findings` empty and set
  `verdict='needs_review'` so a human can read the raw report.

## Testing Strategy

- **Unit tests (Vitest)**:
  - `parseReviewOutput()`: extracting the JSON findings block and raw
    markdown from copilot's output, covering well-formed, missing-JSON, and
    malformed-JSON cases.
  - Pure decision logic for "new PR" vs "head_sha changed, needs
    re-review" vs "no action needed".
  - Repository/data-access functions against an in-memory SQLite instance.
- **Integration tests**: mock the `gh` and `copilot` child_process calls
  with fixture output, verifying the full path from "poll discovers a PR"
  to "DB updated" to "page can query the data".
- **Manual verification**: the actual `copilot -p` invocation is not
  covered by automated tests (LLM output is non-deterministic); verify
  prompt effectiveness manually against a real small PR during
  development.

## Open Questions / Future Extensions

- Multi-repo support (schema already supports multiple rows in
  `pull_requests` distinguished by `repo`, but polling/config currently
  assumes one target repo).
- Webhook-based real-time triggering as an alternative/complement to
  polling.
- Review history/trend view (currently explicitly out of scope).
