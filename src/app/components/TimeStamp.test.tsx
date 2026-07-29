// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimeStamp } from './TimeStamp';

describe('TimeStamp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an em-dash placeholder when iso is null', () => {
    render(<TimeStamp iso={null} label="Last reviewed" />);
    expect(screen.getByText('Last reviewed')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders the relative time and exposes the absolute Tokyo time as a tooltip', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T02:00:00.000Z'));
    render(<TimeStamp iso="2026-07-29T01:47:00.000Z" label="Last reviewed" />);

    expect(screen.getByText('Last reviewed')).toBeInTheDocument();
    const timeEl = screen.getByText('13 minutes ago');
    expect(timeEl).toBeInTheDocument();
    expect(timeEl).toHaveAttribute('title', '2026/07/29 10:47 JST');
    expect(timeEl).toHaveAttribute('dateTime', '2026-07-29T01:47:00.000Z');
  });

  it('renders without a label when none is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T02:00:10.000Z'));
    render(<TimeStamp iso="2026-07-29T02:00:00.000Z" />);
    expect(screen.getByText('just now')).toBeInTheDocument();
  });
});
