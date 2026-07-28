import type { PullRequestRow } from '../db/pullRequests';
import type { FindingRow } from '../db/findings';

export type DetailPageState = 'normal' | 'failed-with-prior-success' | 'failed-no-prior-success';

export interface FailureBanner {
  lastAttemptedAt: string | null;
  errorMessage: string | null;
  lastReviewedAt: string | null;
  reviewedHeadSha: string | null;
}

export interface DetailPageViewModel {
  state: DetailPageState;
  prNumber: number;
  title: string;
  verdict: string | null;
  severityCritical: number;
  severityHigh: number;
  severityMedium: number;
  severityLow: number;
  topRisks: FindingRow[];
  mediumLow: FindingRow[];
  rawReportMd: string | null;
  failureBanner: FailureBanner | null;
}

export function buildDetailPageViewModel(pr: PullRequestRow, findings: FindingRow[]): DetailPageViewModel {
  const isFailed = pr.review_status === 'failed';
  const hasPriorSuccess = pr.last_reviewed_at !== null;

  let state: DetailPageState = 'normal';
  if (isFailed) {
    state = hasPriorSuccess ? 'failed-with-prior-success' : 'failed-no-prior-success';
  }

  // In the no-prior-success failed state there's nothing meaningful to
  // show (findings/raw_report_md belong to the last *successful* review,
  // which doesn't exist yet), so the findings/report sections are
  // suppressed entirely per spec even though the DB columns are just
  // empty/null naturally in that case too.
  const showFindings = state !== 'failed-no-prior-success';

  return {
    state,
    prNumber: pr.pr_number,
    title: pr.title,
    verdict: pr.verdict,
    severityCritical: pr.severity_critical,
    severityHigh: pr.severity_high,
    severityMedium: pr.severity_medium,
    severityLow: pr.severity_low,
    topRisks: showFindings ? findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH') : [],
    mediumLow: showFindings ? findings.filter((f) => f.severity === 'MEDIUM' || f.severity === 'LOW') : [],
    rawReportMd: showFindings ? pr.raw_report_md : null,
    failureBanner: isFailed
      ? {
          lastAttemptedAt: pr.last_attempted_at,
          errorMessage: pr.error_message,
          lastReviewedAt: pr.last_reviewed_at,
          reviewedHeadSha: pr.reviewed_head_sha,
        }
      : null,
  };
}
