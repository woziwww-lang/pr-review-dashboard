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
    <div>
      <p>Last poll: {lastPollAt ?? 'never'}</p>
      {lastPollStatus === 'error' && (
        <div role="alert" style={{ background: '#fff8c5', padding: 8, borderRadius: 4 }}>
          ⚠ Last poll failed: {lastPollError}
        </div>
      )}
    </div>
  );
}
