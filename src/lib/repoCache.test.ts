import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn((_cmd, _args, cb) => cb(null, '', ''));
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  },
}));

const {
  getBareRepoPath,
  getWorktreePath,
  ensureBareRepo,
  addOrUpdateWorktree,
} = await import('./repoCache');

describe('repoCache paths', () => {
  it('derives the bare repo path from owner/name, replacing the slash', () => {
    expect(getBareRepoPath('owner/name')).toMatch(/owner__name[/\\]repo\.git$/);
  });

  it('derives a per-PR worktree path', () => {
    expect(getWorktreePath('owner/name', 42)).toMatch(/worktrees[/\\]pr-42$/);
  });
});

describe('ensureBareRepo', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
  });

  it('clones --bare when the repo does not exist locally yet', async () => {
    existsSyncMock.mockReturnValue(false);

    await ensureBareRepo('owner/name');

    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone', '--bare']),
      expect.any(Function)
    );
  });

  it('fetches instead of cloning when the bare repo already exists', async () => {
    existsSyncMock.mockReturnValue(true);

    await ensureBareRepo('owner/name');

    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['fetch']),
      expect.any(Function)
    );
    expect(execFileMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone']),
      expect.any(Function)
    );
  });
});

describe('addOrUpdateWorktree', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '', ''));
  });

  it('fetches the PR head and adds a fresh worktree when none is registered yet', async () => {
    existsSyncMock.mockReturnValue(false);

    const dir = await addOrUpdateWorktree('owner/name', 42, 'sha1');

    expect(dir).toMatch(/worktrees[/\\]pr-42$/);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['worktree', 'list', '--porcelain'])
    );
    expect(execFileMock.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['fetch', 'origin', '+refs/pull/42/head:refs/remotes/origin/pr-42'])
    );
    expect(execFileMock.mock.calls[2][1]).toEqual(
      expect.arrayContaining(['worktree', 'add', '--detach', dir, 'sha1'])
    );
  });

  it('removes a registered worktree before recreating it at the new head_sha', async () => {
    existsSyncMock.mockReturnValue(false);
    const registeredDir = getWorktreePath('owner/name', 42);
    execFileMock.mockImplementation((_cmd, args, cb) => {
      if (args.includes('list')) {
        cb(null, `worktree ${registeredDir}\n`, '');
        return;
      }
      cb(null, '', '');
    });

    const dir = await addOrUpdateWorktree('owner/name', 42, 'sha2');

    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(execFileMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['worktree', 'list', '--porcelain'])
    );
    expect(execFileMock.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['fetch', 'origin', '+refs/pull/42/head:refs/remotes/origin/pr-42'])
    );
    expect(execFileMock.mock.calls[2][1]).toEqual(
      expect.arrayContaining(['worktree', 'remove', '--force', dir])
    );
    expect(execFileMock.mock.calls[3][1]).toEqual(
      expect.arrayContaining(['worktree', 'add', '--detach', dir, 'sha2'])
    );
  });
});
