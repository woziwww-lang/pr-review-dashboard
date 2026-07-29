/**
 * Timestamp formatting for the dashboard UI.
 *
 * All timestamps are stored as UTC ISO 8601 strings (see `new
 * Date().toISOString()` calls in db/pullRequests.ts and lib/poller.ts).
 * The dashboard always displays them in Asia/Tokyo (JST, UTC+9) regardless
 * of the server's local timezone, since `Intl.DateTimeFormat`'s `timeZone`
 * option converts explicitly rather than relying on the host's offset.
 */

const TOKYO_TIME_ZONE = 'Asia/Tokyo';

const tokyoFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TOKYO_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Formats an ISO timestamp as `YYYY/MM/DD HH:mm JST`.
 *
 * Uses the `sv-SE` locale as an implementation detail only, because it
 * happens to produce a `YYYY-MM-DD HH:mm` layout closest to the desired
 * output with the fewest string transformations - the locale itself is
 * never shown to users.
 */
export function formatTokyoTime(iso: string | null): string | null {
  if (iso === null) {
    return null;
  }
  const parts = tokyoFormatter.formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')} JST`;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Describes an ISO timestamp relative to now (e.g. "3 minutes ago"),
 * evaluated against `Date.now()` at call time.
 */
export function formatRelativeTime(iso: string | null): string | null {
  if (iso === null) {
    return null;
  }
  const diffMs = Date.now() - new Date(iso).getTime();

  if (diffMs < MINUTE_MS) {
    return 'just now';
  }
  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
