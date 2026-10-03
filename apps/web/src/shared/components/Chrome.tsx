import { Link, NavLink } from "react-router-dom";
import { PRIMARY_CHAIN } from "../chains";

const NAV_LINKS: ReadonlyArray<{ label: string; to: string; end?: boolean }> = [
  { label: "Agents", to: "/agents" },
  { label: "Credit", to: "/market" },
  { label: "Network", to: "/#ledger" },
  { label: "Protocol", to: "/protocol" },
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
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-10 gap-y-3 px-6 py-4">
        <Link to="/" className="flex items-center gap-3 text-ink">
          <SporeMark />
          <span className="font-mono text-[13px] uppercase tracking-widest text-ink">
            SPORE
          </span>
        </Link>

        <nav
          aria-label="Primary"
          className="order-3 -mx-6 flex w-[calc(100%+3rem)] items-center gap-6 overflow-x-auto px-6 md:order-2 md:mx-0 md:w-auto md:flex-1 md:overflow-visible md:px-0"
        >
          {NAV_LINKS.map((l) => (
            <NavLink
              key={l.label}
              to={l.to}
              end={l.end}
              className={navLinkClass}
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <NavLink
          to="/connect"
          className={({ isActive }) =>
            [
              monoLabel,
              "order-2 transition-colors hover:text-ink md:order-3",
              isActive ? "text-ink" : "text-muted",
            ].join(" ")
          }
        >
          Connect
        </NavLink>
      </div>
      <div className="border-t border-rule">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-1 px-6 py-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
            {PRIMARY_CHAIN.name} · chain {PRIMARY_CHAIN.chainId}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
            credit protocol for agents · contracts not deployed
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
            explorer —
          </span>
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
                <dd>NOT YET DEPLOYED</dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-faint">Chain:</dt>
                <dd>
                  {PRIMARY_CHAIN.name} ({PRIMARY_CHAIN.chainId})
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-faint">Explorer:</dt>
                <dd>—</dd>
              </div>
            </dl>
          </div>

          <div className="border-t border-rule pt-5">
            <div className={`${monoLabel} text-fungal`}>
              Experimental protocol
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              SPORE is an unaudited experimental credit protocol. Contracts are
              not deployed. Do not commit funds.
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
            — not a fork. · No contracts deployed.
          </span>
        </div>
      </div>
    </footer>
  );
}
