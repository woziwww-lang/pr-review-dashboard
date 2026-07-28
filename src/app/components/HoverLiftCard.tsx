'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

// Literal shadow strings mirroring globals.css's --glass-shadow /
// --glass-shadow-hover / --accent-glow values - kept as plain strings
// (not var(...)) because gsap needs concrete, interpolatable box-shadow
// values on both ends of the tween. HOVER_SHADOW layers the accent glow
// (spec: "a subtle accent glow ... to HoverLiftCard's hover box-shadow")
// as a second comma-separated shadow alongside the lifted glass shadow.
// Keep these in sync if globals.css's corresponding tokens change.
const RESTING_SHADOW = '0 8px 24px rgba(0, 0, 0, 0.3)';
const HOVER_SHADOW = '0 12px 32px rgba(0, 0, 0, 0.4), 0 0 12px rgba(59, 130, 246, 0.4)';

export function HoverLiftCard({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const setY = gsap.quickTo(el, 'y', { duration: 0.25, ease: 'power2.out' });
    // GSAP's quickTo .d.ts only types setters as numeric, even though string CSS properties like boxShadow work at runtime.
    const setShadow = gsap.quickTo(el, 'boxShadow', { duration: 0.25, ease: 'power2.out' }) as unknown as (
      value: string
    ) => gsap.core.Tween;

    const handleEnter = () => {
      setY(-4);
      setShadow(HOVER_SHADOW);
    };
    const handleLeave = () => {
      setY(0);
      setShadow(RESTING_SHADOW);
    };

    el.addEventListener('mouseenter', handleEnter);
    el.addEventListener('mouseleave', handleLeave);
    return () => {
      el.removeEventListener('mouseenter', handleEnter);
      el.removeEventListener('mouseleave', handleLeave);
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
