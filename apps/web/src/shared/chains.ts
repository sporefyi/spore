/**
 * CHAIN_CONFIG — the single blockchain configuration for SPORE.
 * Do not scatter chain ids, RPC urls, or contract addresses anywhere else.
 *
 * STATUS: SPORE contracts are NOT deployed on any chain yet.
 * Every contract address is null and `protocolActive` is false until a real
 * deployment exists. UI must treat null as "Protocol module not yet activated".
 * RPC urls come from environment variables; never commit secrets.
 *
 * DECLARED CHAIN: Robinhood Chain (chain id 4663). This is the chain SPORE
 * will deploy to. It is the only entry in CHAINS.
 */

export interface ChainContracts {
  creditPool: string | null;
  creditOracle: string | null;
  creditRouter: string | null;
  identityRegistry: string | null;
}

export interface ChainConfig {
  slug: string;
  name: string;
  chainId: number;
  /** Name of the env var holding the RPC url, e.g. VITE_RPC_ROBINHOOD. */
  rpcEnvVar: string;
  explorerUrl: string;
  nativeCurrency: string;
  contracts: ChainContracts;
}

const NULL_CONTRACTS: ChainContracts = {
  creditPool: null,
  creditOracle: null,
  creditRouter: null,
  identityRegistry: null,
};

export const CHAINS: ChainConfig[] = [
  {
    slug: 'robinhood',
    name: 'Robinhood Chain',
    chainId: 4663,
    rpcEnvVar: 'VITE_RPC_ROBINHOOD',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    nativeCurrency: 'ETH',
    contracts: { ...NULL_CONTRACTS },
  },
];

/** The declared chain for SPORE. Currently the only entry in CHAINS. */
export const PRIMARY_CHAIN: ChainConfig = CHAINS[0];

/** True only when at least one contract address is set on any chain. */
export const PROTOCOL_ACTIVE: boolean = CHAINS.some((c) =>
  Object.values(c.contracts).some((a) => a !== null),
);

export function getChain(slug: string): ChainConfig | undefined {
  return CHAINS.find((c) => c.slug === slug);
}

/** Resolve an RPC url from env. Returns null when unconfigured — never a guess. */
export function rpcUrl(chain: ChainConfig): string | null {
  const v = (import.meta as unknown as { env: Record<string, string | undefined> }).env[
    chain.rpcEnvVar
  ];
  return v && v.length > 0 ? v : null;
}
