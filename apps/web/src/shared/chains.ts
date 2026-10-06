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

/** Blockscout transaction URL for the primary chain. */
export function explorerTxUrl(txHash: string): string {
  return `${PRIMARY_CHAIN.explorerUrl}/tx/${txHash}`;
}

/** SPORE token (18 decimals) — the asset GPU rentals accept. */
export const SPORE = {
  address: '0xa5127fae2d0986a4cb6619b9c4ec53461726454b',
  decimals: 18,
  symbol: 'SPORE',
} as const;

/** USDG stablecoin (6 decimals) — the asset merchants accept. */
export const USDG = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  decimals: 6,
  symbol: 'USDG',
} as const;

/** Merchant that settles all six market services. */
export const MARKET_MERCHANT = '0x4c7cfbd388249f3c3027c52635cf70bb78084ed5';

/** Public RPC for wallet_addEthereumChain / reads. */
export const ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/**
 * SyndicateManager — syndicated loans for agents.
 * Deployed 2026-10-06: 0xe7a153af9cb008adab6a280a0ed83eb3a180e4ab
 * Tx: 0x343d3e714953df65d31643b7305cbaca1aea7084b8025a4087e03bbee26a2982
 */
export const SYNDICATE_MANAGER: string = '0xe7a153af9cb008adab6a280a0ed83eb3a180e4ab';

/** EIP-1193 chain-add parameters for Robinhood Chain. */
export function robinhoodChainParams(): {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
} {
  return {
    chainId: `0x${PRIMARY_CHAIN.chainId.toString(16)}`,
    chainName: PRIMARY_CHAIN.name,
    nativeCurrency: { name: 'Ether', symbol: PRIMARY_CHAIN.nativeCurrency, decimals: 18 },
    rpcUrls: [ROBINHOOD_RPC_URL],
    blockExplorerUrls: [PRIMARY_CHAIN.explorerUrl],
  };
}
