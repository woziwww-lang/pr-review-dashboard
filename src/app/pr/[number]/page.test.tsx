// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { PullRequestRow } from '../../../db/pullRequests';

const getDbMock = vi.fn();
const getConfigMock = vi.fn();
const getByNumberMock = vi.fn();
const getFindingsByPrIdMock = vi.fn();
const buildSeveritySummaryMock = vi.fn();
const notFoundMock = vi.fn();

vi.mock('../../../db/client', () => ({
  getDb: (...args: unknown[]) => getDbMock(...args),
}));

vi.mock('../../../db/config', () => ({
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));

vi.mock('../../../db/pullRequests', () => ({
  getByNumber: (...args: unknown[]) => getByNumberMock(...args),
}));

vi.mock('../../../db/findings', () => ({
  getFindingsByPrId: (...args: unknown[]) => getFindingsByPrIdMock(...args),
}));

vi.mock('../../../lib/severitySummary', () => ({
  buildSeveritySummary: (...args: unknown[]) => buildSeveritySummaryMock(...args),
}));

vi.mock('next/link', () => ({
  default: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  notFound: () => notFoundMock(),
}));

vi.mock('../../components/PrStateBadge', () => ({
  PrStateBadge: ({ state }: { state: string }) => <span data-testid={`state-${state}`}>State:{state}</span>,
}));

vi.mock('../../components/VerdictBadge', () => ({
  VerdictBadge: ({ verdict }: { verdict: string }) => <span>{`Verdict:${verdict}`}</span>,
}));

vi.mock('../../components/FindingCard', () => ({
  FindingCard: ({ finding }: { finding: { id: number } }) => <div>{`Finding:${finding.id}`}</div>,
}));

vi.mock('../../components/HoverLiftCard', () => ({
  HoverLiftCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../components/RecheckButton', () => ({
  RecheckButton: ({ prNumber, disabled }: { prNumber: number; disabled: boolean }) => (
    <button disabled={disabled}>{`Recheck ${prNumber}`}</button>
  ),
}));

vi.mock('../../components/SeverityDonut', () => ({
  SeverityDonut: ({ summary }: { summary: unknown }) => <div data-testid="severity-donut">{JSON.stringify(summary)}</div>,
}));

vi.mock('../../components/TimeStamp', () => ({
  TimeStamp: ({ iso, label }: { iso: string | null; label: string }) => <span>{`${label}:${iso ?? 'none'}`}</span>,
}));

vi.mock('../../components/ui/card', () => ({
  Card: ({ children, className, role }: { children: React.ReactNode; className?: string; role?: string }) => (
    <div className={className} role={role}>
      {children}
    </div>
  ),
}));

import DetailPage from './page';

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

async function renderPage(pr: PullRequestRow) {
  getByNumberMock.mockReturnValue(pr);
  const ui = await DetailPage({ params: Promise.resolve({ number: String(pr.pr_number) }) });
  return render(ui);
}

describe('DetailPage', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    getConfigMock.mockReset();
    getByNumberMock.mockReset();
    getFindingsByPrIdMock.mockReset();
    buildSeveritySummaryMock.mockReset();
    notFoundMock.mockReset();

    getDbMock.mockReturnValue({});
    getConfigMock.mockReturnValue('owner/name');
    getFindingsByPrIdMock.mockReturnValue([]);
    buildSeveritySummaryMock.mockReturnValue({ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 1 });
  });

  it('shows the recheck button for an open PR and disables it while the review is pending', async () => {
    await renderPage(prRow({ pr_state: 'open', review_status: 'pending' }));

    expect(screen.queryByTestId('state-open')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recheck 42' })).toBeDisabled();
  });

  it('shows the merged badge in the header action row and hides the recheck button for a merged PR', async () => {
    await renderPage(prRow({ pr_state: 'merged', review_status: 'pending', closed_at: '2026-07-29T10:00:00.000Z' }));

    const badge = screen.getByTestId('state-merged');
    expect(screen.queryByRole('button', { name: 'Recheck 42' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: /add feature/i })).queryByTestId('state-merged')).not.toBeInTheDocument();
    expect(badge.parentElement).not.toBeNull();
    expect(within(badge.parentElement as HTMLElement).getByText('Last reviewed:2026-07-28T00:00:00.000Z')).toBeInTheDocument();
  });

  it('shows the closed badge and hides the recheck button for a closed PR', async () => {
    await renderPage(prRow({ pr_state: 'closed', review_status: 'reviewing', closed_at: '2026-07-29T11:00:00.000Z' }));

    expect(screen.getByTestId('state-closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recheck 42' })).not.toBeInTheDocument();
  });
});
