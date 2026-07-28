import type { BadgeVerdict } from '../app/components/VerdictBadge';

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
