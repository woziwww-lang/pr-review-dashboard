import { describe, it, expect } from 'vitest';
import { createTestDb } from './client';
import { getConfig, setConfig } from './config';

describe('config helpers', () => {
  it('returns undefined for a missing key', () => {
    const db = createTestDb();
    expect(getConfig(db, 'target_repo')).toBeUndefined();
  });

  it('sets and gets a value', () => {
    const db = createTestDb();
    setConfig(db, 'target_repo', 'owner/name');
    expect(getConfig(db, 'target_repo')).toBe('owner/name');
  });

  it('overwrites an existing value', () => {
    const db = createTestDb();
    setConfig(db, 'last_poll_status', 'error');
    setConfig(db, 'last_poll_status', 'ok');
    expect(getConfig(db, 'last_poll_status')).toBe('ok');
  });
});
