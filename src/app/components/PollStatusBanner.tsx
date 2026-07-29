import { TriangleAlert } from 'lucide-react';
import { TimeStamp } from './TimeStamp';

export function PollStatusBanner({
  lastPollAt,
  lastPollStatus,
  lastPollError,
}: {
  lastPollAt: string | null;
  lastPollStatus: 'ok' | 'error' | null;
  lastPollError: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <TimeStamp iso={lastPollAt} label="Last poll" />
      {lastPollStatus === 'error' && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[#451A03] bg-[#FBBF24]/10 px-3 py-2 text-sm text-[#FBBF24]"
        >
          <TriangleAlert className="h-4 w-4 shrink-0" />
          Last poll failed: {lastPollError}
        </div>
      )}
    </div>
  );
}
