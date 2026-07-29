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
  pr_state: 'open' | 'merged' | 'closed';
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
  closed_at: string | null;
}

type FinalPrState = Exclude<PullRequestRow['pr_state'], 'open'>;

/**
 * Syncs one PR's metadata from `gh pr list` into the database. This is a
 * pure metadata sync, NOT an enqueue decision:
 * - On INSERT (first time this PR is seen), `review_status` starts at the
 *   schema default `'pending'` — including for drafts. That's harmless:
 *   a draft's row just sits at `pending` indefinitely because it's
 *   filtered out of `getVisiblePrs()` (see below), the Chunk 3 poller's
 *   enqueue decision explicitly skips any row with `is_draft=1`
 *   regardless of `review_status`, and `resetStuckReviews()` (below)
 *   likewise excludes `is_draft=1` rows and never touches `'pending'` rows
 *   at all — a draft (or any never-started PR) is never fabricated into
 *   a "review failed" or re-queued state after a restart.
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
  keepPrNumbers: number[],
  finalStates: Record<number, FinalPrState> = {}
): void {
  const closedAt = new Date().toISOString();
  const buildStateCase = (prNumbers: number[]) =>
    prNumbers.length === 0
      ? `'closed'`
      : `CASE pr_number ${prNumbers
        .map((prNumber) => `WHEN ${prNumber} THEN '${finalStates[prNumber] ?? 'closed'}'`)
        .join(' ')} ELSE 'closed' END`;

  if (keepPrNumbers.length === 0) {
    const finalStateNumbers = Object.keys(finalStates).map(Number);
    const stateCase = buildStateCase(finalStateNumbers);
    // No PRs currently open for this repo (or gh returned an empty list):
    // close every still-open tracked row. `NOT IN ()` is invalid SQL, so
    // this case must be handled separately rather than falling through to
    // the parameterized query.
    db.prepare(
      `UPDATE pull_requests
       SET pr_state = ${stateCase},
           closed_at = @closedAt
       WHERE repo = @repo AND pr_state = 'open'`
    ).run({ repo, closedAt });
    return;
  }

  const closingPrNumbers = Array.from(new Set(
    db.prepare(
      `SELECT pr_number FROM pull_requests
       WHERE repo = ? AND pr_state = 'open' AND pr_number NOT IN (${keepPrNumbers.map(() => '?').join(',')})`
    ).all(repo, ...keepPrNumbers).map((row) => (row as { pr_number: number }).pr_number)
  ));
  const stateCase = buildStateCase(closingPrNumbers);
  const placeholders = keepPrNumbers.map(() => '?').join(',');
  db.prepare(
    `UPDATE pull_requests
     SET pr_state = ${stateCase},
         closed_at = ?
     WHERE repo = ? AND pr_state = 'open' AND pr_number NOT IN (${placeholders})`
  ).run(closedAt, repo, ...keepPrNumbers);
}

export function getVisiblePrs(
  db: Database.Database,
  repo: string,
  retentionDays = 3,
  nowIso = new Date().toISOString()
): PullRequestRow[] {
  return db
    .prepare(
      `SELECT * FROM pull_requests
       WHERE repo = ? AND is_draft = 0
         AND (
           pr_state = 'open'
           OR (
             pr_state IN ('merged', 'closed')
             AND closed_at IS NOT NULL
             AND datetime(closed_at) > datetime(?, '-' || ? || ' days')
           )
         )
       ORDER BY pr_number DESC`
    )
    .all(repo, nowIso, retentionDays) as PullRequestRow[];
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

// Excludes drafts: a draft PR's row can sit at review_status='pending'
// indefinitely (upsertOpenPr's insert default, see Chunk 1), but drafts
// are never actually supposed to be reviewed or shown — this is the
// query the poller's queue-processing loop uses, so it must filter them
// out here rather than relying on callers to remember to do so.
export function getPendingPrs(db: Database.Database, repo: string): PullRequestRow[] {
  return db
    .prepare(
      `SELECT * FROM pull_requests
       WHERE repo = ? AND pr_state = 'open' AND review_status = 'pending' AND is_draft = 0
       ORDER BY id ASC`
    )
    .all(repo) as PullRequestRow[];
}

export function deleteStaleClosedPrs(
  db: Database.Database,
  retentionDays = 3,
  nowIso = new Date().toISOString()
): number {
  const result = db
    .prepare(
      `DELETE FROM pull_requests
       WHERE pr_state != 'open'
         AND closed_at IS NOT NULL
         AND datetime(closed_at) <= datetime(?, '-' || ? || ' days')`
    )
    .run(nowIso, retentionDays);
  return result.changes;
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

export function markPending(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE pull_requests SET
       review_status = 'pending',
       error_message = NULL
     WHERE id = @id`
  ).run({ id });
}

export function resetStuckReviews(db: Database.Database): number {
  // Only 'reviewing' rows are genuinely "stuck": a process restart killed
  // the in-flight `copilot -p` child before it could report a result. That
  // is not evidence the review actually failed — it's evidence the review
  // never got a chance to finish — so these are re-queued back to
  // 'pending' (to be retried on the next poll tick) rather than flipped to
  // 'failed'. Fabricating a 'failed' verdict here previously produced a
  // misleading "review failed" banner on every local dev-server restart,
  // even though no review had actually errored.
  //
  // 'pending' rows are deliberately left untouched: they were never
  // started in the first place (a restart doesn't interrupt anything for
  // them), so they need no reset — they'll simply be picked up by the
  // next poll tick as normal. This also naturally excludes draft PRs,
  // which sit at the schema default review_status='pending' forever
  // because the poller skips is_draft=1 rows — they must never be
  // touched here, since they were never enqueued for review to begin
  // with.
  const result = db
    .prepare(
      `UPDATE pull_requests SET
       review_status = 'pending',
       error_message = NULL
     WHERE review_status = 'reviewing' AND is_draft = 0`
    )
    .run();
  return result.changes;
}
