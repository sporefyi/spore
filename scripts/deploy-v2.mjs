import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const SPORE = '0xa5127fae2d0986a4cb6619b9c4ec53461726454b';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const w = JSON.parse(fs.readFileSync('/home/hatch/workspace/spore-wallet/deployer.json', 'utf8'));
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(w.privateKey, provider);
console.log('deployer:', wallet.address);

const outDir = '/home/hatch/workspace/spore/contracts/out';
function artifact(name) {
  const p = path.join(outDir, `${name}.sol`, `${name}.json`);
  const art = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Foundry nests bytecode as {object, ...}
  const bytecode = typeof art.bytecode === 'object' ? art.bytecode.object : art.bytecode;
  return { abi: art.abi, bytecode };
}

let nonce = await provider.getTransactionCount(wallet.address, 'latest');
const deployed = {};

async function deploy(name, args = []) {
  const art = artifact(name);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const tx = await factory.getDeployTransaction(...args);
  tx.nonce = nonce++;
  tx.gasLimit = 10000000;
  const sent = await wallet.sendTransaction(tx);
  console.log(`${name}: tx ${sent.hash} (nonce ${tx.nonce})`);
  const receipt = await sent.wait();
  console.log(`${name} deployed at: ${receipt.contractAddress}`);
  deployed[name] = receipt.contractAddress;
  return receipt.contractAddress;
}

// 1. SporeVotes
const votesAddr = await deploy('SporeVotes', [SPORE]);

// 2. TimelockController (2-day delay = 172800s)
const timelockArtifact = artifact('TimelockController');
const timelockFactory = new ethers.ContractFactory(timelockArtifact.abi, timelockArtifact.bytecode, wallet);
const timelockTx = await timelockFactory.getDeployTransaction(172800, [wallet.address], [wallet.address], wallet.address);
timelockTx.nonce = nonce++;
timelockTx.gasLimit = 10000000;
const timelockSent = await wallet.sendTransaction(timelockTx);
console.log(`TimelockController: tx ${timelockSent.hash}`);
const timelockReceipt = await timelockSent.wait();
console.log(`TimelockController deployed at: ${timelockReceipt.contractAddress}`);
deployed['TimelockController'] = timelockReceipt.contractAddress;

// 3. SporeGovernor
await deploy('SporeGovernor', [votesAddr, deployed['TimelockController']]);

// 4. SporeBuyback (router = zero address placeholder, settable later)
await deploy('SporeBuyback', [USDG, SPORE, wallet.address, ethers.ZeroAddress]);

// 5. BackerSporeStake
await deploy('BackerSporeStake', [SPORE, wallet.address]);

// 6. OracleBond (treasury = deployer, slasher = deployer for now)
await deploy('OracleBond', [SPORE, wallet.address, wallet.address, wallet.address]);

console.log('\n=== DEPLOYED ===');
console.log(JSON.stringify(deployed, null, 2));
fs.writeFileSync('/tmp/spore-v2-deployed.json', JSON.stringify(deployed, null, 2));
