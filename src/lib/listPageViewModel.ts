import type { BadgeVerdict } from '../app/components/VerdictBadge';
import type { PullRequestRow } from '../db/pullRequests';

export interface ListPageRowInput {
  prNumber: number;
  title: string;
  branch: string;
  author: string;
  reviewStatus: 'pending' | 'reviewing' | 'done' | 'failed';
  verdict: string | null;
  severityCritical: number;
  severityHigh: number;
  lastReviewedAt: string | null;
}

export interface ListPageRowViewModel {
  prNumber: number;
  title: string;
  branch: string;
  author: string;
  isInProgress: boolean;
  badgeVerdict: BadgeVerdict;
  criticalHighCount: number | null;
  lastReviewedAt: string | null;
}

export function buildListRowViewModel(input: ListPageRowInput): ListPageRowViewModel {
  const isInProgress = input.reviewStatus === 'reviewing' || input.reviewStatus === 'pending';
  const isFailed = input.reviewStatus === 'failed';

  const hasPriorSuccess = input.lastReviewedAt !== null;
  // severityCritical/severityHigh always hold the counts from the last
  // *successful* review (markFailed never touches them - see Chunk 1's
  // pullRequests.ts) so they're safe to show whenever a prior success
  // exists, even if the row's current status is 'failed'.
  const criticalHighCount = isFailed && !hasPriorSuccess ? null : input.severityCritical + input.severityHigh;

  return {
    prNumber: input.prNumber,
    title: input.title,
    branch: input.branch,
    author: input.author,
    isInProgress,
    badgeVerdict: isFailed ? 'failed' : ((input.verdict ?? 'needs_review') as BadgeVerdict),
    criticalHighCount,
    lastReviewedAt: input.lastReviewedAt,
  };
}

export interface ListPageViewModelInput {
  repo: string;
  lastPollAt: string | null;
  lastPollStatus: 'ok' | 'error' | null;
  lastPollError: string | null;
  prs: PullRequestRow[];
}

export interface ListPageViewModel {
  repo: string;
  lastPollAt: string | null;
  pollStatus: 'ok' | 'error' | null;
  pollError: string | null;
  rows: ListPageRowViewModel[];
}

export function buildListPageViewModel(input: ListPageViewModelInput): ListPageViewModel {
  return {
    repo: input.repo,
    lastPollAt: input.lastPollAt,
    pollStatus: input.lastPollStatus,
    // An empty string means "no error recorded" (see poller.ts's success
    // path, which calls setConfig(db, 'last_poll_error', '')) - normalize
    // that to null so the banner and this view model share one "no error"
    // representation.
    pollError: input.lastPollError || null,
    rows: input.prs
      .map((pr) =>
        buildListRowViewModel({
          prNumber: pr.pr_number,
          title: pr.title,
          branch: pr.branch,
          author: pr.author,
          reviewStatus: pr.review_status,
          verdict: pr.verdict,
          severityCritical: pr.severity_critical,
          severityHigh: pr.severity_high,
          lastReviewedAt: pr.last_reviewed_at,
        })
      )
      // `getOpenPrs()` (db/pullRequests.ts) already queries with
      // `ORDER BY pr_number DESC`, but this view model re-sorts
      // defensively rather than trusting caller ordering, since it's a
      // pure function that may be called with data from other sources
      // (e.g. tests, future callers).
      .sort((a, b) => b.prNumber - a.prNumber),
  };
}
