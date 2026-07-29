import { describe, it, expect } from 'vitest';
import { buildListRowViewModel, buildListPageViewModel, type ListPageRowInput } from './listPageViewModel';
import type { PullRequestRow } from '../db/pullRequests';

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
    closed_at: null,
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
