import { notFound } from 'next/navigation';
import { getDb } from '../../../db/client';
import { getConfig } from '../../../db/config';
import { getByNumber } from '../../../db/pullRequests';
import { getFindingsByPrId } from '../../../db/findings';
import { buildDetailPageViewModel } from '../../../lib/detailPageViewModel';
import { VerdictBadge } from '../../components/VerdictBadge';
import { FindingCard } from '../../components/FindingCard';

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

  return (
    <main>
      <h1>
        #{vm.prNumber} {vm.title}
      </h1>
      <form action={`/api/recheck/${vm.prNumber}`} method="post">
        <button type="submit">Re-check now</button>
      </form>

      {vm.failureBanner && vm.state === 'failed-with-prior-success' && (
        <div role="alert">
          ⚠ Latest re-check failed at {vm.failureBanner.lastAttemptedAt}: {vm.failureBanner.errorMessage}. Showing
          results from the last successful review ({vm.failureBanner.lastReviewedAt}, commit{' '}
          {vm.failureBanner.reviewedHeadSha}).
        </div>
      )}

      {vm.failureBanner && vm.state === 'failed-no-prior-success' && (
        <div role="alert">
          Review failed at {vm.failureBanner.lastAttemptedAt}: {vm.failureBanner.errorMessage}. No successful review
          yet.
        </div>
      )}

      {vm.state !== 'failed-no-prior-success' && (
        <>
          <section>
            <h2>Executive Summary</h2>
            {vm.verdict && <VerdictBadge verdict={vm.verdict as 'approve' | 'needs_fix' | 'needs_review'} />}
            <p>
              Critical: {vm.severityCritical}, High: {vm.severityHigh}, Medium: {vm.severityMedium}, Low:{' '}
              {vm.severityLow}
            </p>
          </section>

          <section>
            <h2>Top Risks</h2>
            {vm.topRisks.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </section>

          <section>
            <h2>Medium/Low</h2>
            <ul>
              {vm.mediumLow.map((f) => (
                <li key={f.id}>
                  {f.severity}: {f.summary} ({f.file}:{f.line})
                </li>
              ))}
            </ul>
          </section>

          {vm.rawReportMd && (
            <details>
              <summary>Raw report</summary>
              <pre>{vm.rawReportMd}</pre>
            </details>
          )}
        </>
      )}
    </main>
  );
}
