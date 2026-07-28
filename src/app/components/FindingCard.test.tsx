// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingCard } from './FindingCard';

describe('FindingCard', () => {
  it('renders all finding fields', () => {
    render(
      <FindingCard
        finding={{
          file: 'src/a.ts',
          line: 10,
          severity: 'CRITICAL',
          summary: 'Missing null check',
          failureScenario: 'Crashes when input is null',
          evidence: 'a.ts:10',
          fixSuggestion: 'Add a null guard',
          codeSnippet: 'if (!x) return;',
        }}
      />
    );
    expect(screen.getByText('Missing null check')).toBeInTheDocument();
    expect(screen.getByText(/src\/a.ts:10/)).toBeInTheDocument();
    expect(screen.getByText('Crashes when input is null')).toBeInTheDocument();
    expect(screen.getByText('Add a null guard')).toBeInTheDocument();
    expect(screen.getByText('if (!x) return;')).toBeInTheDocument();
  });
});
