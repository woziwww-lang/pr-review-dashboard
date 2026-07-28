export type Verdict = 'approve' | 'needs_fix' | 'needs_review';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ParsedFinding {
  file: string | null;
  line: number | null;
  severity: Severity;
  summary: string;
  failureScenario: string | null;
  evidence: string | null;
  fixSuggestion: string | null;
  codeSnippet: string | null;
}

export interface ParsedReview {
  verdict: Verdict;
  findings: ParsedFinding[];
  rawReportMd: string;
}

const VALID_VERDICTS: Verdict[] = ['approve', 'needs_fix', 'needs_review'];
const VALID_SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
// Matches a fenced ```json ... ``` block anchored at the very end of the
// output (trailing whitespace allowed), per the prompt contract in
// reviewPrompt.ts.
const TRAILING_JSON_BLOCK = /```json\s*([\s\S]*?)\s*```\s*$/;

function emptyResult(rawReportMd: string): ParsedReview {
  return { verdict: 'needs_review', findings: [], rawReportMd };
}

export function parseReviewOutput(rawOutput: string): ParsedReview {
  const match = rawOutput.match(TRAILING_JSON_BLOCK);
  if (!match) return emptyResult(rawOutput);

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return emptyResult(rawOutput);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !VALID_VERDICTS.includes((parsed as { verdict?: string }).verdict as Verdict) ||
    !Array.isArray((parsed as { findings?: unknown }).findings)
  ) {
    return emptyResult(rawOutput);
  }

  const { verdict, findings: rawFindings } = parsed as {
    verdict: Verdict;
    findings: Array<Record<string, unknown>>;
  };

  // A finding entry must have at least a non-empty `summary` and a valid
  // `severity` to be usable — rather than silently coercing bad data
  // (e.g. defaulting an invalid severity to LOW), entries missing these
  // required fields are dropped so we don't persist misleading findings
  // or skew severity counts. This only drops the individual malformed
  // entry; the rest of a well-formed block (and its verdict) still apply.
  const findings: ParsedFinding[] = rawFindings
    .filter(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        typeof f.summary === 'string' &&
        f.summary.length > 0 &&
        VALID_SEVERITIES.includes(f.severity as Severity)
    )
    .map((f) => ({
      file: typeof f.file === 'string' ? f.file : null,
      line: typeof f.line === 'number' ? f.line : null,
      severity: f.severity as Severity,
      summary: f.summary as string,
      failureScenario: typeof f.failureScenario === 'string' ? f.failureScenario : null,
      evidence: typeof f.evidence === 'string' ? f.evidence : null,
      fixSuggestion: typeof f.fixSuggestion === 'string' ? f.fixSuggestion : null,
      codeSnippet: typeof f.codeSnippet === 'string' ? f.codeSnippet : null,
    }));

  return { verdict, findings, rawReportMd: rawOutput };
}
