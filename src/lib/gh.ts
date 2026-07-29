import { execFile } from 'node:child_process';

export interface GhPrListItem {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url: string;
  isDraft: boolean;
}

interface RawGhPr {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url: string;
  isDraft: boolean;
}

export type PrFinalState = 'merged' | 'closed';

interface RawGhPrState {
  state: 'MERGED' | 'CLOSED' | 'OPEN';
}

// A hand-written Promise wrapper rather than `util.promisify(execFile)`:
// promisify's multi-value (stdout, stderr) support for execFile relies on
// Node internally tagging the real `execFile` with the
// `util.promisify.custom` symbol. A plain callback-style mock (as used in
// tests) doesn't carry that symbol, so `promisify` would silently fall
// back to resolving with only the raw stdout *string* instead of
// `{ stdout, stderr }` — breaking both real usage assumptions and test
// mockability. This wrapper works identically against the real
// `execFile` and against a simple `(cmd, args, callback) => ...` mock.
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

// Read-only against the remote: `gh pr list` only reads PR metadata, it
// never mutates anything on GitHub.
export async function fetchOpenPrs(repo: string): Promise<GhPrListItem[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', repo,
    '--state', 'open',
    '--json', 'number,title,author,headRefName,baseRefName,headRefOid,url,isDraft',
  ]);
  const raw = JSON.parse(stdout) as RawGhPr[];
  return raw.map((r) => ({
    number: r.number,
    title: r.title,
    author: r.author.login,
    headRefName: r.headRefName,
    baseRefName: r.baseRefName,
    headRefOid: r.headRefOid,
    url: r.url,
    isDraft: r.isDraft,
  }));
}

// Called only for a PR that has just disappeared from `fetchOpenPrs`'s
// open-state result, to determine whether it was merged or closed
// without merging (GitHub distinguishes these; a plain "closed" result
// from `gh pr list --state open` cannot tell them apart, since it never
// returns non-open PRs at all).
export async function getPrFinalState(repo: string, prNumber: number): Promise<PrFinalState> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'view', String(prNumber),
    '--repo', repo,
    '--json', 'state',
  ]);
  const raw = JSON.parse(stdout) as RawGhPrState;
  if (raw.state === 'MERGED') return 'merged';
  if (raw.state === 'CLOSED') return 'closed';
  throw new Error(`unexpected pr state "${raw.state}" for ${repo}#${prNumber}`);
}
