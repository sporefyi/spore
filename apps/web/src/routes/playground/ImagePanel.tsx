import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ModelPicker } from './ModelPicker';
import {
  ErrorLine,
  MagneticButton,
  SuccessLine,
} from './ui';
import type { PlaygroundModel } from './types';

/**
 * ImagePanel — shimmer + floating spore dots while dreaming,
 * staggered hover-lift reveal for finished images.
 */

const IMAGE_COST_CREDITS = 50;

interface ImagePanelProps {
  models: PlaygroundModel[];
  model: string;
  setModel: (id: string) => void;
  prompt: string;
  setPrompt: (v: string) => void;
  onGenerate: (e: FormEvent) => void;
  generating: boolean;
  error: string | null;
  ok: string | null;
  images: string[];
  connected: boolean;
}

export function ImagePanel({
  models,
  model,
  setModel,
  prompt,
  setPrompt,
  onGenerate,
  generating,
  error,
  ok,
  images,
  connected,
}: ImagePanelProps) {
  const prevLen = useRef(images.length);
  const [animateFrom, setAnimateFrom] = useState(images.length);

  useEffect(() => {
    if (images.length > prevLen.current) {
      setAnimateFrom(prevLen.current);
    }
    prevLen.current = images.length;
  }, [images.length]);

  return (
    <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
      <div>
        <ModelPicker
          id="pg-image-model"
          label="Model"
          models={models}
          value={model}
          onChange={setModel}
          disabled={!connected}
        />
        <p className="mt-4 text-sm leading-relaxed text-faint">
          <span className="font-mono text-ink">
            {IMAGE_COST_CREDITS} credits
          </span>{' '}
          per image. Signed with your wallet on every generation.
        </p>
      </div>

      <div>
        <form onSubmit={onGenerate} className="flex gap-3">
          <label htmlFor="pg-image-prompt" className="sr-only">
            Image prompt
          </label>
          <input
            id="pg-image-prompt"
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={generating || !connected || models.length === 0}
            placeholder="A mushroom city at dusk, mycelium streets…"
            autoComplete="off"
            className="w-full border border-rule-strong bg-transparent px-4 py-3 text-sm text-ink transition-colors placeholder:text-faint focus:border-moss focus:outline-none disabled:opacity-50"
          />
          <MagneticButton
            type="submit"
            disabled={
              generating ||
              !connected ||
              models.length === 0 ||
              !prompt.trim()
            }
            className="shrink-0 border border-moss/70 px-5 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-moss hover:bg-moss/10 disabled:opacity-50"
          >
            {generating ? 'Dreaming' : 'Generate'}
          </MagneticButton>
        </form>
        <ErrorLine message={error} />
        <SuccessLine message={ok} />

        {generating && (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div
              role="status"
              aria-label="Generating image"
              className="relative aspect-square overflow-hidden border border-rule"
            >
              <div aria-hidden="true" className="pg-shimmer absolute inset-0" />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
                <div aria-hidden="true" className="flex gap-2.5">
                  <span
                    className="pg-float-dot"
                    style={{ animationDelay: '0ms' }}
                  />
                  <span
                    className="pg-float-dot"
                    style={{ animationDelay: '180ms' }}
                  />
                  <span
                    className="pg-float-dot"
                    style={{ animationDelay: '360ms' }}
                  />
                </div>
                <p className="font-mono text-[12px] text-faint">
                  Dreaming pixels…
                </p>
              </div>
            </div>
          </div>
        )}

        {images.length > 0 ? (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {images.map((src, i) => {
              const animate = i >= animateFrom;
              return (
                <figure
                  key={`${i}-${src.slice(-24)}`}
                  className={[
                    'group border border-rule bg-bg p-2 transition-all duration-300',
                    'hover:-translate-y-1 hover:border-rule-strong hover:shadow-[0_14px_44px_rgba(0,0,0,0.5)]',
                    animate ? 'pg-img-enter' : '',
                  ].join(' ')}
                  style={
                    animate
                      ? { animationDelay: `${(i - animateFrom) * 80}ms` }
                      : undefined
                  }
                >
                  <img
                    src={src}
                    alt={`Generated image ${i + 1}`}
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                </figure>
              );
            })}
          </div>
        ) : (
          !generating && (
            <p className="mt-6 font-mono text-[12px] text-faint">
              Nothing generated yet this session.
            </p>
          )
        )}
      </div>
    </div>
  );
}
