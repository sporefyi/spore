#!/usr/bin/env node
/**
 * demo-scenario.mjs: end-to-end SPORE demo against a local anvil deployment.
 *
 * Usage (from backend/):
 *   node <path>/demo-scenario.mjs [--deployed <path>] [--rpc <url>] [--allow-live]
 *
 * Reads a deployment manifest (default: new URL('../.deployed.json', import.meta.url),
 * i.e. resolved relative to this script's directory) written by tools/deploy-local.mjs:
 *   {
 *     "chainId": 31337,
 *     "rpcUrl": "http://127.0.0.1:8545",
 *     "deployBlock": 1,
 *     "asset": { "address": "0x...", "decimals": 18 },  // MockUSD on anvil
 *     "contracts": {
 *       "registry": "0x...",      // SporeRegistry
 *       "creditManager": "0x...", // CreditManager
 *       "backerVault": "0x...",   // BackerVault
 *       "scoreOracle": "0x...",   // ScoreOracle
 *       "feeRouter": "0x..."      // FeeRouter
 *     }
 *   }
 *
 * (Older manifests nested the asset address at contracts.asset — also accepted.)
 *
 * Operator/underwriter key: anvil account #0 (override with OPERATOR_KEY env var).
 * NOTE: the key in the task text was malformed (66 hex chars); the standard anvil
 * account #0 key below (64 hex chars) is used instead.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const REQUIRED = ['registry', 'creditManager', 'backerVault', 'scoreOracle', 'feeRouter'];

const ABI = {
  asset: [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function mint(address to, uint256 amount)',
  ],
  registry: ['function registerAgent(string metadataURI) returns (uint256 agentId)'],
  vault: [
    'function deposit(uint256 agentId, uint256 amount)',
    'function absorbDefault(uint256 agentId)',
  ],
  cm: [
    'function issueLine(uint256 agentId, uint256 limit, uint16 feeBps)',
    'function setMerchantAllowed(address merchant, bool allowed)',
    'function borrow(uint256 agentId, uint256 amount, address merchant)',
    'function repay(uint256 agentId, uint256 amount)',
    'function getLine(uint256) view returns (tuple(uint256 limit,uint256 drawn,uint256 feeOwed,uint16 feeBps,uint64 issuedAt,bool active,bool defaulted))',
  ],
};

const txs = [];
const results = [];
// U()/fmt() are defined inside main() — they need the asset decimals from the manifest.

function die(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { deployed: null, rpc: null, allowLive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--deployed') out.deployed = argv[++i] ?? die('--deployed requires a path');
    else if (a === '--rpc') out.rpc = argv[++i] ?? die('--rpc requires a URL');
    else if (a === '--allow-live') out.allowLive = true;
    else die(`unknown argument: ${a}`);
  }
  return out;
}

function loadDeployed(path) {
  if (!fs.existsSync(path)) die(`deployment file not found: ${path} (run tools/deploy-local.mjs first)`);
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    die(`deployment file is not valid JSON: ${path} (${e.message})`);
  }
  const problems = [];
  if (!Number.isInteger(d.chainId)) problems.push('missing/invalid "chainId"');
  if (typeof d.rpcUrl !== 'string' || !d.rpcUrl) problems.push('missing/invalid "rpcUrl"');
  if (!d.contracts || typeof d.contracts !== 'object') problems.push('missing "contracts" object');
  else {
    for (const k of REQUIRED) {
      if (!ethers.isAddress(d.contracts[k])) problems.push(`contracts.${k} missing or not a valid address (${d.contracts[k]})`);
    }
  }
  if (problems.length) die(`invalid deployment file ${path}:\n  - ${problems.join('\n  - ')}`);
  // Asset address: deploy-local writes asset: {address, decimals}; accept legacy contracts.asset too.
  const assetAddr =
    (d.contracts && ethers.isAddress(d.contracts.asset) && d.contracts.asset) ||
    (d.asset && ethers.isAddress(d.asset.address) && d.asset.address) || null;
  if (!assetAddr) die(`invalid deployment file ${path}:\n  - missing asset address (contracts.asset or asset.address)`);
  d.assetAddress = assetAddr;
  d.assetDecimals = (d.asset && Number.isInteger(d.asset.decimals) && d.asset.decimals) || 18;
  return d;
}

function reason(e) {
  return (
    e?.revert?.name && `${e.revert.name}(${(e.revert.args ?? []).join(', ')})`
  ) || e?.reason || e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
}

/** Build a tx with an explicit nonce, broadcast, wait 1 confirmation, print label + hash; exit 1 on revert.
 * Explicit nonces per signer work around the ethers v6 + anvil "nonce has already
 * been used" race on rapid sequential sends. Call as: send(label, signer, (o) => contract.fn(args, o)) */
