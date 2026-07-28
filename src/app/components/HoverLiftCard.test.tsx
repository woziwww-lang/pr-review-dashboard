// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HoverLiftCard } from './HoverLiftCard';

const quickToMock = vi.fn(() => vi.fn());

vi.mock('gsap', () => ({
  gsap: {
    quickTo: (...args: unknown[]) => quickToMock(...args),
  },
}));

function mockMatchMedia(reduceMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduceMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('HoverLiftCard', () => {
  beforeEach(() => {
    quickToMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its children', () => {
    mockMatchMedia(false);
    render(
      <HoverLiftCard>
        <div>card content</div>
      </HoverLiftCard>
    );
    expect(screen.getByText('card content')).toBeInTheDocument();
  });

  it('sets up quickTo tweens for y and boxShadow with the documented duration/ease', () => {
    mockMatchMedia(false);
    render(
      <HoverLiftCard>
        <div>card content</div>
      </HoverLiftCard>
    );
    const yCall = quickToMock.mock.calls.find((call) => call[1] === 'y');
    const shadowCall = quickToMock.mock.calls.find((call) => call[1] === 'boxShadow');
    expect(yCall?.[2]).toMatchObject({ duration: 0.25, ease: 'power2.out' });
    expect(shadowCall?.[2]).toMatchObject({ duration: 0.25, ease: 'power2.out' });
  });

  it('does not call gsap.quickTo when prefers-reduced-motion is set', () => {
    mockMatchMedia(true);
    render(
      <HoverLiftCard>
        <div>card content</div>
      </HoverLiftCard>
    );
    expect(quickToMock).not.toHaveBeenCalled();
  });

  it('tweens to the lifted position and hover+glow shadow on mouseenter, and back to resting on mouseleave', () => {
    mockMatchMedia(false);
    const setY = vi.fn();
    const setShadow = vi.fn();
    quickToMock.mockImplementation((_el: unknown, prop: string) => (prop === 'y' ? setY : setShadow));
    render(
      <HoverLiftCard>
        <div>card content</div>
      </HoverLiftCard>
    );
    const wrapper = screen.getByText('card content').parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(setY).toHaveBeenCalledWith(-4);
    expect(setShadow).toHaveBeenCalledWith('0 12px 32px rgba(0, 0, 0, 0.4), 0 0 12px rgba(59, 130, 246, 0.4)');

    fireEvent.mouseLeave(wrapper);
    expect(setY).toHaveBeenCalledWith(0);
    expect(setShadow).toHaveBeenCalledWith('0 8px 24px rgba(0, 0, 0, 0.3)');
  });
});
