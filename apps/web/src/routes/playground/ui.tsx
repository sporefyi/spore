import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { useReducedMotion } from './hooks';

/* ------------------------------------------------------------------ */
/* clipboard                                                          */
/* ------------------------------------------------------------------ */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* MagneticButton — pulls gently toward the cursor                    */
/* ------------------------------------------------------------------ */

export function MagneticButton({
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion();
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      className={`pg-magnetic ${className}`}
      onMouseMove={(e) => {
        const el = ref.current;
        if (!el || reduced) return;
        const r = el.getBoundingClientRect();
        const x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        el.style.transform = `translate(${(x * 6).toFixed(1)}px, ${(y * 5).toFixed(1)}px)`;
      }}
      onMouseLeave={() => {
        const el = ref.current;
        if (el) el.style.transform = '';
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* CopyButton — bordered copy with COPIED feedback                    */
/* ------------------------------------------------------------------ */

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void copyText(text).then((ok) => {
          setCopied(ok);
          if (ok) window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="shrink-0 border border-rule-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-faint transition-colors hover:border-moss hover:text-moss"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function CopyableAddress({
  address,
  label,
}: {
  address: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-2">
      <code
        title={address}
        className="block truncate font-mono text-[13px] text-ink select-all"
        aria-label={label}
      >
        {address}
      </code>
      <button
        type="button"
        onClick={() => {
          void copyText(address).then((ok) => {
            setCopied(ok);
            if (ok) window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] text-faint transition-colors hover:text-moss"
        aria-label={`Copy ${label}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* TypingDots — three pulsing moss dots                               */
/* ------------------------------------------------------------------ */

export function TypingDots() {
  return (
    <span aria-hidden="true" className="pg-typing-dots">
      <i />
      <i />
      <i />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* StreamedText — typewriter reveal for assistant replies             */
/* ------------------------------------------------------------------ */

export function StreamedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (reduced || text.length === 0) {
      setN(text.length);
      return;
    }
    setN(0);
    let i = 0;
    const id = window.setInterval(() => {
      i += 5;
      if (i >= text.length) {
        setN(text.length);
        window.clearInterval(id);
      } else {
        setN(i);
      }
    }, 14);
    return () => window.clearInterval(id);
  }, [text, reduced]);
  const done = n >= text.length;
  return (
    <span className={className}>
      {text.slice(0, n)}
      {!done && <span aria-hidden="true" className="pg-caret" />}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* ParticleBurst — ember burst fired by incrementing burstKey         */
/* ------------------------------------------------------------------ */

const BURST_COLORS = ['#8fae5a', '#d9772b', '#f0e9da'];

export function ParticleBurst({ burstKey }: { burstKey: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (burstKey === 0 || reduced) return;
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const r = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, r.width * dpr);
    canvas.height = Math.max(1, r.height * dpr);
    const parts = Array.from({ length: 52 }, () => ({
      x: r.width / 2,
      y: r.height * 0.62,
      vx: (Math.random() - 0.5) * 8,
      vy: -Math.random() * 8 - 2,
      life: 1,
      decay: 0.011 + Math.random() * 0.014,
      size: 1.5 + Math.random() * 3.2,
      color: BURST_COLORS[(Math.random() * BURST_COLORS.length) | 0],
    }));
    let raf = 0;
    const tick = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      let alive = false;
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.16;
        p.vx *= 0.985;
        p.life -= p.decay;
        if (p.life <= 0) continue;
        alive = true;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (alive) {
        raf = requestAnimationFrame(tick);
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [burstKey, reduced]);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}

/* ------------------------------------------------------------------ */
/* TxStepper — burn ceremony progress                                */
/* ------------------------------------------------------------------ */

const TX_STEPS = ['Signed', 'Confirmed on-chain', 'Credits granted'];

export function TxStepper({ step }: { step: number }) {
  if (step < 0) return null;
  return (
    <ol aria-label="Burn progress" className="mt-6 flex items-start">
      {TX_STEPS.map((label, i) => {
        const done = i < step || step >= TX_STEPS.length;
        const active = i === step && step < TX_STEPS.length;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className={[
                  'flex h-6 w-6 items-center justify-center rounded-full border font-mono text-[10px] transition-all duration-500',
                  done
                    ? 'border-moss bg-moss/15 text-moss'
                    : active
                      ? 'border-fungal text-fungal motion-safe:animate-pulse'
                      : 'border-rule text-faint',
                ].join(' ')}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={`font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-500 ${
                  done ? 'text-moss' : active ? 'text-ink' : 'text-faint'
                }`}
              >
                {label}
              </span>
            </div>
            {i < TX_STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className={`mx-3 h-px flex-1 transition-colors duration-500 ${
                  i < step ? 'bg-moss/60' : 'bg-rule'
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Notes                                                              */
/* ------------------------------------------------------------------ */

export function ApiNote({ children }: { children: ReactNode }) {
  return (
    <p className="border border-rule p-4 font-mono text-[12px] leading-relaxed text-muted">
      {children}
    </p>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mt-3 font-mono text-[12px] leading-relaxed text-ember"
    >
      {message}
    </p>
  );
}

export function SuccessLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="status"
      className="mt-3 font-mono text-[12px] leading-relaxed text-moss"
    >
      {message}
    </p>
  );
}
