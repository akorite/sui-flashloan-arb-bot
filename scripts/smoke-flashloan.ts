/**
 * scripts/smoke-flashloan.ts
 *
 * Builds a minimal PTB that borrows the minimum amount (3 SUI) from
 * NAVI's SUI flashloan pool and immediately repays it with the fee.
 * Then calls sui_devInspectTransactionBlock to dry-run the PTB
 * against SUI testnet.
 *
 * If the NAVI integration is correct, devInspect returns
 * `status: 'success'` without committing anything. This proves:
 *   - the NAVI function names (flash_loan_with_ctx_v2,
 *     flash_repay_with_ctx) are right
 *   - the shared object IDs (configId, storageId, suiSystemStateId,
 *     clockId, borrowPoolId) are right
 *   - the type arguments (0x2::sui::SUI) are right
 *   - the fee math is right
 *
 * It does NOT submit the transaction; no testnet SUI is spent.
 *
 * Usage:
 *   SUI_PRIVATE_KEY=... npx tsx scripts/smoke-flashloan.ts
 *   (the key is only used to populate the sender address; signing is
 *   not required for devInspect)
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromB64 } from '@mysten/sui/utils';
import { loadConfig } from '../src/config.js';
import { borrowFlashloan, repayFlashloan } from '../src/ptb/navi.js';

async function resolveKeypair(secret: string): Promise<Ed25519Keypair> {
  if (secret.startsWith('suiprivkey1')) return Ed25519Keypair.fromSecretKey(secret);
  const bytes = fromB64(secret);
  const decoded = new TextDecoder().decode(bytes);
  if (decoded.startsWith('suiprivkey1')) return Ed25519Keypair.fromSecretKey(decoded);
  return Ed25519Keypair.fromSecretKey(bytes);
}

async function resolveSender(privateKeyEnv: string): Promise<string> {
  if (privateKeyEnv.startsWith('env:')) {
    const name = privateKeyEnv.slice(4);
    const fromEnv = process.env[name];
    if (!fromEnv) throw new Error(`env:${name} not set`);
    const kp = await resolveKeypair(fromEnv);
    return kp.getPublicKey().toSuiAddress();
  }
  const kp = await resolveKeypair(privateKeyEnv);
  return kp.getPublicKey().toSuiAddress();
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Resolve the rpcUrl: bare names map to Sui's defaults; otherwise use the URL.
  const rpcUrl = ['testnet', 'mainnet', 'devnet', 'localnet'].includes(config.rpcUrl)
    ? getFullnodeUrl(config.rpcUrl as 'testnet' | 'mainnet' | 'devnet' | 'localnet')
    : config.rpcUrl;
  const client = new SuiClient({ url: rpcUrl });
  const sender = await resolveSender(config.privateKey);

  console.log(`Sender:  ${sender}`);
  console.log(`RPC:     ${rpcUrl}`);
  console.log(`Package: ${config.flashloan.packageId}`);
  console.log(`Pool:    ${config.flashloan.borrowPoolId}`);
  console.log();

  // NAVI's SUI pool min is 3 SUI (= 3_000_000_000 MIST). Borrow 3 SUI
  // to exercise the minimum-size path.
  const borrowAmount = 3_000_000_000n;

  const tx = new Transaction();
  tx.setSender(sender);

  console.log('Building PTB: NAVI::flash_loan_with_ctx_v2(3 SUI) -> NAVI::flash_repay_with_ctx(...)...');
  const { coin, receipt } = borrowFlashloan(tx, config.flashloan, borrowAmount);
  // The "swap" step in a real arb is replaced here by a no-op: split
  // the borrowed coin into 3 SUI (the loan amount) and the fee, then
  // merge the two back together and repay. This proves the NAVI
  // contract accepts the input shape; a real arb inserts DEX swaps
  // between these two calls.
  //
  // NAVI's SUI flashloan fee is 5 bps (0.0005). For 3 SUI borrow:
  //   supplier fee  = 3 SUI * 4 / 10_000 = 1_200_000 MIST
  //   treasury fee  = 3 SUI * 1 / 10_000 =   300_000 MIST
  //   total fee     = 1_500_000 MIST
  //   repay amount  = 3_000_000_000 + 1_500_000 = 3_001_500_000
  const fee = (borrowAmount * 5n) / 10_000n;
  const repayAmount = borrowAmount + fee;
  console.log(`Fee: ${fee} MIST, repay total: ${repayAmount} MIST`);

  // Split the coin so the leftover becomes "swap output" + the
  // original 3 SUI plus the fee is the repay balance.
  const splitTx = tx.splitCoins(coin, [repayAmount]);
  repayFlashloan(tx, config.flashloan, receipt, splitTx);
  tx.transferObjects([coin], sender);

  console.log('\nCalling sui_devInspectTransactionBlock...');
  let inspect;
  try {
    inspect = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.log('devInspect FAILED (thrown by SDK before reaching the chain):');
    console.log(`  error: ${msg}`);
    if (msg.includes('Package object does not exist')) {
      console.log('\n[!] The configured NAVI package is not deployed on this network.');
      console.log('    Two options:');
      console.log('    1. NAVI is on SUI DEVNET, not SUI TESTNET. To run against devnet,');
      console.log('       set config.rpcUrl to "devnet" and re-run.');
      console.log('    2. Pick a different flashloan provider (e.g. Suilend) and update');
      console.log('       the config.flashloan block accordingly.');
    }
    process.exit(1);
  }

  if (inspect.error) {
    console.log('devInspect returned an error:');
    console.log(`  error: ${inspect.error}`);
    if (inspect.effects) {
      console.log(`  status: ${inspect.effects.status.status}`);
      console.log(`  statusError: ${inspect.effects.status.error ?? 'none'}`);
    }
    process.exit(1);
  }

  console.log('devInspect SUCCEEDED');
  console.log(`  status: ${inspect.effects?.status?.status}`);
  console.log(`  gasUsed: ${JSON.stringify(inspect.effects?.gasUsed)}`);

  if (inspect.effects?.status?.status !== 'success') {
    console.log(`\nPTB dry-run reverted: ${inspect.effects?.status?.error}`);
    process.exit(1);
  }

  console.log('\n[OK] NAVI flashloan integration is wired correctly.');
  console.log('Next step: fill in the DEX router package IDs and pool object IDs in config.json,');
  console.log('then run `npm start` to begin scanning for real opportunities.');
}

main().catch((err) => {
  console.error('smoke test failed:', err);
  process.exit(1);
});
