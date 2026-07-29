// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { PullRequestRow } from '../db/pullRequests';

const getDbMock = vi.fn();
const getConfigMock = vi.fn();
const getVisiblePrsMock = vi.fn();
const buildSeveritySummaryMock = vi.fn();

vi.mock('../db/client', () => ({
  getDb: (...args: unknown[]) => getDbMock(...args),
}));

vi.mock('../db/config', () => ({
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));

vi.mock('../db/pullRequests', () => ({
  getVisiblePrs: (...args: unknown[]) => getVisiblePrsMock(...args),
}));

vi.mock('../lib/severitySummary', () => ({
  buildSeveritySummary: (...args: unknown[]) => buildSeveritySummaryMock(...args),
}));

vi.mock('next/link', () => ({
  default: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('./components/VerdictBadge', () => ({
  VerdictBadge: ({ verdict }: { verdict: string }) => <span data-testid={`verdict-${verdict}`}>Verdict:{verdict}</span>,
}));

vi.mock('./components/PrStateBadge', () => ({
  PrStateBadge: ({ state }: { state: string }) => <span data-testid={`state-${state}`}>State:{state}</span>,
}));

vi.mock('./components/PollStatusBanner', () => ({
  PollStatusBanner: () => <div data-testid="poll-status-banner" />,
}));

vi.mock('./components/RecheckButton', () => ({
  RecheckButton: ({ prNumber, disabled }: { prNumber: number; disabled: boolean }) => (
    <button disabled={disabled}>{`Recheck ${prNumber}`}</button>
  ),
}));

vi.mock('./components/SeveritySummaryBar', () => ({
  SeveritySummaryBar: ({ summary }: { summary: unknown }) => (
    <div data-testid="severity-summary">{JSON.stringify(summary)}</div>
  ),
}));

vi.mock('./components/HoverLiftCard', () => ({
  HoverLiftCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('./components/StaggerReveal', () => ({
  StaggerReveal: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
}));

vi.mock('./components/TimeStamp', () => ({
  TimeStamp: ({ iso, label }: { iso: string | null; label: string }) => <span>{`${label}:${iso ?? 'none'}`}</span>,
}));

vi.mock('./components/ui/card', () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>
      {children}
    </div>
  ),
}));

import ListPage from './page';

function makeRow(overrides: Partial<PullRequestRow>): PullRequestRow {
  return {
    id: 1,
    repo: 'org/repo',
    pr_number: 1,
    title: 'PR title',
    author: 'author',
    branch: 'branch',
    base_branch: 'main',
    head_sha: 'abc123',
    pr_url: 'https://example.com/pr/1',
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

function getCard(title: string): HTMLElement {
  const card = screen.getByText(title).closest('[data-testid="card"]');
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

describe('ListPage', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    getConfigMock.mockReset();
    getVisiblePrsMock.mockReset();
    buildSeveritySummaryMock.mockReset();

    getDbMock.mockReturnValue({});
    getConfigMock.mockImplementation((_db: unknown, key: string) => {
      if (key === 'target_repo') return 'org/repo';
      return null;
    });
    buildSeveritySummaryMock.mockReturnValue({ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 0 });
  });

  it('passes only open PRs into buildSeveritySummary', () => {
    const openRow = makeRow({ id: 1, pr_number: 101, title: 'Open PR', pr_state: 'open' });
    const mergedRow = makeRow({ id: 2, pr_number: 102, title: 'Merged PR', pr_state: 'merged', closed_at: '2026-07-29T10:00:00.000Z' });
    const closedRow = makeRow({ id: 3, pr_number: 103, title: 'Closed PR', pr_state: 'closed', closed_at: '2026-07-29T11:00:00.000Z' });
    getVisiblePrsMock.mockReturnValue([openRow, mergedRow, closedRow]);

    render(<ListPage />);

    expect(buildSeveritySummaryMock).toHaveBeenCalledWith([openRow]);
  });

  it('shows state badges alongside verdicts and hides recheck buttons for merged and closed PRs', () => {
    const openRow = makeRow({ id: 1, pr_number: 101, title: 'Open PR', pr_state: 'open', verdict: 'approve' });
    const mergedRow = makeRow({ id: 2, pr_number: 102, title: 'Merged PR', pr_state: 'merged', verdict: 'needs_fix', closed_at: '2026-07-29T10:00:00.000Z' });
    const closedRow = makeRow({ id: 3, pr_number: 103, title: 'Closed PR', pr_state: 'closed', verdict: 'needs_review', closed_at: '2026-07-29T11:00:00.000Z' });
    getVisiblePrsMock.mockReturnValue([openRow, mergedRow, closedRow]);

    render(<ListPage />);

    const openCard = getCard('Open PR');
    const mergedCard = getCard('Merged PR');
    const closedCard = getCard('Closed PR');

    expect(within(openCard).queryByTestId('state-open')).not.toBeInTheDocument();
    expect(within(openCard).getByTestId('verdict-approve')).toBeInTheDocument();
    expect(within(openCard).getByRole('button', { name: 'Recheck 101' })).toBeInTheDocument();

    expect(within(mergedCard).getByTestId('state-merged')).toBeInTheDocument();
    expect(within(mergedCard).getByTestId('verdict-needs_fix')).toBeInTheDocument();
    expect(within(mergedCard).queryByRole('button', { name: 'Recheck 102' })).not.toBeInTheDocument();
    expect(mergedCard).toHaveClass('opacity-60');

    expect(within(closedCard).getByTestId('state-closed')).toBeInTheDocument();
    expect(within(closedCard).getByTestId('verdict-needs_review')).toBeInTheDocument();
    expect(within(closedCard).queryByRole('button', { name: 'Recheck 103' })).not.toBeInTheDocument();
    expect(closedCard).toHaveClass('opacity-60');
  });
});
