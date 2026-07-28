import { describe, it, expect } from 'vitest';
import { parseReviewOutput } from './parseReviewOutput';

const wellFormed = `# Code Review

## Executive Summary
Some markdown report text.

\`\`\`json
{
  "verdict": "needs_fix",
  "findings": [
    {
      "file": "src/auth.ts",
      "line": 42,
      "severity": "HIGH",
      "summary": "Missing input validation",
      "failureScenario": "Malformed input crashes the server",
      "evidence": "line 42 reads req.body.token without checking type",
      "fixSuggestion": "Validate token is a non-empty string before use",
      "codeSnippet": "if (typeof token !== 'string') throw new Error('invalid token');"
    }
  ]
}
\`\`\`
`;

describe('parseReviewOutput', () => {
  it('extracts verdict and findings from a well-formed trailing JSON block', () => {
    const result = parseReviewOutput(wellFormed);
    expect(result.verdict).toBe('needs_fix');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'src/auth.ts',
      line: 42,
      severity: 'HIGH',
      summary: 'Missing input validation',
    });
    expect(result.rawReportMd).toBe(wellFormed);
  });

  it('falls back to needs_review with no findings when the JSON block is missing', () => {
    const noJson = '# Code Review\n\nJust markdown, no fenced block.';
    const result = parseReviewOutput(noJson);
    expect(result.verdict).toBe('needs_review');
    expect(result.findings).toEqual([]);
    expect(result.rawReportMd).toBe(noJson);
  });

  it('falls back to needs_review with no findings when the JSON block is malformed', () => {
    const badJson = '# Report\n\n```json\n{ this is not valid json \n```\n';
    const result = parseReviewOutput(badJson);
    expect(result.verdict).toBe('needs_review');
    expect(result.findings).toEqual([]);
    expect(result.rawReportMd).toBe(badJson);
  });

  it('falls back to needs_review when JSON is valid but has an unexpected shape', () => {
    const wrongShape = '# Report\n\n```json\n{"verdict": "bogus", "findings": "not-an-array"}\n```\n';
    const result = parseReviewOutput(wrongShape);
    expect(result.verdict).toBe('needs_review');
    expect(result.findings).toEqual([]);
  });

  it('defaults missing optional finding fields to null rather than throwing', () => {
    const sparse = '# Report\n\n```json\n{"verdict": "approve", "findings": [{"summary": "ok", "severity": "LOW"}]}\n```\n';
    const result = parseReviewOutput(sparse);
    expect(result.verdict).toBe('approve');
    expect(result.findings[0]).toEqual({
      file: null,
      line: null,
      severity: 'LOW',
      summary: 'ok',
      failureScenario: null,
      evidence: null,
      fixSuggestion: null,
      codeSnippet: null,
    });
  });

  it('drops individual malformed finding entries but keeps well-formed ones from the same block', () => {
    const mixed = `# Report

\`\`\`json
{
  "verdict": "needs_fix",
  "findings": [
    { "summary": "missing severity entirely" },
    { "summary": "bad severity value", "severity": "SUPER_BAD" },
    { "severity": "HIGH" },
    null,
    "not an object either",
    { "summary": "valid finding", "severity": "HIGH", "file": "a.ts", "line": 1 }
  ]
}
\`\`\`
`;
    const result = parseReviewOutput(mixed);
    expect(result.verdict).toBe('needs_fix');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ summary: 'valid finding', severity: 'HIGH' });
  });

  it('does not parse a ```json block that is not the trailing content', () => {
    const midText = '# Report\n\n```json\n{"verdict": "approve", "findings": []}\n```\n\nSome trailing prose after the block.';
    const result = parseReviewOutput(midText);
    expect(result.verdict).toBe('needs_review');
    expect(result.findings).toEqual([]);
  });
});
