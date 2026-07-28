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
  Configuration source: a `TARGET_REPO=owner/name` environment variable
  (via `.env.local`), read once at process startup. On first read, its
  value is upserted into the `config` table (`key='target_repo'`) purely so
  the UI header can display it without re-reading the environment; the env
  var remains the source of truth for v1 (no in-app config editing UI). If
  `TARGET_REPO` is unset or malformed (not `owner/name`) at startup, the
  process logs a fatal error and exits immediately rather than starting the
  dashboard in a half-configured state.
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
- **All git operations against the remote/GitHub are strictly read-only.**
  The tool only ever runs `git clone --bare`, `git fetch`, and local
  `git worktree add`/checkout operations to inspect PR code. It never runs
  `git push`, never creates/updates/deletes any remote branch, and never
  writes back to GitHub (no PR comments, no status checks, no labels) in
  v1 — the dashboard only reads PR metadata (via `gh pr list`) and code
  (via local git), and surfaces results in its own local UI/DB. This
  applies to every component that touches the remote repo: the poller,
  the repo-cache/worktree manager, and the review runner.

## Non-Goals

- Multi-repo monitoring (explicitly deferred; schema should not block adding
  it later, but v1 only supports one repo).
- Webhook-based real-time triggering (deferred in favor of polling).
- Review history / trend tracking (only the latest review is kept).
- Auto-fixing code (the underlying skill is review-only by default).
- Writing back to GitHub in any form (PR comments, check runs, labels,
  pushes) — the dashboard is a read-only observer of the remote repo.
- Authentication/multi-user support (single local user, relies on local `gh`
  and `copilot` CLI auth).

## Architecture

- **Stack**: Next.js (App Router, TypeScript), SQLite via `better-sqlite3`,
  `node-cron` for scheduling, `gh` CLI for PR metadata, `copilot` CLI in
  headless mode for review execution.
- **Single process**: `npm run dev` starts Next.js. An `instrumentation.ts`
  `register()` hook registers a cron job that runs every 5 minutes. Because
  Next.js dev mode can invoke `register()` more than once (e.g., on hot
  reload), the hook guards itself with a module-level flag (e.g. a global
  singleton keyed off `globalThis`) so a second invocation is a no-op and
  only one cron job is ever active per process. On every process start
  (including after a crash), before the first poll tick runs, any row left
  in `review_status='pending'` or `'reviewing'` from a previous process is
  reset to `'failed'` with `error_message='Interrupted by process
  restart'` — this guarantees no PR can be permanently stuck against the
  single-flight rule; it will be picked up again on the next poll tick
  (new PR / `head_sha` differs from `reviewed_head_sha`, which is
  unaffected by this reset) or via manual "Re-check now".
