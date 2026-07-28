import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './client';
import {
  upsertOpenPr,
  markClosedExcept,
  markReviewing,
  markDone,
  markFailed,
  markPending,
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
});
