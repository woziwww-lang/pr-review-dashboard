// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityBadge } from './SeverityBadge';

describe('SeverityBadge', () => {
  it.each(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const)('renders %s', (severity) => {
    render(<SeverityBadge severity={severity} />);
    expect(screen.getByText(severity)).toBeInTheDocument();
  });
});
