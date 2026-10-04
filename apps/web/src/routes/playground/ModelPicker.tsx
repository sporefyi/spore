import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlaygroundModel } from './types';

/**
 * ModelPicker — searchable dropdown replacing the raw <select>.
 * Essential with 224+ models: type to filter, arrow keys + enter to pick.
 */

interface ModelPickerProps {
  id: string;
  label: string;
  models: PlaygroundModel[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function ModelPicker({
  id,
  label,
  models,
  value,
  onChange,
  disabled,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = models.find((m) => m.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) =>
      `${m.name} ${m.id}`.toLowerCase().includes(q),
    );
  }, [models, query]);

  useEffect(() => {
    setHi(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHi(0);
      window.setTimeout(() => searchRef.current?.focus(), 40);
    }
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  // Keep the highlighted option in view while arrowing.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !open) return;
    const el = list.children[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [hi, open ]);

  const choose = (mid: string) => {
    onChange(mid);
    setOpen(false);
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = filtered[hi];
      if (m) choose(m.id);
    }
  };

  const empty = models.length === 0;

  return (
    <div ref={wrapRef} className="relative">
      <span
        id={`${id}-label`}
        className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint"
      >
        {label}
      </span>
      <button
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}`}
        disabled={disabled || empty}
        onClick={() => setOpen((o) => !o)}
        className="mt-2 flex w-full items-center justify-between gap-3 border border-rule-strong bg-bg px-3 py-2.5 text-left transition-colors hover:border-moss focus:border-moss focus:outline-none disabled:opacity-50"
      >
        <span className="truncate font-mono text-sm text-ink">
          {selected ? selected.name : empty ? 'No models yet' : 'Select model'}
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          <span className="font-mono text-[10px] text-faint tnum">
            {models.length}
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`h-3.5 w-3.5 text-faint transition-transform duration-300 ${
              open ? 'rotate-180' : ''
            }`}
          >
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && !empty && (
        <div className="pg-menu-in absolute z-30 mt-1.5 w-full border border-rule-strong bg-bg shadow-[0_18px_50px_rgba(0,0,0,0.55)]">
          <div className="border-b border-rule p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder={`Search ${models.length} models…`}
              aria-label="Search models"
              className="w-full bg-transparent px-2 py-1.5 font-mono text-sm text-ink placeholder:text-faint focus:outline-none"
            />
          </div>
          <ul
            ref={listRef}
            role="listbox"
            aria-labelledby={`${id}-label`}
            className="max-h-64 overflow-y-auto py-1"
          >
            {filtered.map((m, i) => {
              const isSel = m.id === value;
              return (
                <li
                  key={m.id}
                  role="option"
                  aria-selected={isSel}
                  onClick={() => choose(m.id)}
                  onMouseEnter={() => setHi(i)}
                  className={[
                    'cursor-pointer px-3 py-2 transition-colors',
                    i === hi ? 'bg-moss/10' : '',
                    isSel ? 'border-l-2 border-moss' : 'border-l-2 border-transparent',
                  ].join(' ')}
                >
                  <div className="truncate font-mono text-[13px] text-ink">
                    {m.name}
                  </div>
                  {m.name !== m.id && (
                    <div className="truncate font-mono text-[11px] text-faint">
                      {m.id}
                    </div>
                  )}
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-4 font-mono text-[12px] text-faint">
                No models match “{query}”.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
