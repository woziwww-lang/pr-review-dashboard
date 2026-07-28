export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

const COLORS: Record<Severity, string> = {
  CRITICAL: '#82071e',
  HIGH: '#cf222e',
  MEDIUM: '#9a6700',
  LOW: '#57606a',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      style={{ color: 'white', background: COLORS[severity], padding: '1px 6px', borderRadius: 4, fontSize: '0.8em' }}
    >
      {severity}
    </span>
  );
}
