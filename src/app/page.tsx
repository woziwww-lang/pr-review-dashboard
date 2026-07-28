import Link from 'next/link';
import { getDb } from '../db/client';
import { getConfig } from '../db/config';
import { getOpenPrs } from '../db/pullRequests';
import { buildListPageViewModel } from '../lib/listPageViewModel';
import { VerdictBadge } from './components/VerdictBadge';
import { PollStatusBanner } from './components/PollStatusBanner';

export const dynamic = 'force-dynamic';

export default function ListPage() {
  const db = getDb();
  const repo = getConfig(db, 'target_repo') ?? '(not configured)';
  const vm = buildListPageViewModel({
    repo,
    lastPollAt: getConfig(db, 'last_poll_at') ?? null,
    lastPollStatus: (getConfig(db, 'last_poll_status') as 'ok' | 'error' | undefined) ?? null,
    lastPollError: getConfig(db, 'last_poll_error') ?? null,
    prs: getOpenPrs(db, repo),
  });

  return (
    <main>
      <h1>{vm.repo}</h1>
      <PollStatusBanner lastPollAt={vm.lastPollAt} lastPollStatus={vm.pollStatus} lastPollError={vm.pollError} />
      <table>
        <thead>
          <tr>
            <th>PR</th>
            <th>Title</th>
            <th>Branch</th>
            <th>Author</th>
            <th>Verdict</th>
            <th>Critical+High</th>
            <th>Last reviewed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {vm.rows.map((row) => (
            // Server Components can't attach an onClick handler to the
            // <tr> itself (that would require a Client Component), so
            // "clicking a row navigates" is satisfied instead by making
            // every data cell in the row a full-cell <Link> (styled to
            // `display: block` so the whole cell area, not just the
            // text, is clickable) - only the "Re-check now" form/button
            // cell is excluded, since it must submit a POST rather than
            // navigate.
            <tr key={row.prNumber}>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  #{row.prNumber}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.title}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.branch}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.author}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.isInProgress ? 'Reviewing…' : <VerdictBadge verdict={row.badgeVerdict} />}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.criticalHighCount ?? '-'}
                </Link>
              </td>
              <td>
                <Link href={`/pr/${row.prNumber}`} style={{ display: 'block' }}>
                  {row.lastReviewedAt ?? '-'}
                </Link>
              </td>
              <td>
                <form action={`/api/recheck/${row.prNumber}`} method="post">
                  <button type="submit">Re-check now</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
