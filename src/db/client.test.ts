import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, runMigrations } from './client';

describe('createTestDb', () => {
  it('creates all expected tables', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as { name: string }).name);

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

  it('createTestDb() includes the closed_at column on pull_requests', () => {
    const db = createTestDb();
    const columns = db.prepare('PRAGMA table_info(pull_requests)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('closed_at');
  });
});

describe('runMigrations', () => {
  it('adds the closed_at column to a pre-existing database that does not have it yet', () => {
    const schemaSql = fs
      .readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf-8')
      .replace(/\s*closed_at TEXT,\n/, '\n');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schemaSql);

    const beforeColumns = db.prepare('PRAGMA table_info(pull_requests)').all() as { name: string }[];
    expect(beforeColumns.map((c) => c.name)).not.toContain('closed_at');

    runMigrations(db);

    const afterColumns = db.prepare('PRAGMA table_info(pull_requests)').all() as { name: string }[];
    expect(afterColumns.map((c) => c.name)).toContain('closed_at');
  });

  it('is idempotent: running it twice on the same database does not throw', () => {
    const db = createTestDb();
    expect(() => {
      runMigrations(db);
      runMigrations(db);
    }).not.toThrow();
  });
});
