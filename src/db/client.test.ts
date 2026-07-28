import { describe, it, expect } from 'vitest';
import { createTestDb } from './client';

describe('createTestDb', () => {
  it('creates all expected tables', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining(['config', 'pull_requests', 'findings'])
    );
  });

  it('enforces UNIQUE(repo, pr_number) on pull_requests', () => {
    const db = createTestDb();
    const insert = db.prepare(
      'INSERT INTO pull_requests (repo, pr_number) VALUES (?, ?)'
    );
    insert.run('owner/repo', 1);
    expect(() => insert.run('owner/repo', 1)).toThrow();
  });
});
