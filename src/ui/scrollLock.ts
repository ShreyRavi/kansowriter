import { useEffect } from 'react';

/**
 * While an overlay (palette, drafts sidebar, send panel) is open, the draft behind it never
 * scrolls: wheel and touch over the overlay or its transparent backdrop stay put, and a list
 * that reaches its end doesn't hand the scroll on (overscroll-behavior: contain in styles.css).
 * The scroll position is kept; the previous overflow comes back on close.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous;
    };
  }, [active]);
}
