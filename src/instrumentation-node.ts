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
    void withPollLock(() => runPollTick(db, repo));
  });

  // Also poll immediately on startup, rather than waiting a full 5
  // minutes for the first result after the app comes up.
  await withPollLock(() => runPollTick(db, repo));
}