- **Data flow**:
  1. Cron job runs `gh pr list --repo <owner/repo> --state open --json
     number,title,author,headRefName,headRefOid,baseRefName,isDraft,url`.
     `--state open` includes drafts, so this single query is the source of
     truth for "still open" regardless of draft status; `is_draft` is
     stored on the row and used only to gate review-triggering (step 2),
     never to decide `pr_state` (see below). `baseRefName` is retained so
     the review step can diff the PR branch against the correct base, and
     `url` is stored as `pr_url` for linking out to GitHub from the UI.
  2. Compare results against the `pull_requests` table:
     - Every PR returned by the query (draft or not) is upserted with
       `pr_state='open'` and its current `is_draft` flag — this is what
       correctly re-opens a previously closed-then-reopened PR, and also
       means a PR toggling between draft ↔ ready for review is never
       misclassified as closed (it's simply present in the same open-PR
       result throughout).
     - Among those, a PR is enqueued for review only if `is_draft=false`
       AND (it's new OR its `head_sha` differs from `reviewed_head_sha`)
       AND it is not already `pending` or `reviewing` (see single-flight
       rule in step 3). New rows start as `review_status='pending'`.
     - A previously tracked PR that does not appear at all in this poll's
       result (i.e., not open in any form, draft or not — closed or
       merged) is marked `pr_state='closed'`; its row and last review are
       kept for reference, but the List Page's default view filters to
       `pr_state='open' AND is_draft=0` — drafts are tracked in the
       database (so they aren't misclassified as closed while in draft)
       but stay entirely hidden from the dashboard UI in v1, matching the
       "only track non-draft open PRs" requirement; they are never
       reviewed and never shown until they leave draft state.
     If the `gh pr list` call itself fails (e.g., network/auth error),
     this entire step is skipped for that tick — no rows are upserted or
     closed — and `config` `key='last_poll_status'` is set to `'error'`
     with `key='last_poll_error'` holding the message. On success, update
     `config` `key='last_poll_at'` (current timestamp), set
     `key='last_poll_status'='ok'`, and clear `key='last_poll_error'` (set
     to an empty value) so a stale error message doesn't linger after
     recovery. The List Page header shows both the timestamp and, if the
     last attempt failed, a visible "last poll failed: <error>" indicator
     so stale data is never presented as fresh.
  3. The queue built in step 2 is processed in-process, one PR at a time
     (a PR sits in `review_status='pending'` from the moment it's enqueued
     until its turn comes up later in the same tick, which may take a
     while if several PRs changed at once). **Single-flight rule:** a PR
     already in `review_status='pending'` or `'reviewing'` is never
     enqueued again — by the cron poller, by an overlapping poll tick, or
     by the manual "Re-check now"/"Retry" action (see step 5); all three
     paths check the same in-DB status immediately before enqueuing.
     Additionally, the cron job itself is guarded by a run-level mutex (a
     module-level "poll in progress" flag): if a poll tick is still
     running (e.g., a slow `copilot` invocation) when the next scheduled
     tick fires, the new tick is skipped entirely and logged, rather than
     starting a second, overlapping poll. Repo caching/worktree layout
     (read-only against the remote — fetch/clone only, never push):
     - A single bare/mirror clone per target repo lives at
       `~/.pr-review-dashboard/repos/<owner>__<repo>/repo.git` (created via
       `git clone --bare` on first use, then `git fetch` on each poll —
       no other remote-mutating commands are ever run against it).
     - Each PR gets its own worktree at
       `~/.pr-review-dashboard/repos/<owner>__<repo>/worktrees/pr-<number>`,
       created with `git worktree add <path> <head_sha>` (or
       `git worktree add --force` re-pointed to the new `head_sha` when
       re-reviewing) from the bare repo — purely a local checkout, never
       pushed anywhere. The base branch is fetched into
       the same bare repo, so `git diff <baseRefName>...<head_sha>` can be
       computed from within the worktree without a separate checkout.
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
       `last_reviewed_at`, `last_attempted_at`, `review_status='done'`).
     - On any failure (fetch/checkout/spawn/timeout/non-zero exit), set
       `review_status='failed'`, `error_message`, and `last_attempted_at`,
       but leave the previous successful review data (`raw_report_md`,
       findings, verdict, `reviewed_head_sha`, `last_reviewed_at`)
       untouched so the UI doesn't regress to a blank state — the Detail
       Page distinguishes this from a normal successful review (see Pages
       & Components: stale-data banner).
  4. Pages are Next.js Server Components that read directly from SQLite —
     no separate polling API needed for rendering.
  5. A manual "Re-check now"/"Retry" action (API route) lets a user force
     an immediate review for one PR without waiting for the next cron
     tick or a `head_sha` change — it always enqueues the PR (bypassing
     the "new or `head_sha` changed" gate in step 2), fetching the latest
     `head_sha` first so the forced run reviews current code. Per the
     single-flight rule in step 3, it is a no-op (surfaced to the user,
     e.g. a toast/disabled state) if that PR is already `pending` or
     `review_status='reviewing'`. Primarily for local development/
     debugging.

## Data Model (SQLite)

```sql
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT
); -- e.g. ('target_repo', 'owner/name'), ('last_poll_at', ISO timestamp),
   -- ('last_poll_status', 'ok'|'error'), ('last_poll_error', message)

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT,
  author TEXT,
  branch TEXT,
  base_branch TEXT,
  head_sha TEXT,
  pr_url TEXT,             -- link to the PR on GitHub, shown on both pages
  is_draft INTEGER DEFAULT 0, -- gates review-triggering only; does not
                               -- affect pr_state (see below)
  pr_state TEXT DEFAULT 'open', -- 'open' | 'closed'. 'open' = present in
                                 -- the latest `gh pr list --state open`
                                 -- result, draft or not. 'closed' = absent
                                 -- from that result entirely (merged or
                                 -- closed upstream); row/review data
                                 -- retained.
  review_status TEXT,      -- 'pending' | 'reviewing' | 'done' | 'failed'
                            -- pending = enqueued, not yet started;
                            -- reviewing = worktree/copilot run in progress;
                            -- done/failed = terminal states until next
                            -- head_sha change or manual re-check
  verdict TEXT,            -- 'approve' | 'needs_fix' | 'needs_review' | NULL
  severity_critical INTEGER DEFAULT 0,
  severity_high INTEGER DEFAULT 0,
  severity_medium INTEGER DEFAULT 0,
  severity_low INTEGER DEFAULT 0,
  reviewed_head_sha TEXT,  -- head_sha as of the last completed review
  last_reviewed_at TEXT,   -- set only on a successful review (done)
  last_attempted_at TEXT,  -- set on every attempt, success or failure;
                            -- used for the failed-review banner's
                            -- "latest re-check failed at" timestamp
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

- **List Page (`/`)**: Server Component querying `pull_requests` filtered
  to `pr_state='open' AND is_draft=0` (drafts are stored but never shown
  in v1). Table
  columns: PR number, title, branch, author, last reviewed time, verdict
  badge, CRITICAL+HIGH count. Rows in `review_status='reviewing'` show an
  in-progress indicator; rows in `review_status='failed'` show an ❌
  "review failed" badge instead of a verdict badge (with the CRITICAL/HIGH
  column showing the last successful counts if `last_reviewed_at` is set,
  or `-` if it's `NULL`, i.e. never successfully reviewed). Header shows
  the configured repo
  (`config.target_repo`), last poll time (`config.last_poll_at`), and — if
  `config.last_poll_status='error'` — a warning banner with
  `config.last_poll_error` so the user knows the list may be stale.
  Clicking a row navigates to `/pr/[number]`.
- **Detail Page (`/pr/[number]`)**:
  - Executive Summary (verdict + severity counts).
  - Top Risks (CRITICAL/HIGH), each with: summary, failure scenario,
    evidence, fix suggestion, code snippet.
  - Medium/Low findings summarized as a list.
  - Collapsible full `raw_report_md` as a fallback (protects against gaps
    in structured parsing).
  - If `review_status='failed'` and `last_reviewed_at` is set (a previous
    successful review exists): the page still renders that previous
    review data in full (Executive Summary, Top Risks, Medium/Low, raw
    report), but shows a prominent banner above it: "⚠ Latest re-check
    failed at `<last_attempted_at>`: `<error_message>`. Showing results
    from the last successful review (`<last_reviewed_at>`, commit
    `<reviewed_head_sha>`)." plus a "Retry" action. This makes clear to
    the user that the visible findings may not reflect the PR's current
    code.
  - If `review_status='failed'` and `last_reviewed_at` is `NULL` (the PR
    has never been successfully reviewed, e.g. it failed on first
    attempt): there is no prior data to fall back to, so the page shows
    only an error state — "Review failed at `<last_attempted_at>`:
    `<error_message>`. No successful review yet." plus a "Retry" action —
    with no Executive Summary/Top Risks/findings sections rendered.
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
- Structured JSON block missing/malformed in the copilot output: this is
  treated as a *successful* review that completed without full structured
  data, not a failure — `review_status` still advances to `'done'`,
  `reviewed_head_sha` and `last_reviewed_at` update normally (so it won't
  be endlessly retried on the same `head_sha`), and `raw_report_md` is
  persisted in full. Only `findings` is left empty and `verdict` is set to
  `'needs_review'` so a human knows to read the raw report. This is
  distinct from `review_status='failed'`, which is reserved for cases
  where the review did not produce usable output at all (fetch/checkout
  error, spawn error, timeout, non-zero exit) — in those cases
  `reviewed_head_sha`/`last_reviewed_at` are *not* updated, so the PR is
  retried on the next poll tick.

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
