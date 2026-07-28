// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RecheckButton } from './RecheckButton';

const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

describe('RecheckButton', () => {
  beforeEach(() => {
    mockRefresh.mockClear();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders enabled with default label when not disabled', () => {
    render(<RecheckButton prNumber={42} disabled={false} />);
    const button = screen.getByRole('button', { name: /re-check now/i });
    expect(button).toBeEnabled();
  });

  it('renders disabled when disabled prop is true', () => {
    render(<RecheckButton prNumber={42} disabled={true} />);
    const button = screen.getByRole('button', { name: /re-check now/i });
    expect(button).toBeDisabled();
  });

  it('shows a loading state while the request is in flight, then a success flash, calling refresh immediately on 202 started', async () => {
    let resolveFetch: (value: unknown) => void;
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    render(<RecheckButton prNumber={42} disabled={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));
    });

    expect(await screen.findByText(/re-checking/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-checking/i })).toBeDisabled();

    resolveFetch!({
      ok: true,
      status: 202,
      json: async () => ({ status: 'started' }),
    });

    // Success flash renders, and refresh() fires right away (not
    // delayed) - the component doesn't reset to idle on its own, since
    // it can't know when the refreshed data has landed; it waits for the
    // `disabled` prop to flip to true instead (see the next test).
    expect(await screen.findByText(/started/i)).toBeInTheDocument();
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /started/i })).toBeDisabled();
  });

  it('hands off from the success flash to the disabled prop once the parent re-renders as in-progress', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'started' }),
    });

    const { rerender } = render(<RecheckButton prNumber={42} disabled={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));
    });

    await vi.waitFor(() => screen.getByText(/started/i));

    // Simulate the parent Server Component re-rendering with fresh data
    // (post router.refresh()) that now shows this PR as in-progress.
    await act(async () => {
      rerender(<RecheckButton prNumber={42} disabled={true} />);
    });

    const button = await screen.findByRole('button', { name: /re-check now/i });
    expect(button).toBeDisabled();
  });

  it('falls back to idle after a timeout if disabled never flips true', async () => {
    vi.useFakeTimers();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'started' }),
    });

    render(<RecheckButton prNumber={42} disabled={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));
    });

    await vi.waitFor(() => screen.getByText(/started/i));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /re-check now/i })).toBeEnabled());

    vi.useRealTimers();
  });

  it('refreshes on 202 queued the same as 202 started', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'queued', message: 'a poll tick is already running' }),
    });

    render(<RecheckButton prNumber={7} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    await screen.findByText(/started/i);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it('shows an inline "already in progress" message on 409 without calling refresh', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ status: 'already-in-progress' }),
    });

    render(<RecheckButton prNumber={7} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(/already in progress/i)).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows an inline error message on a 404 error response and re-enables the button', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'PR not found or no longer open' }),
    });

    render(<RecheckButton prNumber={99} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(/PR not found or no longer open/i)).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: /re-check now/i });
    expect(button).toBeEnabled();
  });

  it.each([400, 500, 502])('shows an inline error message on a %d error response', async (status) => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status,
      json: async () => ({ error: `error for status ${status}` }),
    });

    render(<RecheckButton prNumber={99} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(new RegExp(`error for status ${status}`, 'i'))).toBeInTheDocument();
  });

  it('shows a generic error message when fetch itself rejects (network failure)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));

    render(<RecheckButton prNumber={99} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });
});
