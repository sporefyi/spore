import { Link, NavLink } from "react-router-dom";
import { PRIMARY_CHAIN } from "../chains";
import { NavSpore } from "./NavSpore";

const NAV_LINKS: ReadonlyArray<{ label: string; to: string; end?: boolean }> = [
  { label: "Agents", to: "/agents" },
  { label: "Leaderboard", to: "/leaderboard" },
  { label: "Markets", to: "/market" },
  { label: "Network", to: "/#ledger" },
  { label: "Protocol", to: "/protocol" },
  { label: "Contracts", to: "/contracts" },
  { label: "Playground", to: "/playground" },
  { label: "GPU", to: "/gpu" },
];

const FOOTER_COLUMNS: ReadonlyArray<{
  title: string;
  links: ReadonlyArray<{ label: string; to: string }>;
}> = [
  {
    title: "Agents",
    links: [
      { label: "Registry", to: "/agents" },
      { label: "Passports", to: "/agents" },
    ],
  },
  {
    title: "Credit",
    links: [{ label: "Market", to: "/market" }],
  },
  {
    title: "Protocol",
    links: [
      { label: "Overview", to: "/protocol" },
      { label: "Specification", to: "/protocol" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", to: "/developers" },
      { label: "Connect", to: "/connect" },
    ],
  },
];

const monoLabel = "font-mono text-[12px] uppercase tracking-widest";

function SporeMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 7 7"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {/* cap */}
      <rect x="2" y="0" width="3" height="1" fill="var(--moss)" />
      <rect x="1" y="1" width="5" height="1" fill="var(--moss)" />
      <rect x="0" y="2" width="7" height="1" fill="var(--moss)" />
      {/* gills */}
      <rect x="0" y="3" width="7" height="1" fill="var(--fungal)" />
      {/* stem */}
      <rect x="2" y="4" width="3" height="1" fill="var(--ink)" />
      <rect x="3" y="5" width="1" height="1" fill="var(--ink)" />
      <rect x="2" y="6" width="3" height="1" fill="var(--ink)" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z" />
    </svg>
  );
}

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return [
    monoLabel,
    "whitespace-nowrap transition-colors hover:text-ink",
    isActive ? "text-ink" : "text-muted",
  ].join(" ");
}

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-rule bg-bg">
      <div className="mx-auto flex max-w-6xl flex-nowrap items-center gap-x-5 px-6 py-3">
        <Link to="/" className="flex shrink-0 items-center gap-3 text-ink">
          <SporeMark />
          <span className="font-mono text-[13px] uppercase tracking-widest text-ink">
            SPORE
          </span>
        </Link>

        <nav
          aria-label="Primary"
          className="flex min-w-0 flex-1 items-center gap-5 overflow-x-auto"
        >
          {NAV_LINKS.map((l) => (
            <NavLink
              key={l.label}
              to={l.to}
              end={l.end}
              className={navLinkClass}
            >
              {l.label === "Playground" ? (
                <span className="inline-flex items-center gap-1.5">
                  <NavSpore size={20} />
                  {l.label}
                </span>
              ) : (
                l.label
              )}
            </NavLink>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-faint xl:inline">
            {PRIMARY_CHAIN.chainId}
          </span>
          <a
            href="https://robinhoodchain.blockscout.com/token/0xa5127fae2d0986a4cb6619b9c4ec53461726454b"
            target="_blank"
            rel="noreferrer"
            title="$SPORE · 0xa5127fae2d0986a4cb6619b9c4ec53461726454b"
            className="spore-glow rounded-full border border-fungal/60 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-fungal"
          >
            $SPORE
          </a>
          <a
            href={PRIMARY_CHAIN.explorerUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Explorer"
            className="hidden font-mono text-[11px] uppercase tracking-[0.18em] text-faint underline underline-offset-4 hover:text-muted md:inline"
          >
            explorer
          </a>
          <NavLink
            to="/connect"
            className={({ isActive }) =>
              [
                monoLabel,
                "transition-colors hover:text-ink",
                isActive ? "text-ink" : "text-muted",
              ].join(" ")
            }
          >
            Connect
          </NavLink>
          <a
            href="https://x.com/SporeFyi"
            target="_blank"
            rel="noreferrer"
            aria-label="SPORE on X"
            className="text-muted transition-colors hover:text-ink"
          >
            <XIcon />
          </a>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-rule bg-bg">
      <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <div>
          <div className="display text-4xl text-ink md:text-6xl">
            SPORE
          </div>
          <p className="mt-4 text-muted">
            Credit infrastructure for autonomous agents.
          </p>
        </div>

        <div className="mt-16 grid grid-cols-2 gap-10 md:mt-24 md:grid-cols-4">
          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <div className={`${monoLabel} text-faint`}>{col.title}</div>
              <ul className="mt-4 space-y-2">
                {col.links.map((l) => (
                  <li key={`${col.title}-${l.label}`}>
                    <Link
                      to={l.to}
                      className="text-sm text-muted transition-colors hover:text-ink"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-16 grid gap-8 md:mt-24 md:grid-cols-2">
          <div>
            <div className={`${monoLabel} text-faint`}>Protocol status</div>
            <dl className="mt-4 space-y-2 font-mono text-[12px] uppercase tracking-widest text-muted">
              <div className="flex gap-3">
                <dt className="text-faint">Contracts:</dt>
                <dd className="space-y-1 normal-case">
                  {(
                    [
                      ['Registry', PRIMARY_CHAIN.contracts.registry],
                      ['CreditManager', PRIMARY_CHAIN.contracts.creditManager],
                      ['BackerVault', PRIMARY_CHAIN.contracts.backerVault],
                      ['ScoreOracle', PRIMARY_CHAIN.contracts.scoreOracle],
                      ['FeeRouter', PRIMARY_CHAIN.contracts.feeRouter],
                    ] as const
                  ).map(([label, address]) => (
                    <div key={label} className="flex gap-2">
                      <span className="text-faint">{label}</span>
                      {address ? (
                        <a
                          href={`${PRIMARY_CHAIN.explorerUrl}/address/${address}`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-4 hover:text-ink"
                        >
                          {`${address.slice(0, 6)}…${address.slice(-4)}`}
                        </a>
                      ) : (
                        <span>—</span>
                      )}
                    </div>
                  ))}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-faint">Chain:</dt>
                <dd>
                  {PRIMARY_CHAIN.name} ({PRIMARY_CHAIN.chainId})
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-faint">Explorer:</dt>
                <dd>
                  <a
                    href={PRIMARY_CHAIN.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4 hover:text-ink"
                  >
                    Blockscout
                  </a>
                </dd>
              </div>
            </dl>
          </div>

          <div className="border-t border-rule pt-5">
            <div className={`${monoLabel} text-fungal`}>
              Experimental protocol
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              SPORE is an unaudited experimental credit protocol. Contracts
              are deployed on Robinhood Chain. Do not commit funds you cannot
              afford to lose.
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-rule">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-5 md:flex-row md:items-center md:justify-between">
          <span className="font-mono text-[12px] uppercase tracking-widest text-muted">
            © 2026 SPORE
          </span>
          <span className="font-mono text-[12px] tracking-widest text-faint">
            An independent continuation of{' '}
            <a
              href="https://priors.trade"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-muted"
            >
              Priors
            </a>{' '}
            — not a fork. ·{' '}
            <a
              href="https://robinhoodchain.blockscout.com/address/0x6902670409c4FA3a75C39A734c69beAEEBcF9729"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-muted"
            >
              Contracts deployed
            </a>
            {' '}·{' '}
            <a
              href="https://x.com/SporeFyi"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-muted"
            >
              𝕏 @SporeFyi
            </a>
            {' '}·{' '}
            <a
              href="https://github.com/sporefyi/spore"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-muted"
            >
              GitHub
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
