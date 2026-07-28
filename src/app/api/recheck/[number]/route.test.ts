import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDbMock = vi.fn();
vi.mock('../../../../db/client', () => ({ getDb: () => getDbMock() }));

const getConfigMock = vi.fn();
vi.mock('../../../../db/config', () => ({ getConfig: (...args: unknown[]) => getConfigMock(...args) }));

const forceRecheckMock = vi.fn();
vi.mock('../../../../lib/recheck', () => ({ forceRecheck: (...args: unknown[]) => forceRecheckMock(...args) }));

const { POST } = await import('./route');

describe('POST /api/recheck/[number]', () => {
  const dbStub = {};

  beforeEach(() => {
    getDbMock.mockReturnValue(dbStub);
    getConfigMock.mockReset();
    forceRecheckMock.mockReset();
  });

  it('returns 500 when target_repo is not configured', async () => {
    getConfigMock.mockReturnValue(undefined);
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), {
      params: Promise.resolve({ number: '1' }),
    });
    expect(res.status).toBe(500);
  });

  it('returns 400 for a non-numeric PR number', async () => {
    getConfigMock.mockReturnValue('owner/name');
    const res = await POST(new Request('http://localhost/api/recheck/abc', { method: 'POST' }), {
      params: Promise.resolve({ number: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 202 when forceRecheck starts a review', async () => {
    getConfigMock.mockReturnValue('owner/name');
    forceRecheckMock.mockResolvedValue({ status: 'started' });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), {
      params: Promise.resolve({ number: '1' }),
    });
    expect(res.status).toBe(202);
    expect(forceRecheckMock).toHaveBeenCalledWith(dbStub, 'owner/name', 1);
  });

  it('returns 202 with a queued message when a scheduled poll tick is already running', async () => {
    getConfigMock.mockReturnValue('owner/name');
    const queuedMessage = 'A poll tick is already running; this PR will be reviewed automatically on the current or next poll cycle.';
    forceRecheckMock.mockResolvedValue({ status: 'queued', message: queuedMessage });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), {
      params: Promise.resolve({ number: '1' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.message).toBe(queuedMessage);
  });

  it('returns 409 when a review is already in progress', async () => {
    getConfigMock.mockReturnValue('owner/name');
    forceRecheckMock.mockResolvedValue({ status: 'already-in-progress' });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), {
      params: Promise.resolve({ number: '1' }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 404 when the PR is not found', async () => {
    getConfigMock.mockReturnValue('owner/name');
    forceRecheckMock.mockResolvedValue({ status: 'not-found' });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), {
      params: Promise.resolve({ number: '1' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 502 when fetching fresh PR data fails', async () => {
    getConfigMock.mockReturnValue('owner/name');
    forceRecheckMock.mockResolvedValue({ status: 'error', message: 'gh: authentication required' });
    const res = await POST(new Request('http://localhost/api/recheck/1', { method: 'POST' }), {
      params: Promise.resolve({ number: '1' }),
    });
    expect(res.status).toBe(502);
  });
});
