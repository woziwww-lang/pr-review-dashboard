// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StaggerReveal } from './StaggerReveal';

const fromMock = vi.fn();
const killMock = vi.fn();
const setMock = vi.fn();

vi.mock('gsap', () => ({
  gsap: {
    from: (...args: unknown[]) => {
      fromMock(...args);
      return { kill: killMock };
    },
    set: (...args: unknown[]) => setMock(...args),
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

describe('StaggerReveal', () => {
  beforeEach(() => {
    fromMock.mockClear();
    killMock.mockClear();
    setMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all children', () => {
    mockMatchMedia(false);
    render(
      <StaggerReveal>
        <div>first</div>
        <div>second</div>
      </StaggerReveal>
    );
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('calls gsap.from with the documented tween parameters when motion is allowed', () => {
    mockMatchMedia(false);
    render(
      <StaggerReveal>
        <div>first</div>
        <div>second</div>
      </StaggerReveal>
    );
    expect(fromMock).toHaveBeenCalledTimes(1);
    const [, vars] = fromMock.mock.calls[0];
    expect(vars).toMatchObject({ opacity: 0, y: 8, duration: 0.35, ease: 'power1.out', stagger: 0.05 });
  });

  it('does not call gsap.from when prefers-reduced-motion is set', () => {
    mockMatchMedia(true);
    render(
      <StaggerReveal>
        <div>first</div>
      </StaggerReveal>
    );
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('kills the tween and clears inline styles on unmount', () => {
    mockMatchMedia(false);
    const { unmount } = render(
      <StaggerReveal>
        <div>first</div>
        <div>second</div>
      </StaggerReveal>
    );
    setMock.mockClear();
    unmount();
    expect(killMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(expect.anything(), { clearProps: 'opacity,transform' });
  });

  it('force-clears inline styles via the safety-net timer if the tween never unmounts or completes', () => {
    vi.useFakeTimers();
    mockMatchMedia(false);
    render(
      <StaggerReveal>
        <div>first</div>
        <div>second</div>
      </StaggerReveal>
    );
    setMock.mockClear();
    expect(setMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(setMock).toHaveBeenCalledWith(expect.anything(), { clearProps: 'opacity,transform' });
    vi.useRealTimers();
  });
});
