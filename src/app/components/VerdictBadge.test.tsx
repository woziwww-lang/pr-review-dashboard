// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerdictBadge } from './VerdictBadge';

describe('VerdictBadge', () => {
  it('renders an approve badge', () => {
    render(<VerdictBadge verdict="approve" />);
    expect(screen.getByText(/approve/i)).toBeInTheDocument();
  });

  it('applies the accent glow shadow only to the approve badge', () => {
    const { container: approveContainer } = render(<VerdictBadge verdict="approve" />);
    expect(approveContainer.querySelector('.shadow-accent-glow')).toBeInTheDocument();

    const { container: needsFixContainer } = render(<VerdictBadge verdict="needs_fix" />);
    expect(needsFixContainer.querySelector('.shadow-accent-glow')).not.toBeInTheDocument();
  });

  it('renders a needs_fix badge', () => {
    render(<VerdictBadge verdict="needs_fix" />);
    expect(screen.getByText(/needs fix/i)).toBeInTheDocument();
  });

  it('renders a needs_review badge', () => {
    render(<VerdictBadge verdict="needs_review" />);
    expect(screen.getByText(/needs review/i)).toBeInTheDocument();
  });

  it('renders a failed badge distinct from any verdict', () => {
    render(<VerdictBadge verdict="failed" />);
    expect(screen.getByText(/review failed/i)).toBeInTheDocument();
  });
});
