export type BadgeVerdict = 'approve' | 'needs_fix' | 'needs_review' | 'failed';

const LABELS: Record<BadgeVerdict, string> = {
  approve: 'Approve',
  needs_fix: 'Needs Fix',
  needs_review: 'Needs Review',
  failed: 'Review Failed',
};

const COLORS: Record<BadgeVerdict, string> = {
  approve: '#1a7f37',
  needs_fix: '#cf222e',
  needs_review: '#9a6700',
  failed: '#57606a',
};

export function VerdictBadge({ verdict }: { verdict: BadgeVerdict }) {
  return (
    <span
      style={{ color: 'white', background: COLORS[verdict], padding: '2px 8px', borderRadius: 4 }}
    >
      {LABELS[verdict]}
    </span>
  );
}
