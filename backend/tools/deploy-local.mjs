// Local-only deploy script for the SPORE credit protocol (anvil).
// Usage: node backend/tools/deploy-local.mjs
// Do NOT point this at a public network.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname + "/..");

// LOCAL anvil test key (account #0). Publicly known; never use on mainnet.
const DEFAULT_ANVIL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ANVIL_MNEMONIC =
  "test test test test test test test test test test test junk";

const MAX_TREASURY_BPS = 5000;

function loadConfig() {
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const deployerKey = process.env.DEPLOYER_KEY || DEFAULT_ANVIL_KEY;

  const treasuryBps = Number(process.env.TREASURY_BPS ?? 2000);
  if (!Number.isInteger(treasuryBps) || treasuryBps < 0 || treasuryBps > MAX_TREASURY_BPS) {
    throw new Error(`TREASURY_BPS must be an integer in [0, ${MAX_TREASURY_BPS}], got ${process.env.TREASURY_BPS}`);
  }

  const maxStalePeriod = BigInt(process.env.MAX_STALE_PERIOD ?? 604800);
  if (maxStalePeriod <= 0n) {
    throw new Error("MAX_STALE_PERIOD must be > 0");
  }

  const contractsOut = process.env.CONTRACTS_OUT
    ? path.resolve(process.env.CONTRACTS_OUT)
    : path.resolve(BACKEND_DIR, "../contracts/out");

  return {
    rpcUrl,
    deployerKey,
    treasury: process.env.TREASURY || null,
    updater: process.env.UPDATER || null,
    treasuryBps,
    maxStalePeriod,
    contractsOut,
  };
}

