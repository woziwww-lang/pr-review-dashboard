// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityDonut } from './SeverityDonut';

describe('SeverityDonut', () => {
  it('renders a conic-gradient ring reflecting the given proportions', () => {
    const { container } = render(
      <SeverityDonut summary={{ critical: 1, high: 1, medium: 1, low: 1, total: 4, reviewedCount: 1 }} />
    );
    const ring = container.querySelector('[data-testid="severity-donut-ring"]') as HTMLElement;
    expect(ring.style.backgroundImage).toContain('conic-gradient');
  });

  it('computes cumulative degree stops in Critical -> High -> Medium -> Low order', () => {
    // 4 equal quarters of 360deg: 0-90, 90-180, 180-270, 270-360.
    const { container } = render(
      <SeverityDonut summary={{ critical: 1, high: 1, medium: 1, low: 1, total: 4, reviewedCount: 1 }} />
    );
    const ring = container.querySelector('[data-testid="severity-donut-ring"]') as HTMLElement;
    const gradient = ring.style.backgroundImage;
    expect(gradient).toContain('var(--severity-critical) 0deg 90deg');
    expect(gradient).toContain('var(--severity-high) 90deg 180deg');
    expect(gradient).toContain('var(--severity-medium) 180deg 270deg');
    expect(gradient).toContain('var(--severity-low) 270deg 360deg');
  });

  it('skips a zero-count severity segment entirely rather than emitting a 0deg-wide stop', () => {
    // critical=0 (skipped), high=10 (0-360deg, the only segment).
    const { container } = render(
      <SeverityDonut summary={{ critical: 0, high: 10, medium: 0, low: 0, total: 10, reviewedCount: 1 }} />
    );
    const ring = container.querySelector('[data-testid="severity-donut-ring"]') as HTMLElement;
    const gradient = ring.style.backgroundImage;
    expect(gradient).not.toContain('var(--severity-critical)');
    expect(gradient).toContain('var(--severity-high) 0deg 360deg');
  });

  it('shows "Not yet reviewed" in the center when reviewedCount is 0', () => {
    render(<SeverityDonut summary={{ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 0 }} />);
    expect(screen.getByText(/not yet reviewed/i)).toBeInTheDocument();
  });

  it('shows "0 findings" in the center when reviewedCount is 1 but total is 0', () => {
    render(<SeverityDonut summary={{ critical: 0, high: 0, medium: 0, low: 0, total: 0, reviewedCount: 1 }} />);
    expect(screen.getByText(/0 findings/i)).toBeInTheDocument();
  });
});
