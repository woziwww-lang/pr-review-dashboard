import { describe, it, expect } from 'vitest';
import { buildSeveritySummary } from './severitySummary';
import type { PullRequestRow } from '../db/pullRequests';

function makeRow(overrides: Partial<PullRequestRow>): PullRequestRow {
  return {
    id: 1,
    repo: 'org/repo',
    pr_number: 1,
    title: 'title',
    author: 'author',
    branch: 'branch',
    base_branch: 'main',
    head_sha: 'abc123',
    pr_url: 'https://example.com',
    is_draft: 0,
    pr_state: 'open',
    review_status: 'done',
    verdict: 'approve',
    severity_critical: 0,
    severity_high: 0,
    severity_medium: 0,
    severity_low: 0,
    reviewed_head_sha: 'abc123',
    last_reviewed_at: '2026-07-29T00:00:00.000Z',
    last_attempted_at: '2026-07-29T00:00:00.000Z',
    raw_report_md: null,
    error_message: null,
    closed_at: null,
    ...overrides,
  };
}

describe('buildSeveritySummary', () => {
  it('returns all-zero, reviewedCount 0 for an empty array', () => {
    const result = buildSeveritySummary([]);
    expect(result).toEqual({ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 0 });
  });

  it('sums severity counts across a single reviewed row', () => {
    const result = buildSeveritySummary([
      makeRow({ severity_critical: 2, severity_high: 1, severity_medium: 3, severity_low: 4 }),
    ]);
    expect(result).toEqual({ critical: 2, high: 1, medium: 3, low: 4, total: 10, reviewedCount: 1 });
  });

  it('sums severity counts across multiple reviewed rows', () => {
    const result = buildSeveritySummary([
      makeRow({ severity_critical: 1, severity_high: 0, severity_medium: 0, severity_low: 0 }),
      makeRow({ severity_critical: 1, severity_high: 2, severity_medium: 0, severity_low: 0 }),
    ]);
    expect(result).toEqual({ critical: 2, high: 2, medium: 0, low: 0, total: 4, reviewedCount: 2 });
  });

  it('excludes a row with last_reviewed_at: null from both the sums and reviewedCount', () => {
    const result = buildSeveritySummary([
      makeRow({ last_reviewed_at: null, severity_critical: 9, severity_high: 9, severity_medium: 9, severity_low: 9 }),
      makeRow({ severity_critical: 1, severity_high: 0, severity_medium: 0, severity_low: 0 }),
    ]);
    expect(result).toEqual({ critical: 1, high: 0, medium: 0, low: 0, total: 1, reviewedCount: 1 });
  });

  it('reports reviewedCount 0 when no row has ever completed a review ("no reviewed data yet")', () => {
    const result = buildSeveritySummary([makeRow({ last_reviewed_at: null })]);
    expect(result.reviewedCount).toBe(0);
    expect(result.total).toBe(0);
  });

  it('reports reviewedCount > 0 with total 0 when reviewed rows have zero findings ("reviewed, and clean")', () => {
    const result = buildSeveritySummary([makeRow({})]);
    expect(result.reviewedCount).toBe(1);
    expect(result.total).toBe(0);
  });
});