function loadArtifact(contractsOut, name) {
  const file = path.join(contractsOut, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Artifact not found: ${file} (run \`forge build\` in the contracts dir)`);
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const abi = json.abi;
  // Foundry artifacts store bytecode as { object: "0x..." }; support both shapes.
  const bytecode = typeof json.bytecode === "string" ? json.bytecode : json.bytecode?.object;
  if (!abi) throw new Error(`Artifact ${name} has no abi`);
  if (!bytecode || bytecode === "0x") throw new Error(`Artifact ${name} has no bytecode`);
  return { abi, bytecode };
}

// --- Nonce discipline (anvil + ethers v6 race, see AGENTS.md) ---
// Manage the deployer's nonce explicitly: read "pending" once, assign
// manually, advance only after a tx confirms. Prevents "nonce has already
// been used" races on rapid sequential sends.
let __nextNonce = null;
async function managedTx(signer, build) {
  if (__nextNonce === null) {
    __nextNonce = await signer.provider.getTransactionCount(await signer.getAddress(), "pending");
  }
  const nonce = __nextNonce;
  const tx = await build(nonce); // build: (nonce) => Promise<TransactionResponse>
  const receipt = await tx.wait();
  __nextNonce = nonce + 1;
  return receipt;
}

async function deployContract(contractsOut, name, signer, args) {
  const { abi, bytecode } = loadArtifact(contractsOut, name);
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const deployTx = await factory.getDeployTransaction(...args);
  const receipt = await managedTx(signer, (nonce) => signer.sendTransaction({ ...deployTx, nonce }));
  const address = receipt.contractAddress;
  const contract = new ethers.Contract(address, abi, signer);
  console.log(`  ${name.padEnd(14)} ${address}`);
  return { contract, receipt };
}

function assertEqAddr(label, actual, expected) {
  if (ethers.getAddress(actual) !== ethers.getAddress(expected)) {
    throw new Error(`Verification failed: ${label} = ${actual}, expected ${expected}`);
  }
}

function assertEqBig(label, actual, expected) {
  if (BigInt(actual) !== BigInt(expected)) {
    throw new Error(`Verification failed: ${label} = ${actual}, expected ${expected}`);
  }
}

export async function deploy() {
  const cfg = loadConfig();

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const deployer = new ethers.Wallet(cfg.deployerKey, provider);
  const treasury = ethers.getAddress(cfg.treasury || deployer.address);
  const updater = ethers.getAddress(cfg.updater || deployer.address);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== 31337) {
    console.warn(`WARNING: chainId is ${chainId}, not 31337 (anvil default). This script is for LOCAL testing only.`);
  }

  console.log(`RPC:       ${cfg.rpcUrl} (chainId ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Treasury:  ${treasury}`);
  console.log(`Updater:   ${updater}`);
  console.log(`Artifacts: ${cfg.contractsOut}`);
  console.log("Deploying...");

  // 1. Mock asset (first deployment tx -> deployBlock)
  const mockD = await deployContract(cfg.contractsOut, "MockUSD", deployer, ["Mock USD", "MUSD"]);
  const mock = mockD.contract;
  const deployBlock = mockD.receipt.blockNumber;
  const assetAddr = await mock.getAddress();

  // 2. Protocol contracts, frozen order: registry -> oracle -> manager -> vault -> router
  const registry = (await deployContract(cfg.contractsOut, "SporeRegistry", deployer, [deployer.address])).contract;
  const registryAddr = await registry.getAddress();

  const oracle = (await deployContract(cfg.contractsOut, "ScoreOracle", deployer, [
    deployer.address,
    updater,
    cfg.maxStalePeriod,
  ])).contract;
  const oracleAddr = await oracle.getAddress();

  const manager = (await deployContract(cfg.contractsOut, "CreditManager", deployer, [
    assetAddr,
    registryAddr,
    oracleAddr,
    deployer.address,
    cfg.maxStalePeriod,
  ])).contract;
  const managerAddr = await manager.getAddress();

  const vault = (await deployContract(cfg.contractsOut, "BackerVault", deployer, [
    assetAddr,
    registryAddr,
    managerAddr,
    deployer.address,
  ])).contract;
  const vaultAddr = await vault.getAddress();

  const router = (await deployContract(cfg.contractsOut, "FeeRouter", deployer, [
    assetAddr,
    treasury,
    vaultAddr,
    managerAddr,
    cfg.treasuryBps,
    deployer.address,
  ])).contract;
  const routerAddr = await router.getAddress();

  // 3. Wiring (explicit nonces via managedTx)
  console.log("Wiring...");
  await managedTx(deployer, (nonce) => manager.setVault(vaultAddr, { nonce }));
  await managedTx(deployer, (nonce) => manager.setFeeRouter(routerAddr, { nonce }));
  await managedTx(deployer, (nonce) => vault.setFeeRouter(routerAddr, { nonce }));

  // 4. Roles: let the local deployer act as underwriter in tests
  console.log("Granting roles...");
  const UNDERWRITER_ROLE = ethers.id("UNDERWRITER_ROLE");
  await managedTx(deployer, (nonce) => manager.grantRole(UNDERWRITER_ROLE, deployer.address, { nonce }));
  await managedTx(deployer, (nonce) => vault.grantRole(UNDERWRITER_ROLE, deployer.address, { nonce }));

  // 5. Verify read-backs
  console.log("Verifying...");
  assertEqAddr("manager.vault()", await manager.vault(), vaultAddr);
  assertEqAddr("manager.feeRouter()", await manager.feeRouter(), routerAddr);
  assertEqAddr("vault.feeRouter()", await vault.feeRouter(), routerAddr);
  assertEqAddr("router.treasury()", await router.treasury(), treasury);
  assertEqBig("router.treasuryBps()", await router.treasuryBps(), cfg.treasuryBps);
  assertEqAddr("router.creditManager()", await router.creditManager(), managerAddr);
  assertEqAddr("router.vault()", await router.vault(), vaultAddr);
  assertEqBig("oracle.maxStalePeriod()", await oracle.maxStalePeriod(), cfg.maxStalePeriod);
  if (!(await manager.hasRole(UNDERWRITER_ROLE, deployer.address))) {
    throw new Error("Verification failed: deployer lacks UNDERWRITER_ROLE on CreditManager");
  }
  if (!(await vault.hasRole(UNDERWRITER_ROLE, deployer.address))) {
    throw new Error("Verification failed: deployer lacks UNDERWRITER_ROLE on BackerVault");
  }

  // 6. Fund the first 3 anvil default accounts
  console.log("Funding test accounts...");
  const testAccounts = [0, 1, 2].map(
    (i) => ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).address
  );
  await managedTx(deployer, (nonce) => mock.mintToTestAccounts(testAccounts, 10_000n * 10n ** 18n, { nonce }));
  testAccounts.forEach((a, i) => console.log(`  account #${i} ${a}`));

  // 7. Output (addresses only; no secrets)
  const result = {
    chainId,
    rpcUrl: cfg.rpcUrl,
    deployBlock,
    asset: { address: assetAddr, decimals: 18 },
    contracts: {
      registry: registryAddr,
      creditManager: managerAddr,
      backerVault: vaultAddr,
      scoreOracle: oracleAddr,
      feeRouter: routerAddr,
    },
  };

  const outFile = path.join(BACKEND_DIR, ".deployed.json");
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${outFile}`);

  provider.destroy();
  return result;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  deploy()
    .then((r) => {
      console.log("\nDeployment summary");
      console.table({
        chainId: { value: r.chainId },
        deployBlock: { value: r.deployBlock },
        "asset (MockUSD)": { value: r.asset.address },
        registry: { value: r.contracts.registry },
        scoreOracle: { value: r.contracts.scoreOracle },
        creditManager: { value: r.contracts.creditManager },
        backerVault: { value: r.contracts.backerVault },
        feeRouter: { value: r.contracts.feeRouter },
      });
    })
    .catch((err) => {
      console.error("Deploy failed:", err?.message ?? err);
      process.exit(1);
    });
}
