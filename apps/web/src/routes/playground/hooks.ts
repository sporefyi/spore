import { useCallback, useEffect, useRef, useState } from 'react';

/** True when the user prefers reduced motion. Reactive to changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Animated count-up. Returns the display value; animates from `from` to
 * `value` over `duration`ms with ease-out cubic. Under reduced motion the
 * value snaps immediately. Formats with toLocaleString.
 */
export function useCountUp(value: number | null, duration = 900): string {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState<number>(value ?? 0);
  const fromRef = useRef<number>(value ?? 0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (value === null) return;
    const from = fromRef.current;
    if (from === value || reduced) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (value - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration, reduced]);

  if (value === null) return '—';
  return Math.round(display).toLocaleString();
}

/**
 * IntersectionObserver visibility hook — true once the element enters
 * the viewport (once, not toggled). Returns a callback ref.
 */
export function useInView<T extends HTMLElement>(
  threshold = 0.15,
): [(instance: T | null) => void, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  const setRef = useCallback(
    (instance: T | null) => {
      ref.current = instance;
    },
    [],
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            obs.disconnect();
            break;
          }
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [setRef, inView];
}
