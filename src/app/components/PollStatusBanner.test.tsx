// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PollStatusBanner } from './PollStatusBanner';

describe('PollStatusBanner', () => {
  it('shows only the last poll time when the last poll succeeded', () => {
    render(<PollStatusBanner lastPollAt="2026-07-28T00:00:00.000Z" lastPollStatus="ok" lastPollError={null} />);
    expect(screen.queryByText(/last poll failed/i)).not.toBeInTheDocument();
  });

  it('shows a warning banner with the error message when the last poll failed', () => {
    render(
      <PollStatusBanner
        lastPollAt="2026-07-28T00:00:00.000Z"
        lastPollStatus="error"
        lastPollError="gh: authentication required"
      />
    );
    expect(screen.getByText(/last poll failed/i)).toBeInTheDocument();
    expect(screen.getByText(/gh: authentication required/)).toBeInTheDocument();
  });
});
