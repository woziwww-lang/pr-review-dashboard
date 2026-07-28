import type { SeveritySummary } from '../../lib/severitySummary';

function buildConicGradient(summary: SeveritySummary): string {
  const stops: Array<{ colorVar: string; count: number }> = [
    { colorVar: 'var(--severity-critical)', count: summary.critical },
    { colorVar: 'var(--severity-high)', count: summary.high },
    { colorVar: 'var(--severity-medium)', count: summary.medium },
    { colorVar: 'var(--severity-low)', count: summary.low },
  ];

  let cumulativeDeg = 0;
  const segments = stops
    .filter((stop) => stop.count > 0)
    .map((stop) => {
      const startDeg = cumulativeDeg;
      cumulativeDeg += (stop.count / summary.total) * 360;
      return `${stop.colorVar} ${startDeg}deg ${cumulativeDeg}deg`;
    });

  return `conic-gradient(${segments.join(', ')})`;
}

export function SeverityDonut({ summary }: { summary: SeveritySummary }) {
  const centerLabel = summary.reviewedCount === 0 ? 'Not yet reviewed' : summary.total === 0 ? '0 findings' : null;

  return (
    <div className="relative flex h-24 w-24 items-center justify-center">
      <div
        data-testid="severity-donut-ring"
        className="absolute inset-0 rounded-full"
        style={{
          backgroundImage: summary.total > 0 ? buildConicGradient(summary) : undefined,
          backgroundColor: summary.total === 0 ? 'var(--muted)' : undefined,
        }}
      />
      <div className="app-gradient absolute inset-3 rounded-full" />
      <span className="relative z-10 text-center text-xs text-muted-foreground">
        {centerLabel ?? `${summary.total} findings`}
      </span>
    </div>
  );
}
