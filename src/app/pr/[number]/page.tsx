import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { getDb } from '../../../db/client';
import { getConfig } from '../../../db/config';
import { getByNumber } from '../../../db/pullRequests';
import { getFindingsByPrId } from '../../../db/findings';
import { buildDetailPageViewModel } from '../../../lib/detailPageViewModel';
import { buildSeveritySummary } from '../../../lib/severitySummary';
import { PrStateBadge } from '../../components/PrStateBadge';
import { VerdictBadge } from '../../components/VerdictBadge';
import { FindingCard } from '../../components/FindingCard';
import { HoverLiftCard } from '../../components/HoverLiftCard';
import { RecheckButton } from '../../components/RecheckButton';
import { SeverityDonut } from '../../components/SeverityDonut';
import { TimeStamp } from '../../components/TimeStamp';
import { Card } from '../../components/ui/card';

export const dynamic = 'force-dynamic';

export default async function DetailPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const db = getDb();
  const repo = getConfig(db, 'target_repo') ?? '(not configured)';
  const prNumber = Number(number);
  const pr = getByNumber(db, repo, prNumber);
  if (!pr) {
    notFound();
  }

  const findings = getFindingsByPrId(db, pr.id);
  const vm = buildDetailPageViewModel(pr, findings);
  // Page-level presentational computation, not a DetailPageViewModel
  // field - `pr` (the raw PullRequestRow) is already in scope here from
  // getByNumber() above, so no view-model shape change is needed to
  // give RecheckButton the in-progress signal it needs to disable itself.
  const isInProgress = pr.pr_state === 'open' && (pr.review_status === 'pending' || pr.review_status === 'reviewing');
  const severitySummary = buildSeveritySummary([pr]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <Link href="/" className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to list
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold text-foreground">
          <span className="font-mono text-muted-foreground">#{vm.prNumber}</span> {vm.title}
        </h1>
        <div className="flex items-center gap-3">
          {vm.prState !== 'open' && <PrStateBadge state={vm.prState} />}
          {!vm.failureBanner && <TimeStamp iso={pr.last_reviewed_at} label="Last reviewed" />}
          {vm.prState === 'open' && <RecheckButton prNumber={vm.prNumber} disabled={isInProgress} />}
        </div>
      </div>

      {vm.failureBanner && vm.state === 'failed-with-prior-success' && (
        <Card
          role="alert"
          className="flex items-start gap-2 border-[#451A03] bg-[#FBBF24]/10 p-4 text-sm text-[#FBBF24]"
        >
          <TriangleAlert className="h-4 w-4 shrink-0 translate-y-0.5" />
          <span className="flex flex-col gap-1.5">
            <span>
              Latest re-check failed: {vm.failureBanner.errorMessage}. Showing results from the last successful
              review (commit {vm.failureBanner.reviewedHeadSha}).
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <TimeStamp iso={vm.failureBanner.lastAttemptedAt} label="Failed at" />
              <TimeStamp iso={vm.failureBanner.lastReviewedAt} label="Last success" />
            </span>
          </span>
        </Card>
      )}

      {vm.failureBanner && vm.state === 'failed-no-prior-success' && (
        <Card
          role="alert"
          className="flex items-start gap-2 border-[#450A0A] bg-[#F87171]/10 p-4 text-sm text-[#F87171]"
        >
          <TriangleAlert className="h-4 w-4 shrink-0 translate-y-0.5" />
          <span className="flex flex-col gap-1.5">
            <span>Review failed: {vm.failureBanner.errorMessage}. No successful review yet.</span>
            <TimeStamp iso={vm.failureBanner.lastAttemptedAt} label="Failed at" />
          </span>
        </Card>
      )}

      {vm.state !== 'failed-no-prior-success' && (
        <>
          {pr.last_reviewed_at !== null && (
            <div className="flex justify-center">
              <SeverityDonut summary={severitySummary} />
            </div>
          )}

          <HoverLiftCard>
            <Card className="flex flex-col gap-2 card-glass p-4">
              <h2 className="text-sm font-medium text-muted-foreground">Executive Summary</h2>
              {/* Note: DetailPageViewModel has no separate free-text
                  "summary" field (verified against src/lib/detailPageViewModel.ts)
                  - the verdict badge + severity counts below *are* the
                  executive summary. No view-model change is made to
                  introduce a summary-text field, per the spec's Non-Goals. */}
              {vm.verdict && <VerdictBadge verdict={vm.verdict as 'approve' | 'needs_fix' | 'needs_review'} />}
              <p className="text-sm text-muted-foreground">
                Critical: {vm.severityCritical}, High: {vm.severityHigh}, Medium: {vm.severityMedium}, Low:{' '}
                {vm.severityLow}
              </p>
            </Card>
          </HoverLiftCard>

          <HoverLiftCard>
            <Card className="flex flex-col gap-2 card-glass p-4">
              <h2 className="text-sm font-medium text-muted-foreground">Top Risks</h2>
              {vm.topRisks.map((f) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </Card>
          </HoverLiftCard>

          <HoverLiftCard>
            <Card className="flex flex-col gap-2 card-glass p-4 opacity-80">
              <h2 className="text-sm font-medium text-muted-foreground">Medium/Low</h2>
              {vm.mediumLow.map((f) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </Card>
          </HoverLiftCard>

          {vm.rawReportMd && (
            <details className="card-glass p-4">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground">Raw report</summary>
              <pre className="mt-2 overflow-x-auto text-xs">{vm.rawReportMd}</pre>
            </details>
          )}
        </>
      )}
    </main>
  );
}
