import type { SeveritySummary } from '../../lib/severitySummary';

export function SeveritySummaryBar({ summary }: { summary: SeveritySummary }) {
  if (summary.total === 0) {
    return (
      <div className="card-glass flex flex-col gap-1 p-3">
        <div className="h-2 w-full rounded-full bg-muted" />
        <p className="text-xs text-muted-foreground">
          {summary.reviewedCount === 0
            ? 'No reviewed data yet'
            : `No findings across ${summary.reviewedCount} reviewed PRs`}
        </p>
      </div>
    );
  }

  const segments: Array<{ key: string; label: string; count: number; colorClass: string }> = [
    { key: 'critical', label: 'Critical', count: summary.critical, colorClass: 'bg-severity-critical' },
    { key: 'high', label: 'High', count: summary.high, colorClass: 'bg-severity-high' },
    { key: 'medium', label: 'Medium', count: summary.medium, colorClass: 'bg-severity-medium' },
    { key: 'low', label: 'Low', count: summary.low, colorClass: 'bg-severity-low' },
  ];

  return (
    <div className="card-glass flex flex-col gap-2 p-3">
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <div
              key={segment.key}
              data-testid={`severity-segment-${segment.key}`}
              className={segment.colorClass}
              style={{ flexBasis: `${(segment.count / summary.total) * 100}%` }}
            />
          ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {segments.map((segment) => `${segment.label} ${segment.count}`).join(' · ')}
      </p>
    </div>
  );
}
