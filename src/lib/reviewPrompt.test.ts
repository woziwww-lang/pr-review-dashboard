import { describe, it, expect } from 'vitest';
import { buildReviewPrompt } from './reviewPrompt';

describe('buildReviewPrompt', () => {
  it('includes PR identity, branch info, and the JSON contract', () => {
    const prompt = buildReviewPrompt({
      repo: 'owner/name',
      prNumber: 42,
      title: 'Add login form',
      branch: 'feat/login',
      baseBranch: 'main',
      baseSha: 'abc1234',
    });

    expect(prompt).toContain('owner/name');
    expect(prompt).toContain('#42');
    expect(prompt).toContain('Add login form');
    expect(prompt).toContain('feat/login');
    expect(prompt).toContain('main');
    expect(prompt).toContain('abc1234');
    expect(prompt).toContain('local-advanced-code-review');
    expect(prompt).toContain('```json');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"findings"');
    expect(prompt.toLowerCase()).toContain('do not push');
    expect(prompt.toLowerCase()).toContain('do not run `git fetch`'.toLowerCase());
  });
});
