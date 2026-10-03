// backend/test/harness.mjs
//
// Shared integration-test harness for the SPORE backend.
// Boots: anvil -> deploy contracts -> PGlite DB (+ schema) -> indexer / API / score-engine (in-process),
// and provides a scripted on-chain scenario driven through ethers v6.
//
// Plain functions only; no test framework is used in here.
//
// (a) HOW SERVICES ARE WIRED (single process, shared DbClient)
//   PGlite data dirs CANNOT be shared across processes (verified), and this VM
//   has no Postgres — so the indexer, API, and score engine all run IN-PROCESS
//   against one DbClient from @spore/common (createDb("pglite://<tmpdir>") +
//   runMigrations), which the tests also use for assertions.
//   - indexer : ChainWatcher from ../indexer/dist/watcher.js, Interface from
//               loadSporeAbis(<contracts/out>)+buildSporeInterface, and an
//               ethers-v6 ChainReader adapter. config: {chainId, deployBlock,
//               confirmations: 1, pollMs: 400, backfillChunkSize: 2000}.
//   - api     : Fastify app with registerRoutes() from ../api/dist/routes.js,
//               listening on 127.0.0.1:0; ApiConfig built from the deploy output.
//   - engine  : runBatch() from ../score-engine/dist/engine.js (on demand).
//   deploy-local.mjs exports deploy() (reads process.env.RPC_URL) and resolves
//   { chainId, rpcUrl, deployBlock, asset: { address }, contracts: {...} }.
//   runScenario assumes: registry.registerAgent(string), manager.issueLine,
//   setMerchantAllowed, borrow, repay, vault.deposit, vault.absorbDefault.
//
// (b) ENV VARS HONORED
//   - FOUNDRY_BIN       path to the anvil binary (or a directory containing `anvil`);
//                       default ~/.foundry/bin/anvil
//   - RPC_URL           SET by deployLocal() for tools/deploy-local.mjs (not read)
//   - SPORE_TEST_DEBUG  if set, logs module-probe failures to stderr
//   Port 8545/8546 are never used (demo + dev stacks); anvil always gets a
//   free ephemeral port, and teardown kills only the spawned child PID.
//
// (c) MISSING SERVICES
//   Services that cannot be imported are reported via `availability` ({ indexer, api, scoreEngine }),
//   so tests can skip gracefully (e.g. `if (!services.availability.api) return t.skip()`).

import { ethers } from "ethers";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debug = (...a) => process.env.SPORE_TEST_DEBUG && console.error("[harness]", ...a);

// ---------------------------------------------------------------- anvil

// Bind to port 0, read the assigned port, close the server.
// Retries on EADDRINUSE; never returns the reserved demo/dev ports.
const RESERVED_PORTS = new Set([8545, 8546]);
function freePort(attempts = 25) {
  return new Promise((resolve, reject) => {
    let left = attempts;
    const attempt = () => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", (err) => {
        if (left-- > 0) { attempt(); return; }
        reject(err);
      });
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address();
        srv.close((err) => {
          if (err || RESERVED_PORTS.has(port)) {
            if (left-- > 0) { attempt(); return; }
            reject(err || new Error(`only reserved ports available (got ${port})`));
            return;
          }
          resolve(port);
        });
      });
    };
    attempt();
  });
}

function anvilBinary() {
  let bin = process.env.FOUNDRY_BIN || path.join(os.homedir(), ".foundry", "bin", "anvil");
  try {
    if (fs.statSync(bin).isDirectory()) bin = path.join(bin, "anvil");
  } catch {
    /* let spawn report a missing binary */
  }
  return bin;
}

async function rpcChainId(rpcUrl) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const json = await res.json();
  if (!json.result) throw new Error("no result");
  return json.result;
}

export async function spawnAnvil() {
  const port = await freePort();
  if (RESERVED_PORTS.has(port)) throw new Error(`refusing to use reserved port ${port}`);
  const rpcUrl = `http://127.0.0.1:${port}`;

  const child = spawn(anvilBinary(), ["--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  // NOTE: teardown kills ONLY this specific child (process.kill on its PID).
  // Never pkill: a broad pattern can match unrelated shells/processes.
  let exited = false;
  let spawnError = null;
  child.on("exit", () => (exited = true));
  child.on("error", (e) => {
    spawnError = e;
    exited = true;
  });
  child.unref();

  // Terminate the whole process group (detached => child is group leader).
  const kill = () => {
    if (!child.pid || exited) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`anvil exited before becoming ready${spawnError ? `: ${spawnError.message}` : ""}`);
    }
    try {
      await rpcChainId(rpcUrl);
      return { port, rpcUrl, kill };
    } catch {
      await sleep(250);
    }
  }
  kill();
  throw new Error(`anvil not ready on ${rpcUrl} within 20s`);
}

