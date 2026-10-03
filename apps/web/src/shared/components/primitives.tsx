import React, { useEffect, useRef } from 'react';
import { isDemo } from '../data/providers';

function cx(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* Typographic primitives                                              */
/* ------------------------------------------------------------------ */

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cx('eyebrow', className)}>{children}</span>;
}

export function Rule({
  strong,
  className,
}: {
  strong?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        'border-t',
        strong ? 'border-rule-strong' : 'border-rule',
        className,
      )}
    />
  );
}

export function SectionNo({
  n,
  className,
}: {
  n: string | number;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'font-serif italic text-xl md:text-2xl text-moss',
        className,
      )}
    >
      No. {n}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Stat                                                                */
/* ------------------------------------------------------------------ */

const ACCENT_CLASS: Record<'moss' | 'fungal' | 'ember', string> = {
  moss: 'text-moss',
  fungal: 'text-fungal',
  ember: 'text-ember',
};

export function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  accent?: 'moss' | 'fungal' | 'ember';
}) {
  return (
    <div className="border-t border-rule pt-4">
      <div className="eyebrow">{label}</div>
      <div
        className={cx(
          'font-serif tnum text-2xl mt-2',
          accent ? ACCENT_CLASS[accent] : 'text-ink',
        )}
      >
        {value}
      </div>
      {hint ? <div className="text-sm text-faint mt-1">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reveal                                                              */
/* ------------------------------------------------------------------ */

export function Reveal({
  children,
  className,
  delay,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-visible');
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add('is-visible');
            observer.disconnect();
            break;
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cx('reveal', className)}
      style={delay !== undefined ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data states                                                         */
/* ------------------------------------------------------------------ */

export function LoadingState({ label = 'Reading…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 py-4 text-sm text-muted"
    >
      <span aria-hidden="true" className="h-2 w-2 bg-moss motion-safe:animate-pulse" />
      <span>{label}</span>
    </div>
  );
}

export function UnavailableState({
  title = 'Protocol module not yet activated',
  copy = 'The contracts for this module are not deployed on the connected network, so there is nothing to read yet. No placeholder values are shown in their place.',
}: {
  title?: string;
  copy?: string;
}) {
  return (
    <div className="border border-rule p-5">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        {title}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{copy}</p>
    </div>
  );
}

export function EmptyState({
  title = 'Nothing recorded yet',
  copy = 'No on-chain records exist for this view.',
}: {
  title?: string;
  copy?: string;
}) {
  return (
    <div className="py-6">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
        {title}
      </div>
      <p className="mt-2 text-sm text-muted">{copy}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LedgerTable                                                         */
/* ------------------------------------------------------------------ */

export interface LedgerColumn<T> {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  render: (row: T) => React.ReactNode;
}

const ALIGN_CLASS: Record<'left' | 'right' | 'center', string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function LedgerTable<T,>({
  columns,
  rows,
  keyOf,
  emptyTitle,
  emptyCopy,
}: {
  columns: LedgerColumn<T>[];
  rows: T[];
  keyOf: (row: T, i: number) => string;
  emptyTitle?: string;
  emptyCopy?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} copy={emptyCopy} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cx(
                  'border-b border-rule-strong pb-3 font-normal',
                  ALIGN_CLASS[col.align ?? 'left'],
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={keyOf(row, i)}
              className="border-b border-rule hover:bg-ink/[0.03] transition-colors"
            >
              {columns.map((col, ci) => (
                <td
                  key={col.key}
                  className={cx(
                    'py-3.5',
                    ci === 0 ? 'text-ink' : 'text-muted',
                    col.mono && 'font-mono tnum',
                    ALIGN_CLASS[col.align ?? 'left'],
                  )}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DemoBadge                                                           */
/* ------------------------------------------------------------------ */

export function DemoBadge() {
  if (!isDemo) return null;
  return (
    <span className="border border-rule px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest text-muted">
      Demo data
    </span>
  );
}
