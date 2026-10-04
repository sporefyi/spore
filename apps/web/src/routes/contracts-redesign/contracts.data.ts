// SPORE /contracts page — data architecture (LANE 2)
// Pure TypeScript data module. No React. No fetching — all values are
// compile-time constants verified against the on-chain deploy (2026-10-04).
//
// Test totals were verified by running `forge test` in ~/workspace/spore/contracts:
// "Ran 11 test suites: 203 tests passed, 0 failed, 0 skipped".
// All function/event signatures were extracted from the real Foundry ABIs at
// ~/workspace/spore/contracts/out/<Name>.sol/<Name>.json. Nothing invented.

export interface NetworkConfig {
  name: string;
  chainId: number;
  rpc: string;
  explorer: string;
  currency: string;
}

export const NETWORK: NetworkConfig = {
  name: "Robinhood Chain",
  chainId: 4663,
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://explorer.robinhood.com",
  currency: "ETH",
};

export const SPORE_TOKEN = "0xa5127fae2d0986a4cb6619b9c4ec53461726454b";
export const USDG_TOKEN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

// ---------------------------------------------------------------- V1 core

export interface V1Contract {
  name: string;
  address: string;
  purpose: string;
  deployedNote: string;
}

const V1_DEPLOYED_NOTE = "Block 79007660 · Immutable";

export const V1_CONTRACTS: V1Contract[] = [
  {
    name: "SporeRegistry",
    address: "0x6902670409c4FA3a75C39A734c69beAEEBcF9729",
    purpose: "Agent identity & registration — ERC-8004 compatible",
    deployedNote: V1_DEPLOYED_NOTE,
  },
  {
    name: "ScoreOracle",
    address: "0x31088a5516816ffb050846f6Ae4d460EB32000c4",
    purpose: "Publishes credit scores & risk bands on-chain",
    deployedNote: V1_DEPLOYED_NOTE,
  },
  {
    name: "CreditManager",
    address: "0x3348217314cA5641531005A4CFD7b20275Fcb7a9",
    purpose: "Issues credit lines; tracks draws & repayments",
    deployedNote: V1_DEPLOYED_NOTE,
  },
  {
    name: "BackerVault",
    address: "0xF574091D96518F065f772a1231EBB9dC1AaB2694",
    purpose: "Backers stake USDG to fund agent credit",
    deployedNote: V1_DEPLOYED_NOTE,
  },
  {
    name: "FeeRouter",
    address: "0x8F921bF51D603B5ACa827C0adA822aF5259057cc",
    purpose: "Splits protocol fees → treasury + backers",
    deployedNote: V1_DEPLOYED_NOTE,
  },
];

// ---------------------------------------------------------------- V2 tokenomics / governance

export interface V2Contract {
  name: string;
  address: string;
  purpose: string;
  status: "LIVE";
  details: string[];
  /** Omitted when no dedicated test file exists (covered inside another suite). */
  tests?: number;
  /** Real ABI signatures, most important first. Never invented. */
  functions: string[];
  /** Real ABI event signatures. Never invented. */
  events: string[];
  githubPath: string;
}

