import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ModelPicker } from './ModelPicker';
import { ErrorLine, MagneticButton, StreamedText, TypingDots } from './ui';
import type { ChatMessage, PlaygroundModel } from './types';

/**
 * ChatPanel — staggered message entrances, typewriter streaming
 * for fresh assistant replies, pulsing typing indicator,
 * and an empty state with personality.
 */

interface ChatPanelProps {
  models: PlaygroundModel[];
  model: string;
  setModel: (id: string) => void;
  messages: ChatMessage[];
  sending: boolean;
  input: string;
  setInput: (v: string) => void;
  onSend: (e: FormEvent) => void;
  error: string | null;
  meta: string | null;
  connected: boolean;
}

export function ChatPanel({
  models,
  model,
  setModel,
  messages,
  sending,
  input,
  setInput,
  onSend,
  error,
  meta,
  connected,
}: ChatPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(messages.length);
  const [animateFrom, setAnimateFrom] = useState(messages.length);

  // Only messages added after mount get the entrance animation.
  useEffect(() => {
    if (messages.length > prevLen.current) {
      setAnimateFrom(prevLen.current);
    }
    prevLen.current = messages.length;
  }, [messages.length]);

  // Keep the latest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, sending]);

  const lastIdx = messages.length - 1;

  return (
    <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
      <div>
        <ModelPicker
          id="pg-chat-model"
          label="Model"
          models={models}
          value={model}
          onChange={setModel}
          disabled={!connected}
        />
        <p className="mt-4 text-sm leading-relaxed text-faint">
          Signed with your wallet on every send.{' '}
          <span className="font-mono text-muted">10 credits</span> per reply.
        </p>
        {meta && (
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-faint">
            {meta}
          </p>
        )}
      </div>

      <div className="border border-rule transition-colors hover:border-rule-strong">
        <div
          ref={listRef}
          aria-live="polite"
          aria-label="Chat messages"
          className="max-h-[440px] min-h-[300px] overflow-y-auto p-5 md:p-6"
        >
          {messages.length === 0 ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center gap-4 text-center">
              <span aria-hidden="true" className="pg-empty-spore" />
              <p className="font-serif text-xl italic text-muted">
                The flywheel is listening.
              </p>
              <p className="max-w-xs font-mono text-[12px] leading-relaxed text-faint">
                Ask anything — your first reply costs 10 credits.
              </p>
            </div>
          ) : (
            <ol className="space-y-4">
              {messages.map((m, i) => {
                const isUser = m.role === 'user';
                const animate = i >= animateFrom;
                const isStreaming = i === lastIdx && !isUser;
                return (
                  <li
                    key={i}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${
                      animate ? 'pg-msg-enter' : ''
                    }`}
                    style={
                      animate
                        ? { animationDelay: `${(i - animateFrom) * 90}ms` }
                        : undefined
                    }
                  >
                    <div
                      className={[
                        'max-w-[82%] px-4 py-3 text-sm leading-relaxed',
                        isUser
                          ? 'border border-moss/50 bg-moss/10 text-ink'
                          : 'border border-rule bg-transparent text-muted',
                      ].join(' ')}
                    >
                      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
                        {isUser ? 'You' : 'Model'}
                      </div>
                      {isStreaming ? (
                        <StreamedText
                          text={m.content}
                          className="whitespace-pre-wrap"
                        />
                      ) : (
                        <p className="whitespace-pre-wrap">{m.content}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {sending && (
            <div className="mt-4 flex items-center gap-3">
              <TypingDots />
              <span className="font-mono text-[12px] text-faint">
                Signing and sending…
              </span>
            </div>
          )}
        </div>

        <form onSubmit={onSend} className="border-t border-rule p-4">
          <div className="flex gap-3">
            <label htmlFor="pg-chat-input" className="sr-only">
              Message
            </label>
            <input
              id="pg-chat-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={sending || !connected || models.length === 0}
              placeholder="Type a message…"
              autoComplete="off"
              className="w-full border border-rule-strong bg-transparent px-4 py-3 text-sm text-ink transition-colors placeholder:text-faint focus:border-moss focus:outline-none disabled:opacity-50"
            />
            <MagneticButton
              type="submit"
              disabled={
                sending ||
                !connected ||
                models.length === 0 ||
                !input.trim()
              }
              className="shrink-0 border border-moss/70 px-5 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-moss hover:bg-moss/10 disabled:opacity-50"
            >
              {sending ? 'Sending' : 'Send'}
            </MagneticButton>
          </div>
          <ErrorLine message={error} />
        </form>
      </div>
    </div>
  );
}
