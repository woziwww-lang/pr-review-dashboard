import type Database from 'better-sqlite3';

export interface FindingInput {
  file: string;
  line: number;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;
  failureScenario: string;
  evidence: string;
  fixSuggestion: string;
  codeSnippet: string;
}

export interface FindingRow extends FindingInput {
  id: number;
  pull_request_id: number;
}

export function replaceFindings(
  db: Database.Database,
  pullRequestId: number,
  findings: FindingInput[]
): void {
  const tx = db.transaction((items: FindingInput[]) => {
    db.prepare('DELETE FROM findings WHERE pull_request_id = ?').run(pullRequestId);
    const insert = db.prepare(
      `INSERT INTO findings
         (pull_request_id, file, line, severity, summary, failure_scenario, evidence, fix_suggestion, code_snippet)
       VALUES (@pullRequestId, @file, @line, @severity, @summary, @failureScenario, @evidence, @fixSuggestion, @codeSnippet)`
    );
    for (const item of items) {
      insert.run({ ...item, pullRequestId });
    }
  });
  tx(findings);
}

export function getFindingsByPrId(db: Database.Database, pullRequestId: number): FindingRow[] {
  // Explicit column aliasing, not `SELECT *`: the `findings` table's
  // columns are snake_case (failure_scenario, fix_suggestion,
  // code_snippet) but `FindingRow` is camelCase to match `FindingInput`.
  // `SELECT *` would silently produce rows with `undefined` camelCase
  // fields at runtime despite the `as FindingRow` cast type-checking fine.
  return db
    .prepare(
      `SELECT id, pull_request_id, file, line, severity, summary,
              failure_scenario AS failureScenario,
              evidence,
              fix_suggestion AS fixSuggestion,
              code_snippet AS codeSnippet
       FROM findings WHERE pull_request_id = ? ORDER BY severity, line`
    )
    .all(pullRequestId) as FindingRow[];
}
