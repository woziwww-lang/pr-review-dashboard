import cron from 'node-cron';
import { getDb } from './db/client';
import { setConfig } from './db/config';
import { resetStuckReviews } from './db/pullRequests';
import { parseTargetRepo } from './lib/startupConfig';
import { withPollLock } from './lib/queue';
import { runPollTick } from './lib/poller';

declare global {
  var __prDashboardCronRegistered: boolean | undefined;
}

export async function register(): Promise<void> {
  // Next.js can call register() more than once per process (e.g. across
  // dev-mode hot reloads); a plain module-level flag would be reset by a
  // module reload, so this must be keyed off globalThis to survive it.
  if (globalThis.__prDashboardCronRegistered) return;
  globalThis.__prDashboardCronRegistered = true;

  const result = parseTargetRepo(process.env.TARGET_REPO);
  if (!result.ok) {
    console.error(`FATAL: ${result.error}`);
    process.exit(1);
    return;
  }
  const repo = result.repo as string;

  const db = getDb();
  setConfig(db, 'target_repo', repo);
  // Any row left pending/reviewing from a previous process would
  // otherwise be permanently stuck against the single-flight rule.
  resetStuckReviews(db);

  cron.schedule('*/5 * * * *', () => {
    void withPollLock(() => runPollTick(db, repo)).catch((err) => {
      console.error('Scheduled poll tick failed:', err);
    });
  });

  // Also poll immediately on startup, rather than waiting a full 5
  // minutes for the first result after the app comes up. This is
  // intentionally NOT awaited: Next.js does not begin serving HTTP
  // requests until register() resolves, and a startup poll can run a
  // full code review per pending PR (spawning `copilot`, up to
  // REVIEW_TIMEOUT_MS each) - awaiting it here would make the entire
  // dashboard unresponsive for minutes after every restart whenever a
  // PR is left pending. Firing it in the background lets the server
  // start accepting requests immediately while the poll/review runs.
  void withPollLock(() => runPollTick(db, repo)).catch((err) => {
    console.error('Startup poll tick failed:', err);
  });
}
