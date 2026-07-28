import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { fetchOpenPrs } = await import('./gh');

describe('fetchOpenPrs', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('parses gh pr list JSON output into a typed PR list', async () => {
    const fixture = [
      {
        number: 1,
        title: 'Add feature',
        author: { login: 'alice' },
        headRefName: 'feat/x',
        baseRefName: 'main',
        headRefOid: 'sha1',
        url: 'https://github.com/o/r/pull/1',
        isDraft: false,
      },
    ];
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, JSON.stringify(fixture), ''));

    const result = await fetchOpenPrs('o/r');

    expect(result).toEqual([
      {
        number: 1,
        title: 'Add feature',
        author: 'alice',
        headRefName: 'feat/x',
        baseRefName: 'main',
        headRefOid: 'sha1',
        url: 'https://github.com/o/r/pull/1',
        isDraft: false,
      },
    ]);
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      [
        'pr', 'list',
        '--repo', 'o/r',
        '--state', 'open',
        '--json', 'number,title,author,headRefName,baseRefName,headRefOid,url,isDraft',
      ],
      expect.any(Function)
    );
  });

  it('returns an empty array when there are no open PRs', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '[]', ''));
    const result = await fetchOpenPrs('o/r');
    expect(result).toEqual([]);
  });

  it('rejects when gh exits non-zero (e.g. auth/network error)', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(new Error('gh: command not found'), '', ''));
    await expect(fetchOpenPrs('o/r')).rejects.toThrow('gh: command not found');
  });
});
