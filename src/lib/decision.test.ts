import { describe, it, expect } from 'vitest';
import { decidePrAction, type DecisionInput } from './decision';

function input(overrides: Partial<DecisionInput>): DecisionInput {
  return {
    isDraft: false,
    previousHeadSha: 'sha1',
    newHeadSha: 'sha1',
    reviewStatus: 'done',
    ...overrides,
  };
}

describe('decidePrAction', () => {
  it('enqueues a brand new row (reviewStatus is null)', () => {
    expect(
      decidePrAction(input({ reviewStatus: null, previousHeadSha: null, newHeadSha: 'sha1' }))
    ).toBe('enqueue');
  });

  it('skips a brand new draft row', () => {
    expect(
      decidePrAction(input({ reviewStatus: null, previousHeadSha: null, isDraft: true }))
    ).toBe('skip');
  });

  it('skips any draft regardless of head_sha change', () => {
    expect(
      decidePrAction(input({ isDraft: true, previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('skip');
  });

  it('skips a row already pending (single-flight)', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'pending', previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('skip');
  });

  it('skips a row already reviewing (single-flight)', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'reviewing', previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('skip');
  });

  it('skips a done row when head_sha is unchanged', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'done', previousHeadSha: 'sha1', newHeadSha: 'sha1' }))
    ).toBe('skip');
  });

  it('enqueues a done row when head_sha changed', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'done', previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('enqueue');
  });

  it('skips a failed row when head_sha is unchanged (terminal, no auto-retry)', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'failed', previousHeadSha: 'sha1', newHeadSha: 'sha1' }))
    ).toBe('skip');
  });

  it('enqueues a failed row when head_sha changed', () => {
    expect(
      decidePrAction(input({ reviewStatus: 'failed', previousHeadSha: 'sha1', newHeadSha: 'sha2' }))
    ).toBe('enqueue');
  });
});