async function send(label, signer, build) {
  try {
    const addr = await signer.getAddress();
    if (!nonceMap.has(addr)) nonceMap.set(addr, await nonceProvider.getTransactionCount(addr, 'pending'));
    const nonce = nonceMap.get(addr);
    nonceMap.set(addr, nonce + 1);
    const tx = await build({ nonce });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error('transaction reverted (status 0)');
    txs.push({ label, hash: receipt.hash });
    console.log(`  [tx] ${label.padEnd(34)} ${receipt.hash}`);
    return receipt;
  } catch (e) {
    console.error(`  [REVERT] ${label}: ${reason(e)}`);
    process.exit(1);
  }
}

// Set by main() before any send(): the provider used for nonce reads.
let nonceProvider = null;
const nonceMap = new Map();

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`  -> ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
}

const line = (l) => ({ limit: l[0], drawn: l[1], feeOwed: l[2], feeBps: l[3], issuedAt: l[4], active: l[5], defaulted: l[6] });
// showLine lives inside main() — it needs main's decimals-aware fmt().

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deployedPath = args.deployed ?? fileURLToPath(new URL('../.deployed.json', import.meta.url));
  const deployed = loadDeployed(deployedPath);
  const rpcUrl = args.rpc ?? deployed.rpcUrl;
  const c = deployed.contracts;

  // Safety guard + chain id verification (fail fast).
  if (deployed.chainId !== 31337 && !args.allowLive) {
    die(`deployed.chainId=${deployed.chainId} is not 31337 (anvil); pass --allow-live to override`);
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, ethers.Network.from(deployed.chainId), {
    staticNetwork: ethers.Network.from(deployed.chainId),
  });
  let liveChainId;
  try {
    liveChainId = BigInt(await provider.send('eth_chainId', []));
  } catch (e) {
    die(`cannot reach RPC ${rpcUrl}: ${reason(e)}`);
  }
  if (liveChainId !== BigInt(deployed.chainId)) {
    die(`chainId mismatch: RPC reports ${liveChainId}, deployment file says ${deployed.chainId}`);
  }
  if (liveChainId !== 31337n && !args.allowLive) {
    die(`RPC chainId ${liveChainId} is not 31337 (anvil); pass --allow-live to override`);
  }
  nonceProvider = provider; // enable explicit nonce management in send()
  for (const k of REQUIRED) {
    if ((await provider.getCode(c[k])) === '0x') die(`no contract code at contracts.${k} (${c[k]}); stale .deployed.json?`);
  }
  if ((await provider.getCode(deployed.assetAddress)) === '0x') die(`no contract code at asset (${deployed.assetAddress}); stale .deployed.json?`);

  console.log(`SPORE demo | chain ${liveChainId} | rpc ${rpcUrl}`);
  console.log(`manifest: ${deployedPath}\n`);

  // Asset decimals come from the manifest (18 on anvil's MockUSD).
  const DEC = deployed.assetDecimals;
  const U = (n) => ethers.parseUnits(String(n), DEC);
  const fmt = (v) => ethers.formatUnits(v, DEC);
  const showLine = (tag, l) =>
    console.log(`  [${tag}] drawn=${fmt(l.drawn)} feeOwed=${fmt(l.feeOwed)} active=${l.active} defaulted=${l.defaulted}`);

  // Wallets
  const operator = new ethers.Wallet(process.env.OPERATOR_KEY ?? ANVIL_KEY, provider);
  const owners = [ethers.Wallet.createRandom().connect(provider), ethers.Wallet.createRandom().connect(provider)];
  const merchant = ethers.Wallet.createRandom().connect(provider);
  console.log(`operator : ${operator.address}`);
  owners.forEach((w, i) => console.log(`owner ${i + 1}  : ${w.address}`));
  console.log(`merchant : ${merchant.address}\n`);

  const asset = new ethers.Contract(deployed.assetAddress, ABI.asset, operator);
  const registry = new ethers.Contract(c.registry, ABI.registry, operator);
  const vault = new ethers.Contract(c.backerVault, ABI.vault, operator);
  const cm = new ethers.Contract(c.creditManager, ABI.cm, operator);

  // Setup: gas funding
  console.log('== Setup ==');
  for (const [name, w, eth] of [['owner-1', owners[0], '0.5'], ['owner-2', owners[1], '0.5'], ['merchant', merchant, '0.01']]) {
    await send(`fund ETH -> ${name}`, operator, (o) => operator.sendTransaction({ to: w.address, value: ethers.parseEther(eth), ...o }));
  }

  // Setup: asset funding + approvals
  const vaultNeed = U(10000);
  const repayNeed = U(1000);
  const need = vaultNeed + repayNeed;
  let minted = false;
  try {
    await asset.mint.staticCall(operator.address, U(100000));
    minted = true;
  } catch {
    /* no mint available / not permitted */
  }
  if (minted) await send('mint asset -> operator', operator, (o) => asset.mint(operator.address, U(100000), o));
  const bal = await asset.balanceOf(operator.address);
  if (bal === 0n) die('operator asset balance is 0 and asset.mint is unavailable; fund the operator manually');
  if (bal < need) die(`operator asset balance ${fmt(bal)} < required ${fmt(need)}`);
  await send('approve asset -> BackerVault', operator, (o) => asset.approve(c.backerVault, vaultNeed, o));
  await send('approve asset -> CreditManager', operator, (o) => asset.approve(c.creditManager, repayNeed, o));

  // a. register
  console.log('\n== a. registerAgent ==');
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const reg = registry.connect(owners[i]);
    const uri = `spore://demo/agent-${i + 1}`;
    const id = await reg.registerAgent.staticCall(uri).catch((e) => die(`registerAgent simulation failed: ${reason(e)}`));
    await send(`registerAgent agent-${i + 1}`, owners[i], (o) => reg.registerAgent(uri, o));
    ids.push(id);
    console.log(`  agent ${i + 1} id = ${id}`);
  }
  check('register', ids.length === 2 && ids[0] !== ids[1]);
  const [id1, id2] = ids;

  // b. deposit
  console.log('\n== b. sponsor deposits ==');
  await send('deposit 5000 -> agent 1 pool', operator, (o) => vault.deposit(id1, U(5000), o));
  await send('deposit 5000 -> agent 2 pool', operator, (o) => vault.deposit(id2, U(5000), o));
  check('deposit', true);

  // c. issue lines
  console.log('\n== c. issueLine ==');
  await send('issueLine agent 1 (1000, 5%)', operator, (o) => cm.issueLine(id1, U(1000), 500, o));
  await send('issueLine agent 2 (500, 5%)', operator, (o) => cm.issueLine(id2, U(500), 500, o));
  const l1 = line(await cm.getLine(id1));
  const l2 = line(await cm.getLine(id2));
  check('issueLine', l1.limit === U(1000) && l2.limit === U(500) && l1.active && l2.active,
    `limits ${fmt(l1.limit)} / ${fmt(l2.limit)}`);

  // d. merchant allowlist
  console.log('\n== d. setMerchantAllowed ==');
  await send('setMerchantAllowed(merchant)', operator, (o) => cm.setMerchantAllowed(merchant.address, true, o));
  check('merchant allowlist', true);

  // e. agent 1 borrows 400
  console.log('\n== e. agent 1 borrows 400 ==');
  const mBefore = await asset.balanceOf(merchant.address);
  await send('borrow 400 (agent 1 -> merchant)', owners[0], (o) => cm.connect(owners[0]).borrow(id1, U(400), merchant.address, o));
  const mDelta = (await asset.balanceOf(merchant.address)) - mBefore;
  check('borrow agent 1', mDelta === U(400), `merchant +${fmt(mDelta)}`);
  showLine('agent1', line(await cm.getLine(id1)));

  // F. partial repay 200, paid by operator (anyone-may-pay path)
  const lBefore = line(await cm.getLine(id1));
  showLine('agent1 before partial repay', lBefore);
  await send('repay 200 (agent 1, payer=operator)', operator, (o) => cm.repay(id1, U(200), o));
  const lAfter = line(await cm.getLine(id1));
  showLine('agent1 after partial repay', lAfter);
  const drawnBefore = lBefore.drawn;
  const feePaid = lBefore.feeOwed < U(200) ? lBefore.feeOwed : U(200); // fee-first waterfall
  const drawnAfter = lAfter.drawn;
  console.log(`  feeOwed before=${fmt(lBefore.feeOwed)} after=${fmt(lAfter.feeOwed)}`);
  check('partial repay',
    lAfter.feeOwed === lBefore.feeOwed - feePaid && drawnAfter === drawnBefore - (U(200) - feePaid),
    `drawn ${fmt(drawnBefore)} -> ${fmt(drawnAfter)}, fee ${fmt(lBefore.feeOwed)} -> ${fmt(lAfter.feeOwed)}`);

  // G. full repay
  let l = line(await cm.getLine(id1));
  const owed = l.drawn + l.feeOwed;
  await send('repay remainder (full)', operator, (o) => cm.repay(id1, owed, o));
  l = line(await cm.getLine(id1));
  check('full repay', l.drawn === 0n, `drawn=${fmt(l.drawn)} feeOwed=${fmt(l.feeOwed)}`);
  showLine('agent1 after full repay', l);

  // H. agent 2 borrows 300
  await send('borrow 300 (agent 2 -> merchant)', owners[1], (o) => cm.connect(owners[1]).borrow(id2, U(300), merchant.address, o));
  check('borrow agent 2', (line(await cm.getLine(id2))).drawn === U(300), 'agent 2 drawn = 300');

  // I. absorbDefault on agent 2
  await send('absorbDefault agent 2', operator, (o) => vault.absorbDefault(id2, o));
  l = line(await cm.getLine(id2));
  check('default', l.defaulted === true && l.drawn === 0n, 'line defaulted, drawn=0');
  showLine('agent2', l);

  // SUMMARY
  console.log('\n===== DEMO SUMMARY =====');
  console.log('Agent | Limit | Drawn | FeeOwed | Active | Defaulted');
  for (const [name, id] of [['agent1', id1], ['agent2', id2]]) {
    const s = line(await cm.getLine(id));
    console.log(`${name} (#${id}) | ${fmt(s.limit)} | ${fmt(s.drawn)} | ${fmt(s.feeOwed)} | ${s.active} | ${s.defaulted}`);
  }

  console.log('\nTransactions:');
  txs.forEach((t, i) => {
    if (typeof t === 'string') {
      console.log(`${i + 1}. ${t}`);
    } else {
      const lbl = t.label ?? t.name ?? `tx${i + 1}`;
      const h = t.hash ?? t.txHash ?? '';
      console.log(`${i + 1}. ${lbl}: ${h}`);
    }
  });

  console.log('\nChecklist:');
  let passes = 0;
  for (const r of results) {
    const ok = Boolean(r.ok ?? r.pass ?? r.passed);
    if (ok) passes++;
    const nm = r.name ?? r.label ?? '';
    const dt = r.detail ?? '';
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${nm}${dt ? ' - ' + dt : ''}`);
  }
  const allPassed = passes === results.length;
  console.log(`\nRESULT: ${passes}/${results.length} checks passed`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e?.message ?? e); process.exit(1); });
