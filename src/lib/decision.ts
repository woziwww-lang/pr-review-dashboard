export interface DecisionInput {
  isDraft: boolean;
  /** This PR's head_sha as stored before this poll tick's upsert; null for a brand new row. */
  previousHeadSha: string | null;
  /** head_sha just fetched from `gh pr list` for this poll tick. */
  newHeadSha: string;
  /** null means this row does not exist yet (about to be INSERTed). */
  reviewStatus: 'pending' | 'reviewing' | 'done' | 'failed' | null;
}

export type Decision = 'enqueue' | 'skip';

export function decidePrAction(input: DecisionInput): Decision {
  if (input.isDraft) return 'skip'; // drafts are tracked but never reviewed

  if (input.reviewStatus === null) return 'enqueue'; // brand new PR

  // Single-flight: never re-enqueue work that's already in progress.
  if (input.reviewStatus === 'pending' || input.reviewStatus === 'reviewing') {
    return 'skip';
  }

  // reviewStatus is 'done' or 'failed' — both are terminal states until
  // the commit actually changes, or a manual re-check/retry bypasses
  // this function entirely (see Chunk 3 poller).
  if (input.previousHeadSha !== input.newHeadSha) return 'enqueue';
  return 'skip';
}
