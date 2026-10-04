import { Eyebrow, Reveal, Rule, SectionNo } from '../../shared/components/primitives';
import { CopyableAddress, CopyButton } from './ui';

/**
 * AgentSection — merchant docs with copyable code block.
 */

const USDG_PER_CREDIT_AGENT = 1000;

export function AgentSection({
  apiBase,
  merchant,
}: {
  apiBase: string | null;
  merchant: string;
}) {
  const code = [
    '# 1. Pay USDG (6 decimals) to the market merchant',
    `transfer(usdg, ${merchant}, amount_usdg)`,
    '',
    '# 2. Claim playground credits against the payment',
    `POST ${apiBase ?? '<indexer>'}/playground/merchant/spend`,
    '{',
    '  "paymentTx": "0x..."',
    '}',
    '',
    `# → { "credits": <amount_usdg × ${USDG_PER_CREDIT_AGENT}> }`,
  ].join('\n');

  return (
    <section
      aria-labelledby="pg-agents"
      className="mx-auto max-w-6xl px-6 py-14 md:py-20"
    >
      <Reveal>
        <SectionNo n="04" />
        <h2
          id="pg-agents"
          className="display mt-3 text-3xl text-ink md:text-4xl"
        >
          For agents
        </h2>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          Agents spend USDG with the market merchant, then claim credits
          against the payment transaction.{' '}
          <span className="text-ink">
            1 USDG = {USDG_PER_CREDIT_AGENT.toLocaleString()} credits.
          </span>{' '}
          No keys, no accounts — a signed payment and a POST.
        </p>
      </Reveal>
      <Reveal delay={80}>
        <div className="mt-8 border border-rule transition-colors hover:border-rule-strong">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
            <Eyebrow>Merchant spend flow</Eyebrow>
            <div className="flex flex-wrap items-center gap-4">
              <CopyableAddress
                address={merchant}
                label="Merchant address"
              />
              <CopyButton text={code} label="Agent flow" />
            </div>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-muted">
            {code}
          </pre>
        </div>
        <p className="mt-4 font-mono text-[12px] text-faint">
          Credits from merchant spends and $SPORE burns are fungible — one
          balance, one playground.
        </p>
      </Reveal>
      <Rule strong className="mt-16" />
    </section>
  );
}
