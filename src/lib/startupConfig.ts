export interface TargetRepoResult {
  ok: boolean;
  repo?: string;
  error?: string;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseTargetRepo(value: string | undefined): TargetRepoResult {
  if (!value) {
    return { ok: false, error: 'TARGET_REPO environment variable is not set' };
  }
  if (!REPO_PATTERN.test(value)) {
    return {
      ok: false,
      error: `TARGET_REPO "${value}" is not a valid "owner/name" repo identifier`,
    };
  }
  return { ok: true, repo: value };
}
