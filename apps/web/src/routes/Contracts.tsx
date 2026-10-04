import { useState } from 'react';
import { ContractsHero } from './contracts-redesign/Hero';
import { Constellation } from './contracts-redesign/Constellation';
import { Architecture } from './contracts-redesign/Architecture';
import { ContractCards } from './contracts-redesign/ContractCards';
import { Coverage } from './contracts-redesign/Coverage';
import { Verify } from './contracts-redesign/Verify';
import { GithubSection } from './contracts-redesign/GithubSection';
import { NetworkStrip, ContractsBreadcrumb } from './contracts-redesign/NetworkStrip';
import { ContractDrawer } from './contracts-redesign/ContractDrawer';

/**
 * /contracts — the SPORE Protocol Layer.
 * Assembled from the contracts-redesign component lanes.
 * The shared Navbar (Chrome.tsx) is intentionally untouched;
 * this page carries its own breadcrumb home.
 */
export default function Contracts() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="bg-bg text-ink">
      <div className="mx-auto max-w-6xl px-6">
        <ContractsBreadcrumb />
      </div>

      <ContractsHero />

      <main>
        <Constellation onSelect={setSelected} selected={selected} />
        <Architecture onSelectContract={setSelected} />
        <ContractCards onSelect={setSelected} />
        <Coverage />
        <Verify onSelect={setSelected} />
        <GithubSection />
        <NetworkStrip />
      </main>

      <ContractDrawer name={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
