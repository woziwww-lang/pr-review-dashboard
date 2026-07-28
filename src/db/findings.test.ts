import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './client';
import { upsertOpenPr, getByNumber } from './pullRequests';
import { replaceFindings, getFindingsByPrId } from './findings';

describe('findings repository', () => {
  let db: Database.Database;
  let prId: number;

  beforeEach(() => {
    db = createTestDb();
    upsertOpenPr(db, {
      repo: 'owner/name',
      prNumber: 1,
      title: 't',
      author: 'a',
      branch: 'b',
      baseBranch: 'main',
      headSha: 'sha1',
      prUrl: 'url',
      isDraft: false,
    });
    prId = getByNumber(db, 'owner/name', 1)!.id;
  });

  it('inserts findings for a PR', () => {
    replaceFindings(db, prId, [
      {
        file: 'src/a.ts',
        line: 10,
        severity: 'CRITICAL',
        summary: 'bug',
        failureScenario: 'x happens',
        evidence: 'a.ts:10',
        fixSuggestion: 'do y',
        codeSnippet: 'fix();',
      },
    ]);
    const rows = getFindingsByPrId(db, prId);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('CRITICAL');
  });

  it('replaces old findings rather than accumulating them', () => {
    replaceFindings(db, prId, [
      { file: 'a.ts', line: 1, severity: 'HIGH', summary: 'first', failureScenario: '', evidence: '', fixSuggestion: '', codeSnippet: '' },
    ]);
    replaceFindings(db, prId, [
      { file: 'b.ts', line: 2, severity: 'LOW', summary: 'second', failureScenario: '', evidence: '', fixSuggestion: '', codeSnippet: '' },
    ]);

    const rows = getFindingsByPrId(db, prId);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('second');
  });

  it('cascades delete when the parent PR row is deleted', () => {
    replaceFindings(db, prId, [
      { file: 'a.ts', line: 1, severity: 'HIGH', summary: 'x', failureScenario: '', evidence: '', fixSuggestion: '', codeSnippet: '' },
    ]);
    db.prepare('DELETE FROM pull_requests WHERE id = ?').run(prId);
    expect(getFindingsByPrId(db, prId)).toHaveLength(0);
  });

  it('returns camelCase fields, not raw snake_case DB column names', () => {
    replaceFindings(db, prId, [
      {
        file: 'a.ts',
        line: 1,
        severity: 'HIGH',
        summary: 'x',
        failureScenario: 'scenario text',
        evidence: 'evidence text',
        fixSuggestion: 'fix text',
        codeSnippet: 'snippet text',
      },
    ]);
    const [row] = getFindingsByPrId(db, prId);
    // A naive `SELECT *` would return snake_case columns (failure_scenario,
    // fix_suggestion, code_snippet) cast to this camelCase interface,
    // silently leaving these fields `undefined` at runtime even though
    // TypeScript wouldn't catch it - this test guards against that.
    expect(row.failureScenario).toBe('scenario text');
    expect(row.fixSuggestion).toBe('fix text');
    expect(row.codeSnippet).toBe('snippet text');
  });
});
