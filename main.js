// main.js — SIHITAM bridge bot (Jumper/LI.FI)
// Dep: npm i @lifi/sdk@latest viem

import fs from 'fs';
import { setTimeout as wait } from 'timers/promises';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { EVM, createConfig as createLifiConfig, getQuote, convertQuoteToRoute, executeRoute } from '@lifi/sdk';
import { createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ========== BANNER ==========
function showBanner() {
  console.log('\x1b[1;37m'); // putih tebal
  console.log('███████ ██ ██   ██ ██ ████████  █████  ███    ███');
  console.log('██      ██ ██   ██ ██    ██    ██   ██ ████  ████');
  console.log('███████ ██ ███████ ██    ██    ███████ ██ ████ ██');
  console.log('     ██ ██ ██   ██ ██    ██    ██   ██ ██  ██  ██');
  console.log('███████ ██ ██   ██ ██    ██    ██   ██ ██      ██');
  console.log('\x1b[0m'); // reset
  console.log('\x1b[30;47m%s\x1b[0m', '                   S I H I T A M                   ');
  console.log('\n');
}

// ========== CHAINS ==========
const CHAINS = {
  BASE:      { id: 8453,  key: '1', name: 'Base',           rpc: 'https://mainnet.base.org' },
  OP:        { id: 10,    key: '2', name: 'OP Mainnet',     rpc: 'https://mainnet.optimism.io' },
  ARBITRUM:  { id: 42161, key: '3', name: 'Arbitrum One',   rpc: 'https://arb1.arbitrum.io/rpc' },
  INK:       { id: 57073, key: '4', name: 'Ink',            rpc: 'https://rpc-gel.inkonchain.com' },
};
const BY_KEY = Object.fromEntries(Object.values(CHAINS).map(c => [c.key, c]));
const BY_ID  = Object.fromEntries(Object.values(CHAINS).map(c => [c.id,  c]));
const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';

// ========== HELPERS ==========
function loadPrivateKeys(file = 'account.txt') {
  if (!fs.existsSync(file)) throw new Error(`File ${file} tidak ditemukan.`);
  const lines = fs.readFileSync(file, 'utf8')
    .split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
  if (!lines.length) throw new Error('account.txt kosong.');
  return lines.map(k => (k.startsWith('0x') ? k : `0x${k}`));
}

function randomDelayMs(minSec = 5, maxSec = 20) {
  return (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
}

function makeClient(pk, chain) {
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    account,
    chain: {
      id: chain.id,
      name: chain.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [chain.rpc] } },
    },
    transport: http(chain.rpc),
  });
}

function logHeader(title) {
  console.log('\n' + '-'.repeat(70));
  console.log(title);
  console.log('-'.repeat(70));
}

// ========== LI.FI glue ==========
function setLifiProvider(client) {
  const evmProvider = EVM({
    getWalletClient: async () => client,
    switchChain: async (chainId) => {
      const chain = BY_ID[chainId];
      if (!chain) throw new Error(`RPC untuk chain ${chainId} belum diset.`);
      return makeClient(client.account.source, chain); // pakai pk yang disimpan di .source
    },
  });

  createLifiConfig({
    integrator: 'sihitam-auto-bridge-bot',
    providers: [evmProvider],
    preloadChains: true, // penting agar LI.FI kenal chain IDs
  });
}

