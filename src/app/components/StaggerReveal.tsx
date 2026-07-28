'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

export function StaggerReveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.from(el.children, { opacity: 0, y: 8, duration: 0.35, ease: 'power1.out', stagger: 0.05 });
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
