import { describe, it, expect, beforeEach } from 'vitest';
import { isPollInProgress, withPollLock } from './queue';

describe('poll-tick mutex', () => {
  beforeEach(() => {
    // Reset the globalThis-keyed flag between tests.
    (globalThis as { __prDashboardPollInProgress?: boolean }).__prDashboardPollInProgress = undefined;
  });

  it('is not in progress initially', () => {
    expect(isPollInProgress()).toBe(false);
  });

  it('runs the callback and marks in-progress for its duration', async () => {
    let sawInProgress = false;
    await withPollLock(async () => {
      sawInProgress = isPollInProgress();
    });
    expect(sawInProgress).toBe(true);
    expect(isPollInProgress()).toBe(false); // released after completion
  });

  it('releases the lock even if the callback throws', async () => {
    await expect(
      withPollLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isPollInProgress()).toBe(false);
  });

  it('skips a second overlapping call while the first is still running', async () => {
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const firstCallPromise = withPollLock(async () => {
      await firstDone;
      return 'first-result';
    });

    // Second call happens while the first is still in-flight.
    const secondResult = await withPollLock(async () => 'second-result');
    expect(secondResult).toBe('skipped');

    resolveFirst();
    const firstResult = await firstCallPromise;
    expect(firstResult).toBe('first-result');
    expect(isPollInProgress()).toBe(false);
  });
});
