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
