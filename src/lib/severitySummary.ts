import type { PullRequestRow } from '../db/pullRequests';

export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
  reviewedCount: number;
}

export function buildSeveritySummary(rows: PullRequestRow[]): SeveritySummary {
  const reviewed = rows.filter((row) => row.last_reviewed_at !== null);

  const summary = reviewed.reduce(
    (acc, row) => ({
      critical: acc.critical + row.severity_critical,
      high: acc.high + row.severity_high,
      medium: acc.medium + row.severity_medium,
      low: acc.low + row.severity_low,
    }),
    { critical: 0, high: 0, medium: 0, low: 0 }
  );

  return {
    ...summary,
    total: summary.critical + summary.high + summary.medium + summary.low,
    reviewedCount: reviewed.length,
  };
}
