'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CircleCheck } from 'lucide-react';
import { Button } from './ui/button';

type UiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success' }
  | { kind: 'already-in-progress' }
  | { kind: 'error'; message: string };

// Fallback safety net: if the parent's `disabled` prop never flips to
// true after a successful recheck (e.g. the review resolved before this
// component's next render, or a caller doesn't pass live per-PR data),
// don't get stuck showing the "Started" success state forever.
const SUCCESS_FALLBACK_TIMEOUT_MS = 3000;

export function RecheckButton({ prNumber, disabled }: { prNumber: number; disabled: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<UiState>({ kind: 'idle' });

  async function handleClick() {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/recheck/${prNumber}`, { method: 'POST' });
      const body = await res.json();

      if (res.status === 202) {
        // Both 'started' and 'queued' mean the PR will be reviewed - show
        // a brief success flash immediately, and kick off a refresh so
        // the enclosing Server Component re-fetches DB state. Do NOT
        // reset to 'idle' here: router.refresh() is fire-and-forget (it
        // doesn't return a promise we can await to know when the new
        // server data has landed), so resetting synchronously would let
        // the button flash back to "Re-check now" and become
        // re-clickable before the parent's `disabled` prop actually
        // reflects the new in-progress state. The effect below handles
        // the handoff once fresh data arrives (or a fallback timeout).
        setState({ kind: 'success' });
        router.refresh();
        return;
      }

      if (res.status === 409) {
        setState({ kind: 'already-in-progress' });
        return;
      }

      setState({ kind: 'error', message: body?.error ?? `Re-check failed (HTTP ${res.status})` });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Once the parent re-renders with `disabled: true` (meaning the
  // refreshed server data now shows this PR as in-progress), hand off
  // from our own transient "success" overlay to the parent-driven
  // disabled state. Both branches defer the reset with `setTimeout`
  // instead of calling `setState` synchronously in the effect body, to
  // satisfy `react-hooks/set-state-in-effect`. Also guards against the
  // fallback case via a timeout.
  useEffect(() => {
    if (state.kind !== 'success') return;
    if (disabled) {
      const id = setTimeout(() => setState({ kind: 'idle' }), 0);
      return () => clearTimeout(id);
    }
    const timeout = setTimeout(() => setState({ kind: 'idle' }), SUCCESS_FALLBACK_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [disabled, state.kind]);

  const isLoading = state.kind === 'loading' || state.kind === 'success';

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        onClick={handleClick}
        disabled={disabled || isLoading}
        size="sm"
        className="border-transparent bg-gradient-to-r from-[#3B82F6] to-[#2563EB] text-white hover:opacity-90 disabled:opacity-50"
      >
        {state.kind === 'loading' && (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Re-checking…
          </>
        )}
        {state.kind === 'success' && (
          <>
            <CircleCheck className="h-4 w-4" />
            Started
          </>
        )}
        {state.kind !== 'loading' && state.kind !== 'success' && 'Re-check now'}
      </Button>
      {state.kind === 'already-in-progress' && (
        <span className="text-xs text-muted-foreground">Already in progress</span>
      )}
      {state.kind === 'error' && <span className="text-xs text-red-400">{state.message}</span>}
    </div>
  );
}
