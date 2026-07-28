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
  });

  it('adds a fresh worktree when none exists for this PR yet', async () => {
    existsSyncMock.mockReturnValue(false);

    const dir = await addOrUpdateWorktree('owner/name', 42, 'sha1');

    expect(dir).toMatch(/worktrees[/\\]pr-42$/);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['worktree', 'add', '--detach', dir, 'sha1']));
    expect(args).not.toContain('--force');
  });

  it('force re-points an existing worktree to the new head_sha', async () => {
    existsSyncMock.mockReturnValue(true);

    const dir = await addOrUpdateWorktree('owner/name', 42, 'sha2');

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining(['worktree', 'add', '--force', '--detach', dir, 'sha2'])
    );
  });
});
