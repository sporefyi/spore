/**
 * CHAIN_CONFIG — the single blockchain configuration for SPORE.
 * Do not scatter chain ids, RPC urls, or contract addresses anywhere else.
 *
 * STATUS: SPORE v1 contracts are DEPLOYED on Robinhood Chain (mainnet).
 * Deployed 2026-10-03 by 0x4C7cFbd388249f3c3027c52635cf70bB78084Ed5.
 * UI treats null as "Protocol module not yet activated".
 * RPC urls come from environment variables; never commit secrets.
 *
 * DECLARED CHAIN: Robinhood Chain (chain id 4663). It is the only entry
 * in CHAINS.
 */

export interface ChainContracts {
  registry: string | null; // SporeRegistry — agent identity
  creditManager: string | null; // CreditManager — credit lines, borrow, repay
  backerVault: string | null; // BackerVault — backer stakes
  scoreOracle: string | null; // ScoreOracle — published scores
  feeRouter: string | null; // FeeRouter — fee splits
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

export const CHAINS: ChainConfig[] = [
  {
    slug: 'robinhood',
    name: 'Robinhood Chain',
    chainId: 4663,
    rpcEnvVar: 'VITE_RPC_ROBINHOOD',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    nativeCurrency: 'ETH',
    contracts: {
      registry: '0x6902670409c4FA3a75C39A734c69beAEEBcF9729',
      creditManager: '0x3348217314cA5641531005A4CFD7b20275Fcb7a9',
      backerVault: '0xF574091D96518F065f772a1231EBB9dC1AaB2694',
      scoreOracle: '0x31088a5516816ffb050846f6Ae4d460EB32000c4',
      feeRouter: '0x8F921bF51D603B5ACa827C0adA822aF5259057cc',
    },
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

/** Blockscout address URL for the primary chain. */
export function explorerAddressUrl(address: string): string {
  return `${PRIMARY_CHAIN.explorerUrl}/address/${address}`;
}
