import Link from 'next/link';
import { getDb } from '../db/client';
import { getConfig } from '../db/config';
import { getOpenPrs } from '../db/pullRequests';
import { buildListPageViewModel } from '../lib/listPageViewModel';
import { buildSeveritySummary } from '../lib/severitySummary';
import { VerdictBadge } from './components/VerdictBadge';
import { PollStatusBanner } from './components/PollStatusBanner';
import { RecheckButton } from './components/RecheckButton';
import { SeveritySummaryBar } from './components/SeveritySummaryBar';
import { HoverLiftCard } from './components/HoverLiftCard';
import { StaggerReveal } from './components/StaggerReveal';
import { TimeStamp } from './components/TimeStamp';
import { Card } from './components/ui/card';

export const dynamic = 'force-dynamic';

export default function ListPage() {
  const db = getDb();
  const repo = getConfig(db, 'target_repo') ?? '(not configured)';
  const openPrs = getOpenPrs(db, repo);
  const vm = buildListPageViewModel({
    repo,
    lastPollAt: getConfig(db, 'last_poll_at') ?? null,
    lastPollStatus: (getConfig(db, 'last_poll_status') as 'ok' | 'error' | undefined) ?? null,
    lastPollError: getConfig(db, 'last_poll_error') ?? null,
    prs: openPrs,
  });
  const severitySummary = buildSeveritySummary(openPrs);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{vm.repo}</h1>
        <div className="mt-3">
          <PollStatusBanner lastPollAt={vm.lastPollAt} lastPollStatus={vm.pollStatus} lastPollError={vm.pollError} />
        </div>
        <SeveritySummaryBar summary={severitySummary} />
      </div>

      <StaggerReveal className="flex flex-col gap-2.5">
        {vm.rows.map((row) => (
          <HoverLiftCard key={row.prNumber}>
            <Card
              className={`relative flex flex-col items-stretch gap-3 card-glass p-4 transition-colors duration-200 ease-out hover:border-primary/40 sm:flex-row sm:items-center sm:justify-between ${
                row.isInProgress ? 'opacity-70' : ''
              }`}
            >
              {/* Full-card clickable overlay: an absolutely-positioned
                  <Link> stretched to cover the entire card (inset-0).
                  This is a real, keyboard-focusable, tabbable link (no
                  `tabIndex={-1}` - removing it from tab order would make
                  the card unreachable by keyboard) with an sr-only label
                  for screen readers. The visible content wrapper below it
                  has `pointer-events-none` so mouse clicks/taps pass
                  *through* the content (title, branch, author, verdict,
                  severity count, and the gaps between them) straight to
                  this overlay underneath - the content is still visually
                  on top (z-[1] > z-0) and fully legible/selectable-looking,
                  it just doesn't intercept clicks itself. RecheckButton is
                  wrapped in its own `relative z-10 pointer-events-auto`
                  container so it re-enables pointer events and sits above
                  everything, remaining independently clickable - an
                  interactive <button> nested inside an <a> would be
                  invalid HTML/inaccessible, so this overlay approach keeps
                  them as non-nested siblings while still covering the
                  full card for every other click target. */}
              <Link
                href={`/pr/${row.prNumber}`}
                className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <span className="sr-only">
                  View PR #{row.prNumber}: {row.title}
                </span>
              </Link>

              <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-muted-foreground">#{row.prNumber}</span>
                    <span className="font-medium text-foreground">{row.title}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{row.branch}</span>
                    <span>{row.author}</span>
                    <TimeStamp iso={row.lastReviewedAt} label="Last reviewed" />
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {row.isInProgress ? (
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                      Reviewing…
                    </span>
                  ) : (
                    <VerdictBadge verdict={row.badgeVerdict} />
                  )}
                  {/* Severity count reflects the last *successful* review
                      (per listPageViewModel's comment on criticalHighCount)
                      and stays visible even mid-recheck, since it's still
                      meaningful reference data while a new review runs.
                      Falls back to '-' (matching the original table cell's
                      behavior) rather than disappearing when null. */}
                  <span className="text-sm text-muted-foreground">Crit+High: {row.criticalHighCount ?? '-'}</span>
                </div>
              </div>

              <div className="relative z-10 pointer-events-auto">
                <RecheckButton prNumber={row.prNumber} disabled={row.isInProgress} />
              </div>
            </Card>
          </HoverLiftCard>
        ))}
      </StaggerReveal>
    </main>
  );
}
