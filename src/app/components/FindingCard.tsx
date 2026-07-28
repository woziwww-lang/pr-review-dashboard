import { SeverityBadge, type Severity } from './SeverityBadge';

export interface FindingCardInput {
  file: string;
  line: number;
  severity: Severity;
  summary: string;
  failureScenario: string;
  evidence: string;
  fixSuggestion: string;
  codeSnippet: string;
}

export function FindingCard({ finding }: { finding: FindingCardInput }) {
  return (
    <div style={{ border: '1px solid #d0d7de', borderRadius: 6, padding: 12, marginBottom: 8 }}>
      <div>
        <SeverityBadge severity={finding.severity} /> <strong>{finding.summary}</strong>
      </div>
      <p>
        {finding.file}:{finding.line}
      </p>
      <p>
        <em>Failure scenario:</em> {finding.failureScenario}
      </p>
      <p>
        <em>Evidence:</em> {finding.evidence}
      </p>
      <p>
        <em>Fix:</em> {finding.fixSuggestion}
      </p>
      <pre>{finding.codeSnippet}</pre>
    </div>
  );
}
