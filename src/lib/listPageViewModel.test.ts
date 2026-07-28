import { describe, it, expect } from 'vitest';
import { buildListRowViewModel, type ListPageRowInput } from './listPageViewModel';

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
