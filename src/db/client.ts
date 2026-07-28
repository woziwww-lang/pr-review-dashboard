import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let dbInstance: Database.Database | null = null;

export function getDbPath(): string {
  return process.env.PR_DASHBOARD_DB_PATH
    ?? path.join(os.homedir(), '.pr-review-dashboard', 'dashboard.sqlite');
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(readSchema());

  dbInstance = db;
  return db;
}

// `__dirname` is not reliable here: Next.js bundles/transpiles server code
// into `.next/server/...` at build time, so a path relative to the
// compiled file's directory would not point at the real `src/db/schema.sql`
// in a production build. `process.cwd()` is stable across `npm run dev`,
// `npm run build && npm start`, and tests, because Next.js always runs
// with the project root as the working directory.
function readSchema(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf-8');
}

// Test-only: allows each test file to get a fresh in-memory database.
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readSchema());
  return db;
}
