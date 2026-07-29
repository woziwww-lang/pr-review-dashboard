import { describe, it, expect } from 'vitest';
import { buildDetailPageViewModel } from './detailPageViewModel';
import type { PullRequestRow } from '../db/pullRequests';
import type { FindingRow } from '../db/findings';

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

function findingRow(overrides: Partial<FindingRow>): FindingRow {
  return {
    id: 1,
    pull_request_id: 1,
    file: 'src/a.ts',
    line: 10,
    severity: 'HIGH',
    summary: 'Missing null check',
    failureScenario: 'Crashes when input is null',
    evidence: 'a.ts:10',
    fixSuggestion: 'Add a null guard',
    codeSnippet: 'if (!x) return;',
    ...overrides,
  };
}

describe('buildDetailPageViewModel', () => {
  it('shows the normal state for a done review, splitting top risks from medium/low', () => {
    const vm = buildDetailPageViewModel(
      prRow({}),
      [findingRow({ severity: 'CRITICAL' }), findingRow({ severity: 'LOW', id: 2 })]
    );
    expect(vm.state).toBe('normal');
    expect(vm.topRisks).toHaveLength(1);
    expect(vm.mediumLow).toHaveLength(1);
  });

  it('shows the "failed with prior success" state and still renders prior findings', () => {
    const vm = buildDetailPageViewModel(
      prRow({
        review_status: 'failed',
        error_message: 'copilot timed out',
        last_attempted_at: '2026-07-28T01:00:00.000Z',
        last_reviewed_at: '2026-07-28T00:00:00.000Z',
        reviewed_head_sha: 'abc123',
      }),
      [findingRow({ severity: 'CRITICAL' })]
    );
    expect(vm.state).toBe('failed-with-prior-success');
    expect(vm.topRisks).toHaveLength(1);
    expect(vm.failureBanner).toMatchObject({
      lastAttemptedAt: '2026-07-28T01:00:00.000Z',
      errorMessage: 'copilot timed out',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
      reviewedHeadSha: 'abc123',
    });
  });

  it('shows the "failed with no prior success" state with no findings sections, even if stray findings rows exist', () => {
    const vm = buildDetailPageViewModel(
      prRow({
        review_status: 'failed',
        error_message: 'git fetch failed',
        last_attempted_at: '2026-07-28T01:00:00.000Z',
        last_reviewed_at: null,
        reviewed_head_sha: null,
        raw_report_md: '# stray leftover report',
      }),
      // Non-empty on purpose: this state must suppress findings/report
      // sections regardless of what's in the DB, not just because the
      // inputs happen to be empty.
      [findingRow({ severity: 'CRITICAL' }), findingRow({ severity: 'LOW', id: 2 })]
    );
    expect(vm.state).toBe('failed-no-prior-success');
    expect(vm.topRisks).toHaveLength(0);
    expect(vm.mediumLow).toHaveLength(0);
    expect(vm.rawReportMd).toBeNull();
  });
});