// ---------------------------------------------------------------- deploy

export async function deployLocal(rpcUrl) {
  process.env.RPC_URL = rpcUrl;
  const mod = await import("../tools/deploy-local.mjs");
  if (typeof mod.deploy !== "function") {
    throw new Error("../tools/deploy-local.mjs does not export deploy()");
  }
  return await mod.deploy();
}

// ---------------------------------------------------------------- database

let dbCounter = 0;

export async function openTestDb() {
  // Use the REAL lane-1 driver stack (createDb + runMigrations) so the test
  // DB behaves exactly like the services' DB (driver normalization, migration
  // tracking). One PGlite instance, shared in-process by indexer/api/engine/tests.
  const { createDb, runMigrations } = await import("../common/dist/index.js");
  const dir = path.join(os.tmpdir(), `spore-test-${process.pid}-${Date.now()}-${dbCounter++}`);
  const db = await createDb(`pglite://${dir}`);
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await runMigrations(db, path.join(backendDir, "db", "migrations"));

  let closed = false;
  return {
    db, // DbClient: query(text, params) -> { rows, rowCount }; withTx; close
    async close() {
      if (closed) return;
      closed = true;
      try {
        await db.close();
      } catch (e) {
        debug("db.close failed", e.message);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- module probing

// Try each specifier in order; return { mod, spec } for the first that imports, else null.
export async function tryImport(candidates) {
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      return { mod, spec };
    } catch (e) {
      debug(`import ${spec} failed: ${e.code || ""} ${e.message}`);
    }
  }
  return null;
}

// First exported function whose name matches, in the order of `names`.
function pickFn(mod, names) {
  for (const n of names) {
    if (typeof mod[n] === "function") return { name: n, fn: mod[n] };
  }
  const def = mod.default;
  if (def && typeof def === "object") {
    for (const n of names) {
      if (typeof def[n] === "function") return { name: n, fn: def[n].bind(def) };
    }
  }
  return null;
}

async function stopQuietly(handle, label) {
  try {
    if (!handle) return;
    if (typeof handle === "function") await handle();
    else if (typeof handle.stop === "function") await handle.stop();
    else if (typeof handle.close === "function") await handle.close();
  } catch (e) {
    debug(`stop ${label} failed`, e.message);
  }
}

export async function startServices({ db, deploy }) {
  // In-process wiring against the REAL lane modules, sharing one DbClient
  // (PGlite data dirs cannot be shared across processes, so child-process
  // services are not viable for local e2e — everything runs in this process).
  const { execFileSync } = await import("node:child_process");
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "warn";

  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const here = (p) => path.join(backendDir, p);
  const distPresent = ["indexer/dist/watcher.js", "api/dist/routes.js", "score-engine/dist/engine.js", "common/dist/index.js"]
    .every((p) => fs.existsSync(here(p)));
  if (!distPresent) {
    debug("building workspaces...");
    execFileSync("npm", ["run", "build", "--workspaces"], { cwd: backendDir, stdio: "inherit" });
  }

  const { createLogger } = await import("../common/dist/index.js");
  const logger = createLogger("test-harness");
  const availability = { indexer: false, api: false, scoreEngine: false };
  const c = deploy.contracts;

  // --- indexer: real ChainWatcher -------------------------------------------
  const { ChainWatcher } = await import("../indexer/dist/watcher.js");
  const { loadSporeAbis, buildSporeInterface } = await import("../indexer/dist/abis.js");
  const artifactsDir = path.resolve(backendDir, "..", "contracts", "out");
  const iface = buildSporeInterface(loadSporeAbis(artifactsDir));
  const chainProvider = new ethers.JsonRpcProvider(deploy.rpcUrl, undefined, { batchMaxCount: 1 });
  const reader = {
    getBlockNumber: () => chainProvider.getBlockNumber(),
    getBlock: async (n) => {
      const b = await chainProvider.getBlock(n);
      return b ? { hash: b.hash, timestamp: b.timestamp } : null;
    },
    getLogs: async ({ address, fromBlock, toBlock }) => {
      const logs = await chainProvider.getLogs({ address, fromBlock, toBlock });
      return logs.map((l) => ({
        blockNumber: l.blockNumber,
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        index: l.index,
        topics: [...l.topics],
        data: l.data,
      }));
    },
    getNetwork: async () => ({ chainId: (await chainProvider.getNetwork()).chainId }),
  };
  const watcher = new ChainWatcher({
    reader,
    db,
    iface,
    config: {
      chainId: deploy.chainId,
      deployBlock: deploy.deployBlock,
      confirmations: 1,
      pollMs: 400,
      backfillChunkSize: 2000,
      contractAddresses: [c.registry, c.creditManager, c.backerVault, c.feeRouter],
    },
    logger: createLogger("test-indexer"),
  });
  let watcherError = null;
  const watcherRun = watcher.start().catch((e) => { watcherError = e; });
  void watcherRun;
  availability.indexer = true;

  // --- api: real Fastify routes ----------------------------------------------
  const { default: Fastify } = await import("fastify");
  const { registerRoutes } = await import("../api/dist/routes.js");
  const app = Fastify({ logger: false });
  const apiConfig = {
    databaseUrl: "",
    rpcUrl: deploy.rpcUrl,
    chainId: deploy.chainId,
    chainName: "Robinhood Chain",
    confirmations: 1,
    deployBlock: deploy.deployBlock,
    contracts: {
      registry: c.registry,
      creditManager: c.creditManager,
      backerVault: c.backerVault,
      scoreOracle: c.scoreOracle,
      feeRouter: c.feeRouter,
    },
    assetAddress: deploy.asset.address,
    assetDecimals: 18,
    assetSymbol: "MUSD",
    scoreModelVersion: 1,
    serviceStatusOverride: { indexer: "ok", scoreEngine: "ok", oraclePublisher: "ok" },
    port: 0,
    logLevel: "warn",
  };
  registerRoutes(app, { db, config: apiConfig, logger: createLogger("test-api") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const apiUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  availability.api = true;

  // --- score engine: single batch on demand -----------------------------------
  const { runBatch } = await import("../score-engine/dist/engine.js");
  const runScoring = (extra = {}) =>
    runBatch({ db, intervalMs: 60000, assetDecimals: 18, logger: createLogger("test-engine"), now: () => Date.now(), ...extra });
  availability.scoreEngine = true;

  let stopped = false;
  async function stopAll() {
    if (stopped) return;
    stopped = true;
    try { await watcher.stop(); } catch (e) { debug("watcher.stop", e.message); }
    try { await app.close(); } catch (e) { debug("app.close", e.message); }
    try { chainProvider.destroy(); } catch { /* noop */ }
    if (watcherError) debug("watcher exited with error", watcherError.message);
  }

  const api = { url: apiUrl };
  return { indexer: { watcher }, api, runScoring, availability, stopAll, logger };
}

// ---------------------------------------------------------------- helpers

export async function waitFor(cond, { timeoutMs = 30000, intervalMs = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await cond();
      if (v) return v;
    } catch {
      /* treat errors as "not yet" */
    }
    if (Date.now() >= deadline) throw new Error(`Timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

export function signers(rpcUrl) {
  // batchMaxCount: 1 disables request batching, which keeps anvil happy.
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  const at = (i) =>
    ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider);
  return { deployer: at(0), backer1: at(1), backer2: at(2) };
}

// Explicit nonce management (avoids the ethers-v6 + anvil nonce race).
// Usage: const send = managedSender(wallet); await send((nonce) => contract.foo(a, { nonce }));
export function managedSender(wallet) {
  let nonce = null;
  return async function send(fn) {
    if (nonce === null) {
      nonce = await wallet.provider.getTransactionCount(await wallet.getAddress(), "pending");
    }
    const tx = await fn(nonce);
    const receipt = await tx.wait();
    nonce += 1; // only after success
    return receipt;
  };
}

// ---------------------------------------------------------------- scenario

const ABI = {
  erc20: ["function approve(address,uint256) returns (bool)"],
  registry: ["function registerAgent(string uri) returns (uint256)"],
  manager: [
    "function issueLine(uint256 agentId, uint256 limit, uint16 bps)",
    "function setMerchantAllowed(address merchant, bool allowed)",
    "function borrow(uint256 agentId, uint256 amount, address merchant)",
    "function repay(uint256 agentId, uint256 amount)",
  ],
  vault: [
    "function deposit(uint256 agentId, uint256 amount)",
    "function absorbDefault(uint256 agentId)",
  ],
};

// Accepts an address string or an ethers Contract; returns a Contract bound to `signer`.
function bind(entry, abi, signer, label) {
  if (!entry) throw new Error(`deploy.contracts is missing "${label}"`);
  if (typeof entry === "string") return new ethers.Contract(entry, abi, signer);
  if (typeof entry.connect === "function" && entry.interface) {
    return new ethers.Contract(entry.target ?? entry.address, abi, signer);
  }
  if (entry.address) return new ethers.Contract(entry.address, abi, signer);
  throw new Error(`unsupported contract entry for "${label}"`);
}

const E18 = (n) => ethers.parseUnits(String(n), 18);

export const MERCHANT = "0x1111111111111111111111111111111111111111";

export async function runScenario({ provider, contracts, assetAddr, signers: sg, sendFns }) {
  const { deployer, backer1 } = sg;
  const sendD = sendFns.deployer;
  const sendB1 = sendFns.backer1;

  const pick = (...names) => {
    for (const n of names) if (contracts[n]) return [contracts[n], n];
    return [undefined, names[0]];
  };

  const [registryEntry] = pick("registry", "agentRegistry");
  const [managerEntry] = pick("manager", "creditManager");
  const [vaultEntry] = pick("vault", "sponsorVault", "backerVault");

  const registry = bind(registryEntry, ABI.registry, deployer, "registry");
  const manager = bind(managerEntry, ABI.manager, deployer, "manager");
  const vault_d = bind(vaultEntry, ABI.vault, deployer, "vault");
  const vault_b1 = bind(vaultEntry, ABI.vault, backer1, "vault");
  const erc20_d = bind({ address: assetAddr }, ABI.erc20, deployer, "asset");
  const erc20_b1 = bind({ address: assetAddr }, ABI.erc20, backer1, "asset");

  const vaultAddr = await vault_d.getAddress();
  const managerAddr = await manager.getAddress();

  // agent 1
  await sendD((nonce) => registry.registerAgent("ipfs://agent-1", { nonce }));
  await sendD((nonce) => manager.issueLine(1, E18(1000), 500, { nonce }));

  await sendB1((nonce) => erc20_b1.approve(vaultAddr, E18(500), { nonce }));
  await sendB1((nonce) => vault_b1.deposit(1, E18(500), { nonce }));

  await sendD((nonce) => manager.setMerchantAllowed(MERCHANT, true, { nonce }));
  await sendD((nonce) => manager.borrow(1, E18(100), MERCHANT, { nonce }));

  await sendD((nonce) => erc20_d.approve(managerAddr, E18(50), { nonce }));
  await sendD((nonce) => manager.repay(1, E18(50), { nonce }));
  await sendD((nonce) => erc20_d.approve(managerAddr, E18(55), { nonce }));
  await sendD((nonce) => manager.repay(1, E18(55), { nonce }));

  // agent 2 (defaults)
  await sendD((nonce) => registry.registerAgent("ipfs://agent-2", { nonce }));
  await sendD((nonce) => manager.issueLine(2, E18(800), 500, { nonce }));
  await sendD((nonce) => erc20_d.approve(vaultAddr, E18(300), { nonce }));
  await sendD((nonce) => vault_d.deposit(2, E18(300), { nonce }));
  await sendD((nonce) => manager.borrow(2, E18(200), MERCHANT, { nonce }));
  await sendD((nonce) => vault_d.absorbDefault(2, { nonce }));

  // Finalize: mine one more block so the absorbDefault block falls within the
  // indexer's CONFIRMATIONS window (head - 1) on an otherwise idle chain.
  await sendD((nonce) => deployer.sendTransaction({ to: deployer.address, value: 1n, nonce }));

  return {
    agentIds: [1, 2],
    merchant: MERCHANT,
    expected: {
      limit1: E18(1000).toString(),
      limit2: E18(800).toString(),
      borrow1: E18(100).toString(),
      borrow2: E18(200).toString(),
      fee1: E18(5).toString(),
      repay1a: E18(50).toString(),
      repay1b: E18(55).toString(),
      deposit1: E18(500).toString(),
      deposit2: E18(300).toString(),
    },
  };
}

export async function setupStack() {
  const anvil = await spawnAnvil();
  const deploy = await deployLocal(anvil.rpcUrl);
  const opened = await openTestDb();
  const db = opened.db;
  const closeDb = opened.close;
  const services = await startServices({ db, deploy });
  const sg = signers(anvil.rpcUrl);
  const sendFns = {
    deployer: managedSender(sg.deployer),
    backer1: managedSender(sg.backer1),
    backer2: managedSender(sg.backer2),
  };
  const ctx = {
    anvil, deploy, db, services, signers: sg, sendFns,
    provider: sg.deployer.provider, rpcUrl: anvil.rpcUrl,
    contracts: deploy.contracts, assetAddr: deploy.asset.address,
    availability: services.availability,
  };
  ctx.teardown = async () => {
    await services.stopAll().catch(() => {});
    await closeDb().catch(() => {});
    anvil.kill();
  };
  return ctx;
}

export async function withStack(fn) {
  const ctx = await setupStack();
  try {
    return await fn(ctx);
  } finally {
    await ctx.teardown();
  }
}
