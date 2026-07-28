// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeveritySummaryBar } from './SeveritySummaryBar';

describe('SeveritySummaryBar', () => {
  it('shows the per-severity legend counts for a populated summary', () => {
    render(
      <SeveritySummaryBar summary={{ critical: 3, high: 5, medium: 8, low: 4, total: 20, reviewedCount: 6 }} />
    );
    expect(screen.getByText(/critical 3/i)).toBeInTheDocument();
    expect(screen.getByText(/high 5/i)).toBeInTheDocument();
    expect(screen.getByText(/medium 8/i)).toBeInTheDocument();
    expect(screen.getByText(/low 4/i)).toBeInTheDocument();
  });

  it('renders each segment with a flex-basis proportional to its share of the total', () => {
    const { container } = render(
      <SeveritySummaryBar summary={{ critical: 5, high: 5, medium: 5, low: 5, total: 20, reviewedCount: 4 }} />
    );
    const critical = container.querySelector('[data-testid="severity-segment-critical"]') as HTMLElement;
    const high = container.querySelector('[data-testid="severity-segment-high"]') as HTMLElement;
    expect(critical.style.flexBasis).toBe('25%');
    expect(high.style.flexBasis).toBe('25%');
  });

  it('omits a segment entirely when its count is 0', () => {
    const { container } = render(
      <SeveritySummaryBar summary={{ critical: 0, high: 10, medium: 0, low: 0, total: 10, reviewedCount: 1 }} />
    );
    expect(container.querySelector('[data-testid="severity-segment-critical"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="severity-segment-high"]')).toBeInTheDocument();
  });

  it('shows "No reviewed data yet" when reviewedCount is 0', () => {
    render(<SeveritySummaryBar summary={{ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 0 }} />);
    expect(screen.getByText(/no reviewed data yet/i)).toBeInTheDocument();
  });

  it('shows a clean-result message when reviewedCount is positive but total is 0', () => {
    render(<SeveritySummaryBar summary={{ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 3 }} />);
    expect(screen.getByText(/no findings across 3 reviewed prs/i)).toBeInTheDocument();
  });
});
