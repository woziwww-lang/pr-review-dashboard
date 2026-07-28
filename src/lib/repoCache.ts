import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// See gh.ts for why this is a hand-written wrapper rather than
// `util.promisify(execFile)` (promisify's execFile-specific behavior
// depends on a symbol real Node sets internally, which plain test mocks
// don't carry).
function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export function getReposRootDir(): string {
  return (
    process.env.PR_DASHBOARD_REPOS_DIR ??
    path.join(os.homedir(), '.pr-review-dashboard', 'repos')
  );
}

function repoDirName(repo: string): string {
  return repo.replace('/', '__');
}

export function getBareRepoPath(repo: string): string {
  return path.join(getReposRootDir(), repoDirName(repo), 'repo.git');
}

export function getWorktreePath(repo: string, prNumber: number): string {
  return path.join(getReposRootDir(), repoDirName(repo), 'worktrees', `pr-${prNumber}`);
}

// Read-only against the remote: only `clone --bare` (first use) and
// `fetch` (subsequent polls) are ever run against the remote. Nothing
// here ever pushes or mutates a remote ref.
export async function ensureBareRepo(repo: string): Promise<void> {
  const bareDir = getBareRepoPath(repo);
  if (fs.existsSync(bareDir)) {
    await execFileAsync('git', ['--git-dir', bareDir, 'fetch', 'origin', '+refs/heads/*:refs/heads/*']);
    return;
  }

  fs.mkdirSync(path.dirname(bareDir), { recursive: true });
  await execFileAsync('git', ['clone', '--bare', `https://github.com/${repo}.git`, bareDir]);
}

// Purely local: `git worktree add` never touches the remote. Re-points an
// existing worktree with `--force` when re-reviewing at a new head_sha.
export async function addOrUpdateWorktree(
  repo: string,
  prNumber: number,
  headSha: string
): Promise<string> {
  const bareDir = getBareRepoPath(repo);
  const worktreeDir = getWorktreePath(repo, prNumber);
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

  const args = ['--git-dir', bareDir, 'worktree', 'add'];
  if (fs.existsSync(worktreeDir)) {
    args.push('--force');
  }
  args.push('--detach', worktreeDir, headSha);

  await execFileAsync('git', args);
  return worktreeDir;
}
