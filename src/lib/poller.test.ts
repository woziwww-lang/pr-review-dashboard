import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../db/client';
import { getByNumber, getOpenPrs } from '../db/pullRequests';
import { getConfig } from '../db/config';
import { getFindingsByPrId } from '../db/findings';

const fetchOpenPrsMock = vi.fn();
vi.mock('./gh', () => ({ fetchOpenPrs: (...args: unknown[]) => fetchOpenPrsMock(...args) }));

const ensureBareRepoMock = vi.fn().mockResolvedValue(undefined);
const addOrUpdateWorktreeMock = vi.fn().mockResolvedValue('/tmp/worktrees/pr-1');
const resolveLocalBaseShaMock = vi.fn().mockResolvedValue('basesha1');
vi.mock('./repoCache', () => ({
  ensureBareRepo: (...args: unknown[]) => ensureBareRepoMock(...args),
  addOrUpdateWorktree: (...args: unknown[]) => addOrUpdateWorktreeMock(...args),
  resolveLocalBaseSha: (...args: unknown[]) => resolveLocalBaseShaMock(...args),
}));

const runReviewMock = vi.fn();
vi.mock('./reviewRunner', () => ({ runReview: (...args: unknown[]) => runReviewMock(...args) }));

const { runPollTick } = await import('./poller');

const basePrFromGh = {
  number: 1,
  title: 'Add feature',
  author: 'alice',
  headRefName: 'feat/x',
  baseRefName: 'main',
  headRefOid: 'sha1',
  url: 'https://github.com/owner/name/pull/1',
  isDraft: false,
};

describe('runPollTick', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    fetchOpenPrsMock.mockReset();
    ensureBareRepoMock.mockClear();
    addOrUpdateWorktreeMock.mockClear();
    resolveLocalBaseShaMock.mockClear();
    runReviewMock.mockReset();
  });

  it('reviews a brand new PR end-to-end and records a successful review', async () => {
    fetchOpenPrsMock.mockResolvedValue([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: true,
      output: `# Report\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });

    await runPollTick(db, 'owner/name');

    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('done');
    expect(row.verdict).toBe('approve');
    expect(row.reviewed_head_sha).toBe('sha1');
    expect(getConfig(db, 'last_poll_status')).toBe('ok');
    expect(ensureBareRepoMock).toHaveBeenCalledWith('owner/name');
    expect(addOrUpdateWorktreeMock).toHaveBeenCalledWith('owner/name', 1, 'sha1');
    expect(resolveLocalBaseShaMock).toHaveBeenCalledWith('owner/name', 'main');
  });

  it('skips a draft PR entirely (tracked but never reviewed)', async () => {
    fetchOpenPrsMock.mockResolvedValue([{ ...basePrFromGh, isDraft: true }]);

    await runPollTick(db, 'owner/name');

    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('pending'); // insert default, never actually run
    expect(runReviewMock).not.toHaveBeenCalled();
    expect(getOpenPrs(db, 'owner/name')).toEqual([]); // filtered out of the visible list
  });

  it('re-reviews an existing PR when head_sha changed, storing new findings and clearing old ones', async () => {
    fetchOpenPrsMock.mockResolvedValueOnce([basePrFromGh]);
    runReviewMock.mockResolvedValueOnce({
      success: true,
      output: `# R1\n\n\`\`\`json\n{"verdict": "needs_fix", "findings": [{"summary": "old finding", "severity": "HIGH"}]}\n\`\`\`\n`,
    });
    await runPollTick(db, 'owner/name');
    const firstRow = getByNumber(db, 'owner/name', 1)!;
    expect(getFindingsByPrId(db, firstRow.id)).toHaveLength(1);

    fetchOpenPrsMock.mockResolvedValueOnce([{ ...basePrFromGh, headRefOid: 'sha2' }]);
    runReviewMock.mockResolvedValueOnce({
      success: true,
      output: `# R2\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });
    await runPollTick(db, 'owner/name');

    const secondRow = getByNumber(db, 'owner/name', 1)!;
    expect(secondRow.reviewed_head_sha).toBe('sha2');
    expect(secondRow.verdict).toBe('approve');
    expect(getFindingsByPrId(db, secondRow.id)).toHaveLength(0); // old finding replaced
    expect(runReviewMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-review an unchanged PR on a second poll tick', async () => {
    fetchOpenPrsMock.mockResolvedValue([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: true,
      output: `# R\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });

    await runPollTick(db, 'owner/name');
    await runPollTick(db, 'owner/name');

    expect(runReviewMock).toHaveBeenCalledTimes(1);
  });

  it('marks a PR failed when the review run fails, preserving no prior successful data to lose', async () => {
    fetchOpenPrsMock.mockResolvedValue([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: false,
      output: '',
      errorMessage: 'copilot timed out after 600000ms',
    });

    await runPollTick(db, 'owner/name');

    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('failed');
    expect(row.error_message).toBe('copilot timed out after 600000ms');
    expect(row.reviewed_head_sha).toBeNull();
    expect(row.last_reviewed_at).toBeNull();
  });

  it('marks the poll itself failed and leaves existing data untouched when gh pr list throws', async () => {
    fetchOpenPrsMock.mockResolvedValue([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: true,
      output: `# R\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });
    await runPollTick(db, 'owner/name'); // establish a successful baseline

    fetchOpenPrsMock.mockRejectedValueOnce(new Error('gh: authentication required'));
    await runPollTick(db, 'owner/name');

    expect(getConfig(db, 'last_poll_status')).toBe('error');
    expect(getConfig(db, 'last_poll_error')).toBe('gh: authentication required');
    const row = getByNumber(db, 'owner/name', 1)!;
    expect(row.review_status).toBe('done'); // untouched by the failed poll
  });

  it('marks PRs absent from the gh result as closed', async () => {
    fetchOpenPrsMock.mockResolvedValueOnce([basePrFromGh]);
    runReviewMock.mockResolvedValue({
      success: true,
      output: `# R\n\n\`\`\`json\n{"verdict": "approve", "findings": []}\n\`\`\`\n`,
    });
    await runPollTick(db, 'owner/name');

    fetchOpenPrsMock.mockResolvedValueOnce([]); // PR #1 merged/closed upstream
    await runPollTick(db, 'owner/name');

    expect(getByNumber(db, 'owner/name', 1)!.pr_state).toBe('closed');
  });
});
