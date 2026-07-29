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
  getVisiblePrs,
  getByNumber,
  getPendingPrs,
  resetStuckReviews,
  deleteStaleClosedPrs,
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

  it('marks PRs not in the keep-list with their resolved final state and stamps closed_at', () => {
    upsertOpenPr(db, basePr);
    upsertOpenPr(db, { ...basePr, prNumber: 2 });

    markClosedExcept(db, 'owner/name', [1], { 2: 'merged' });

    const row = getByNumber(db, 'owner/name', 2)!;
    expect(row.pr_state).toBe('merged');
    expect(row.closed_at).toBeTruthy();
  });

  it('closes every tracked PR when the keep-list is empty (e.g. gh returned zero open PRs)', () => {
    upsertOpenPr(db, basePr);
    upsertOpenPr(db, { ...basePr, prNumber: 2 });

    markClosedExcept(db, 'owner/name', []);

    expect(getByNumber(db, 'owner/name', 1)!.pr_state).toBe('closed');
    expect(getByNumber(db, 'owner/name', 2)!.pr_state).toBe('closed');
  });

  it('getVisiblePrs keeps open PRs and only recently closed/merged non-draft PRs within retention', () => {
    upsertOpenPr(db, basePr);
    upsertOpenPr(db, { ...basePr, prNumber: 2, isDraft: true });
    upsertOpenPr(db, { ...basePr, prNumber: 3 });
    upsertOpenPr(db, { ...basePr, prNumber: 4 });
    upsertOpenPr(db, { ...basePr, prNumber: 5 });
    markClosedExcept(db, 'owner/name', [1, 2], { 3: 'closed', 4: 'merged' });
    markClosedExcept(db, 'owner/name', [1, 2, 3, 4], { 5: 'closed' });

    db.prepare(
      `UPDATE pull_requests
       SET closed_at = CASE pr_number
         WHEN 3 THEN '2026-07-28T20:00:00.000Z'
         WHEN 4 THEN '2026-07-27T20:00:00.000Z'
         WHEN 5 THEN '2026-07-25T19:59:59.000Z'
         ELSE closed_at
       END`
    ).run();

    const visible = getVisiblePrs(db, 'owner/name', 3, '2026-07-29T20:00:00.000Z');
    expect(visible.map((r) => [r.pr_number, r.pr_state])).toEqual([
      [4, 'merged'],
      [3, 'closed'],
      [1, 'open'],
    ]);
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

  it('resetStuckReviews re-queues interrupted "reviewing" rows back to pending, not failed', () => {
    upsertOpenPr(db, basePr); // pending, never started — must be left alone
    upsertOpenPr(db, { ...basePr, prNumber: 2 });
    markReviewing(db, getByNumber(db, 'owner/name', 2)!.id); // mid-flight when "restart" happens

    const changed = resetStuckReviews(db);

    expect(changed).toBe(1);
    // Untouched: was never started, nothing to recover from.
    expect(getByNumber(db, 'owner/name', 1)!.review_status).toBe('pending');
    expect(getByNumber(db, 'owner/name', 1)!.error_message).toBeNull();
    // Re-queued (not fabricated as failed): will be retried on the next poll.
    expect(getByNumber(db, 'owner/name', 2)!.review_status).toBe('pending');
    expect(getByNumber(db, 'owner/name', 2)!.error_message).toBeNull();
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

  it('getPendingPrs returns only pending, open, non-draft rows for the given repo, oldest first', () => {
    upsertOpenPr(db, basePr); // pending
    upsertOpenPr(db, { ...basePr, prNumber: 2 });
    markReviewing(db, getByNumber(db, 'owner/name', 2)!.id); // not pending anymore
    upsertOpenPr(db, { ...basePr, prNumber: 3 }); // pending
    markClosedExcept(db, 'owner/name', [1, 2, 4, 5], { 3: 'merged' }); // closed/merged rows must not be re-queued
    upsertOpenPr(db, { ...basePr, prNumber: 4, isDraft: true }); // pending but a draft — never queued
    upsertOpenPr(db, { ...basePr, repo: 'other/repo', prNumber: 1 }); // different repo

    const pending = getPendingPrs(db, 'owner/name');

    expect(pending.map((r) => r.pr_number)).toEqual([1]);
  });

  it('deleteStaleClosedPrs deletes non-open rows at or older than the retention cutoff', () => {
    upsertOpenPr(db, basePr);
    upsertOpenPr(db, { ...basePr, prNumber: 2 });
    upsertOpenPr(db, { ...basePr, prNumber: 3 });
    upsertOpenPr(db, { ...basePr, prNumber: 4 });
    markClosedExcept(db, 'owner/name', [1], { 2: 'closed', 3: 'merged', 4: 'closed' });

    db.prepare(
      `UPDATE pull_requests
       SET closed_at = CASE pr_number
         WHEN 2 THEN '2026-07-26T20:00:00.000Z'
         WHEN 3 THEN '2026-07-29T08:00:00.000Z'
         WHEN 4 THEN '2026-07-26T19:59:59.000Z'
         ELSE closed_at
       END`
    ).run();

    const deleted = deleteStaleClosedPrs(db, 3, '2026-07-29T20:00:00.000Z');

    expect(deleted).toBe(2);
    expect(getByNumber(db, 'owner/name', 1)).toBeTruthy();
    expect(getByNumber(db, 'owner/name', 2)).toBeUndefined();
    expect(getByNumber(db, 'owner/name', 3)?.pr_state).toBe('merged');
    expect(getByNumber(db, 'owner/name', 4)).toBeUndefined();
  });
});
