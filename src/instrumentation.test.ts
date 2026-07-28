import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const registerNodeMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./instrumentation-node', () => ({ register: (...args: unknown[]) => registerNodeMock(...args) }));

describe('instrumentation register() runtime guard', () => {
  const originalRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    registerNodeMock.mockClear();
  });

  afterEach(() => {
    process.env.NEXT_RUNTIME = originalRuntime;
  });

  it('delegates to instrumentation-node when running in the nodejs runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    const { register } = await import('./instrumentation');

    await register();

    expect(registerNodeMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op in the edge runtime (never imports the Node-only module)', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    const { register } = await import('./instrumentation');

    await register();

    expect(registerNodeMock).not.toHaveBeenCalled();
  });
});
