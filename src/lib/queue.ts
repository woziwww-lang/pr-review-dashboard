declare global {
  // eslint-disable-next-line no-var
  var __prDashboardPollInProgress: boolean | undefined;
}

export function isPollInProgress(): boolean {
  return globalThis.__prDashboardPollInProgress === true;
}

/**
 * Runs `fn` only if no other poll tick is currently in progress. Returns
 * `'skipped'` immediately (without calling `fn`) if one is. The lock is
 * always released — even if `fn` throws — so a crashed poll tick can
 * never permanently wedge future ticks.
 */
export async function withPollLock<T>(fn: () => Promise<T>): Promise<T | 'skipped'> {
  if (isPollInProgress()) return 'skipped';
  globalThis.__prDashboardPollInProgress = true;
  try {
    return await fn();
  } finally {
    globalThis.__prDashboardPollInProgress = false;
  }
}
