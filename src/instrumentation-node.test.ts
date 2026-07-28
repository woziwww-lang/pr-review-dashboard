import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scheduleMock = vi.fn();
vi.mock('node-cron', () => ({ default: { schedule: (...args: unknown[]) => scheduleMock(...args) } }));

const dbStub = { __fake: 'db' };
const getDbMock = vi.fn(() => dbStub);
vi.mock('./db/client', () => ({ getDb: (...args: unknown[]) => getDbMock(...args) }));

const setConfigMock = vi.fn();
vi.mock('./db/config', () => ({ setConfig: (...args: unknown[]) => setConfigMock(...args) }));

const resetStuckReviewsMock = vi.fn();
vi.mock('./db/pullRequests', () => ({
  resetStuckReviews: (...args: unknown[]) => resetStuckReviewsMock(...args),
}));

const withPollLockMock = vi.fn((fn: () => unknown) => fn());
vi.mock('./lib/queue', () => ({ withPollLock: (...args: unknown[]) => withPollLockMock(...args) }));

const runPollTickMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./lib/poller', () => ({ runPollTick: (...args: unknown[]) => runPollTickMock(...args) }));

describe('instrumentation register()', () => {
  const originalEnv = process.env.TARGET_REPO;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    scheduleMock.mockClear();
    getDbMock.mockClear();
    setConfigMock.mockClear();
    resetStuckReviewsMock.mockClear();
    withPollLockMock.mockClear();
    runPollTickMock.mockClear();
    (globalThis as { __prDashboardCronRegistered?: boolean }).__prDashboardCronRegistered = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);
  });

  afterEach(() => {
    process.env.TARGET_REPO = originalEnv;
    exitSpy.mockRestore();
  });

  it('validates TARGET_REPO, resets stuck reviews, schedules cron, and polls once immediately', async () => {
    process.env.TARGET_REPO = 'owner/name';
    const { register } = await import('./instrumentation-node');

    await register();

    expect(setConfigMock).toHaveBeenCalledWith(dbStub, 'target_repo', 'owner/name');
    expect(resetStuckReviewsMock).toHaveBeenCalledWith(dbStub);
    expect(scheduleMock).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function));
    expect(withPollLockMock).toHaveBeenCalledTimes(1); // immediate startup poll
    expect(runPollTickMock).toHaveBeenCalledWith(dbStub, 'owner/name');
  });

  it('is a no-op on a second call in the same process (dev hot-reload guard)', async () => {
    process.env.TARGET_REPO = 'owner/name';
    const { register } = await import('./instrumentation-node');

    await register();
    await register();

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(withPollLockMock).toHaveBeenCalledTimes(1);
  });

  it('logs a fatal error and exits when TARGET_REPO is missing', async () => {
    delete process.env.TARGET_REPO;
    const { register } = await import('./instrumentation-node');

    await expect(register()).rejects.toThrow('process.exit(1) called');

    expect(scheduleMock).not.toHaveBeenCalled();
  });
});
