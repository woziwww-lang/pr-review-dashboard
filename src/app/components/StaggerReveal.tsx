'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

export function StaggerReveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const targets = el.children;
    const tween = gsap.from(targets, { opacity: 0, y: 8, duration: 0.35, ease: 'power1.out', stagger: 0.05 });
    const maxStaggerDelay = Math.max(0, targets.length - 1) * 0.05;
    const safetyNetMs = (0.35 + maxStaggerDelay + 0.2) * 1000;
    const safetyNetId = setTimeout(() => {
      gsap.set(targets, { clearProps: 'opacity,transform' });
    }, safetyNetMs);

    return () => {
      clearTimeout(safetyNetId);
      tween.kill();
      gsap.set(targets, { clearProps: 'opacity,transform' });
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
