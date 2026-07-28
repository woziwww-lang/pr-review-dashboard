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

// Left border color keyed to severity - independent of SeverityBadge's
// own color mapping so this can use plain border-left CSS instead of
// duplicating the Tailwind color classes.
const BORDER_COLORS: Record<Severity, string> = {
  CRITICAL: '#991B1B',
  HIGH: '#F87171',
  MEDIUM: '#FBBF24',
  LOW: '#3F3F46',
};

export function FindingCard({ finding }: { finding: FindingCardInput }) {
  return (
    <div
      className="mb-2 rounded-lg border border-[#27272A] bg-[#18181B] p-3 pl-4"
      style={{ borderLeft: `3px solid ${BORDER_COLORS[finding.severity]}` }}
    >
      <div className="mb-1 flex items-center gap-2">
        <SeverityBadge severity={finding.severity} /> <strong className="text-[#FAFAFA]">{finding.summary}</strong>
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {finding.file}:{finding.line}
      </p>
      <p className="mt-2 text-sm text-[#D4D4D8]">
        <em>Failure scenario:</em> {finding.failureScenario}
      </p>
      <p className="mt-1 text-sm text-[#D4D4D8]">
        <em>Evidence:</em> {finding.evidence}
      </p>
      <p className="mt-1 text-sm text-[#D4D4D8]">
        <em>Fix:</em> {finding.fixSuggestion}
      </p>
      <pre className="mt-2 overflow-x-auto rounded bg-[#09090B] p-2 font-mono text-xs">{finding.codeSnippet}</pre>
    </div>
  );
}
