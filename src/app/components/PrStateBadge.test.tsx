// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrStateBadge } from './PrStateBadge';

describe('PrStateBadge', () => {
  it('renders a Merged badge with the merged icon', () => {
    const { container } = render(<PrStateBadge state="merged" />);

    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(container.querySelector('.lucide-git-merge')).toBeInTheDocument();
  });

  it('renders a Closed badge with the closed icon', () => {
    const { container } = render(<PrStateBadge state="closed" />);

    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(container.querySelector('.lucide-git-pull-request-closed')).toBeInTheDocument();
  });

  it('applies visually distinct classes for merged vs closed', () => {
    const { container: mergedContainer } = render(<PrStateBadge state="merged" />);
    const { container: closedContainer } = render(<PrStateBadge state="closed" />);

    expect(mergedContainer.firstChild).toHaveClass('from-[#A78BFA]');
    expect(closedContainer.firstChild).toHaveClass('bg-[#3F3F46]');
  });
});