// ========== PROMPTS ==========
async function promptRunConfig() {
  const rl = new readline.Interface({ input, output });

  console.log('Pilih chain SUMBER (1 pilihan):');
  console.log('  1) Base (8453)');
  console.log('  2) OP Mainnet (10)');
  console.log('  3) Arbitrum One (42161)');
  console.log('  4) Ink (57073)');
  const srcKey = (await rl.question('Masukkan 1 angka (contoh: 2 untuk Optimism): ')).trim();
  const srcChain = BY_KEY[srcKey];
  if (!srcChain) { rl.close(); throw new Error('Pilihan chain sumber tidak valid.'); }

  console.log('\nPilih chain TUJUAN (boleh lebih dari satu, pisahkan dengan koma):');
  console.log('  1) Base | 2) OP | 3) Arbitrum | 4) Ink');
  const destSel = (await rl.question('Masukkan (contoh: 4 untuk ke Ink, atau 3,4): ')).trim();
  const destKeys = destSel ? destSel.split(',').map(s => s.trim()) : [];
  let targets = destKeys.map(k => BY_KEY[k]?.id).filter(Boolean);
  targets = targets.filter(id => id !== srcChain.id);
  if (!targets.length) { rl.close(); throw new Error('Tidak ada chain tujuan yang valid.'); }

  const cyclesStr = (await rl.question('\nBerapa kali bridge ingin dijalankan? [default 1]: ')).trim();
  const cycles = cyclesStr ? Number(cyclesStr) : 1;
  if (!Number.isInteger(cycles) || cycles <= 0) { rl.close(); throw new Error('Jumlah cycle tidak valid.'); }

  const amountStr = (await rl.question('\nAmount (ETH) yang ingin di-bridge [default 0.01]: ')).trim();
  const amountEth = amountStr ? Number(amountStr) : 0.01;
  if (!Number.isFinite(amountEth) || amountEth <= 0) { rl.close(); throw new Error('Amount tidak valid.'); }

  const slipStr = (await rl.question('Slippage (desimal, 0.005=0.5%) [default 0.005]: ')).trim();
  const slippage = slipStr ? Number(slipStr) : 0.005;
  if (!Number.isFinite(slippage) || slippage <= 0) { rl.close(); throw new Error('Slippage tidak valid.'); }

  const reserveStr = (await rl.question(`Reserve ETH di ${srcChain.name} (gas) [default 0.001]: `)).trim();
  const reserveSrcEth = reserveStr ? Number(reserveStr) : 0.001;
  if (!Number.isFinite(reserveSrcEth) || reserveSrcEth < 0) { rl.close(); throw new Error('Reserve tidak valid.'); }

  const fuelYesNo = (await rl.question('Gunakan LI.Fuel (kirim gas ke chain tujuan)? [y/N]: ')).trim().toLowerCase();
  let destGasEth = 0;
  if (fuelYesNo === 'y' || fuelYesNo === 'yes') {
    const gasStr = (await rl.question('Jumlah gas di chain tujuan (ETH) [contoh 0.0002]: ')).trim();
    destGasEth = gasStr ? Number(gasStr) : 0;
    if (!Number.isFinite(destGasEth) || destGasEth < 0) { rl.close(); throw new Error('Jumlah gas tujuan tidak valid.'); }
  }

  rl.close();
  return { srcChain, targets, cycles, amountEth, slippage, reserveSrcEth, destGasEth };
}

// ========== CORE BRIDGE ==========
async function bridgeOnce({ client, fromChain, toChainId, amountEth, slippage, destGasEth }) {
  const fromAddress = client.account.address;
  const fromAmountWei = parseEther(String(amountEth));
  const gasDestWei = destGasEth > 0 ? parseEther(String(destGasEth)) : undefined;

  logHeader(`[${fromAddress}] Bridge ${amountEth} ETH | ${fromChain.name} → ${BY_ID[toChainId].name}`);

  const quote = await getQuote({
    fromChain: fromChain.id,
    toChain: toChainId,
    fromToken: ADDRESS_ZERO,
    toToken: ADDRESS_ZERO,
    fromAmount: fromAmountWei.toString(),
    fromAddress,
    toAddress: fromAddress,
    slippage,
    ...(gasDestWei ? { fromAmountForGas: gasDestWei.toString() } : {}),
  });

  const route = convertQuoteToRoute(quote);

  await executeRoute(route, {
    updateRouteHook(updated) {
      updated.steps.forEach((step, i) => {
        const proc = step.execution?.process?.at(-1);
        const label = `[Step ${i + 1}] ${step.type} | ${step.action.fromChainId}→${step.action.toChainId}`;
        if (proc?.message) console.log(`${label} :: ${proc.message}`);
        if (proc?.status)  console.log(`${label} :: status=${proc.status}`);
        if (proc?.txHash)  console.log(`${label} :: tx=${proc.txHash}`);
      });
    },
    acceptExchangeRateUpdateHook: async () => true,
  });

  console.log(`✅ Selesai: ${amountEth} ETH ${fromChain.name} → ${BY_ID[toChainId].name}`);
}

// ========== MAIN ==========
async function main() {
  showBanner();

  const { srcChain, targets, cycles, amountEth, slippage, reserveSrcEth, destGasEth } = await promptRunConfig();
  const privateKeys = loadPrivateKeys('account.txt');

  for (const [i, pk] of privateKeys.entries()) {
    logHeader(`Wallet ${i + 1}`);
    const srcClient = makeClient(pk, srcChain);
    srcClient.account.source = pk; // simpan pk untuk switchChain glue
    setLifiProvider(srcClient);

    // (Opsional) TODO: cek saldo & auto-adjust amount agar sisa >= reserveSrcEth

    for (let cycle = 1; cycle <= cycles; cycle++) {
      console.log(`\n=== Cycle ${cycle}/${cycles} ===`);
      for (const toChainId of targets) {
        try {
          await bridgeOnce({ client: srcClient, fromChain: srcChain, toChainId, amountEth, slippage, destGasEth });
        } catch (err) {
          console.error(`❌ Gagal bridge ke ${BY_ID[toChainId].name}:`, err?.message || err);
        }
        const d = randomDelayMs(5, 20);
        console.log(`⏳ Delay ${(d / 1000).toFixed(0)} detik...\n`);
        await wait(d);
      }
    }
  }

  console.log('\n--- DONE ---');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
