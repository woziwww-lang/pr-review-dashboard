import { describe, it, expect } from 'vitest';
import { parseTargetRepo } from './startupConfig';

describe('parseTargetRepo', () => {
  it('accepts a well-formed owner/name value', () => {
    expect(parseTargetRepo('octocat/hello-world')).toEqual({ ok: true, repo: 'octocat/hello-world' });
  });

  it('rejects an unset value', () => {
    const result = parseTargetRepo(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not set/i);
  });

  it('rejects an empty string', () => {
    const result = parseTargetRepo('');
    expect(result.ok).toBe(false);
  });

  it('rejects a value with no slash', () => {
    const result = parseTargetRepo('justaname');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/owner\/name/i);
  });

  it('rejects a value with more than one slash', () => {
    const result = parseTargetRepo('owner/name/extra');
    expect(result.ok).toBe(false);
  });

  it('rejects a value containing whitespace', () => {
    const result = parseTargetRepo('owner/name with space');
    expect(result.ok).toBe(false);
  });
});
