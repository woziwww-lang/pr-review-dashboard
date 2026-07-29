import { Clock } from 'lucide-react';
import { formatTokyoTime, formatRelativeTime } from '../../lib/formatTime';

/**
 * A small pill showing a relative time ("3 minutes ago") with the full
 * Tokyo-time timestamp available as a native tooltip on hover/focus
 * (via the <time> element's `title` attribute) and for screen readers
 * (via `dateTime`). Falls back to a muted em-dash when there's no
 * timestamp yet (e.g. a PR that hasn't been reviewed).
 */
export function TimeStamp({ iso, label }: { iso: string | null; label?: string }) {
  if (iso === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {label && <span>{label}</span>}
        <span>—</span>
      </span>
    );
  }

  const absolute = formatTokyoTime(iso);
  const relative = formatRelativeTime(iso);

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
      <Clock className="h-3 w-3 shrink-0 text-primary/70" />
      {label && <span>{label}</span>}
      <time dateTime={iso} title={absolute ?? undefined} className="font-medium text-foreground/80">
        {relative}
      </time>
    </span>
  );
}