export const V2_CONTRACTS: V2Contract[] = [
  {
    name: "SporeBuyback",
    address: "0x4955a8286deC81c1fF6Aaf1c3e36df80D6C34a97",
    purpose: "Fee USDG → $SPORE → burn",
    status: "LIVE",
    details: [
      "Permissionless execution",
      "1% keeper incentive",
      "Fee-driven buyback mechanism",
    ],
    tests: 17,
    functions: [
      "executeBuyback(uint256, address[])",
      "sweepUsdg(address, uint256)",
      "setKeeperBps(uint256)",
      "setRouter(address)",
      "rescueToken(address, address, uint256)",
      "totalSporeBurned() -> uint256",
      "totalUsdgSwapped() -> uint256",
      "keeperBps() -> uint16",
    ],
    events: [
      "BuybackExecuted(uint256, uint256, address, uint256)",
      "BuybackPending(uint256)",
      "KeeperBpsUpdated(uint16, uint16)",
      "RouterUpdated(address, address)",
      "UsdgSwept(address, uint256)",
      "TokenRescued(address, address, uint256)",
    ],
    githubPath: "contracts/src/SporeBuyback.sol",
  },
  {
    name: "BackerSporeStake",
    address: "0x6b136Ba05267718CD21fEA1AC343D275FAF70399",
    purpose: "Backers stake $SPORE to qualify for protocol fees",
    status: "LIVE",
    details: [
      "Minimum 1,000 $SPORE",
      "Or 10% of backing",
      "7-day unstake cooldown",
    ],
    tests: 30,
    functions: [
      "stake(uint256)",
      "requestUnstake(uint256) -> uint256",
      "claimUnstake()",
      "isQualified(address, uint256) -> bool",
      "requiredStake(uint256) -> uint256",
      "setMinStake(uint256)",
      "setCooldown(uint256)",
      "staked(address) -> uint256",
    ],
    events: [
      "Staked(address, uint256)",
      "UnstakeRequested(address, uint256, uint256, uint64)",
      "UnstakeClaimed(address, uint256, uint256)",
      "MinStakeSet(uint256, uint256)",
      "CooldownSet(uint256, uint256)",
    ],
    githubPath: "contracts/src/BackerSporeStake.sol",
  },
  {
    name: "OracleBond",
    address: "0x2299828160c8c41455EAc98e4CC8403F63289dAa",
    purpose: "Economic security for oracle updaters",
    status: "LIVE",
    details: [
      "10,000 $SPORE bond",
      "Slashable",
      "Slashing enforceable during unstake",
    ],
    tests: 34,
    functions: [
      "stake(uint256)",
      "slash(address, uint256, string)",
      "requestUnstake()",
      "claimUnstake()",
      "cancelUnstake()",
      "isBonded(address) -> bool",
      "setMinBond(uint256)",
      "setTreasury(address)",
    ],
    events: [
      "Bonded(address, uint256)",
      "Slashed(address, uint256, string, address)",
      "UnstakeRequested(address, uint256, uint64)",
      "UnstakeClaimed(address, uint256)",
      "UnstakeCancelled(address)",
      "MinBondUpdated(uint256, uint256)",
    ],
    githubPath: "contracts/src/OracleBond.sol",
  },
  {
    name: "SporeGovernor",
    address: "0x702A8e451752A7036a2cDb8E76f0AAf1C3873536",
    purpose: "On-chain governance",
    status: "LIVE",
    details: [
      "$SPORE voting",
      "2-day timelock",
      "vSPORE voting architecture",
      "Full propose → vote → execute flow tested",
    ],
    tests: 12,
    functions: [
      "propose(address[], uint256[], bytes[], string) -> uint256",
      "castVote(uint256, uint8) -> uint256",
      "queue(address[], uint256[], bytes[], bytes32) -> uint256",
      "execute(address[], uint256[], bytes[], bytes32) -> uint256",
      "state(uint256) -> uint8",
      "quorum(uint256) -> uint256",
      "votingDelay() -> uint256",
      "votingPeriod() -> uint256",
    ],
    events: [
      "ProposalCreated(uint256, address, address[], uint256[], string[], bytes[], uint256, uint256, string)",
      "VoteCast(address, uint256, uint8, uint256, string)",
      "ProposalQueued(uint256, uint256)",
      "ProposalExecuted(uint256)",
      "ProposalCanceled(uint256)",
      "TimelockChange(address, address)",
    ],
    githubPath: "contracts/src/SporeGovernor.sol",
  },
  {
    name: "SporeVotes",
    address: "0x4dee4A2D388bAD0e5FD548Da98561b6Ec691830F",
    purpose: "vSPORE wrapper — 1:1 $SPORE with voting checkpoints",
    status: "LIVE",
    details: [
      "1:1 wrap/unwrap",
      "ERC20Votes checkpoints",
      // No dedicated test file exists; covered inside the governor suite.
      "Tested within SporeGovernor.t.sol (no standalone suite)",
    ],
    functions: [
      "wrap(uint256)",
      "unwrap(uint256)",
      "depositFor(address, uint256) -> bool",
      "withdrawTo(address, uint256) -> bool",
      "underlying() -> address",
    ],
    events: [
      "Transfer(address, address, uint256)",
      "DelegateChanged(address, address, address)",
      "DelegateVotesChanged(address, uint256, uint256)",
    ],
    githubPath: "contracts/src/SporeVotes.sol",
  },
  {
    name: "TimelockController",
    address: "0xd69C4f1cA47d75B5CC637fa31F981cB7B33b8E61",
    purpose: "2-day timelock for governance actions",
    status: "LIVE",
    details: [
      "172800s delay",
      "OpenZeppelin TimelockController",
      // No dedicated test file exists; covered inside the governor suite.
      "Tested within SporeGovernor.t.sol (no standalone suite)",
    ],
    functions: [
      "schedule(address, uint256, bytes, bytes32, bytes32, uint256)",
      "execute(address, uint256, bytes, bytes32, bytes32)",
      "cancel(bytes32)",
      "scheduleBatch(address[], uint256[], bytes[], bytes32, bytes32, uint256)",
      "executeBatch(address[], uint256[], bytes[], bytes32, bytes32)",
      "updateDelay(uint256)",
      "getTimestamp(bytes32) -> uint256",
    ],
    events: [
      "CallScheduled(bytes32, uint256, address, uint256, bytes, bytes32, uint256)",
      "CallExecuted(bytes32, uint256, address, uint256, bytes)",
      "Cancelled(bytes32)",
      "MinDelayChange(uint256, uint256)",
    ],
    // NOT in contracts/src — it is the unmodified OpenZeppelin contract.
    githubPath: "@openzeppelin/contracts/governance/TimelockController.sol",
  },
];

// ---------------------------------------------------------------- Test totals

export interface TestTotals {
  total: number;
  passing: number;
  /** One entry per forge suite, as reported by `forge test`. Sums to total. */
  perContract: { name: string; tests: number }[];
}

export const TEST_TOTALS: TestTotals = {
  total: 203,
  passing: 203,
  perContract: [
    { name: "OracleBond", tests: 34 },
    { name: "CreditManager", tests: 35 },
    { name: "BackerSporeStake", tests: 30 },
    { name: "BackerVault", tests: 26 },
    { name: "SporeBuyback", tests: 17 },
    { name: "SporeRegistry", tests: 17 },
    { name: "ScoreOracle", tests: 12 },
    { name: "SporeGovernor", tests: 12 },
    { name: "FeeRouter", tests: 10 },
    { name: "Lifecycle (integration)", tests: 6 },
    { name: "Invariants", tests: 4 },
  ],
};

// ---------------------------------------------------------------- Helpers

export function explorerAddressUrl(address: string): string {
  return `${NETWORK.explorer}/address/${address}`;
}
