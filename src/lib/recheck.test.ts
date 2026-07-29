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

  it.each(['merged', 'closed'] as const)(
    'returns not-found for a %s PR, even if review_status is still pending (defensive guard; UI never shows Re-check for these)',
    async (prState) => {
      upsertOpenPr(db, {
        repo: 'owner/name', prNumber: 1, title: 't', author: 'a', branch: 'b',
        baseBranch: 'main', headSha: 'sha1', prUrl: 'u', isDraft: false,
      });
      db.prepare("UPDATE pull_requests SET pr_state = ?, closed_at = datetime('now') WHERE pr_number = 1").run(prState);

      const result = await forceRecheck(db, 'owner/name', 1);

      expect(result).toEqual({ status: 'not-found' });
      expect(fetchOpenPrsMock).not.toHaveBeenCalled();
    }
  );

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
