/**
 * scripts/smoke-deepbook.ts
 *
 * Round-trip smoke test for the DeepBookV3 flashloan integration.
 *
 * Builds a 2-call PTB against SUI mainnet:
 *   1. deepbook::pool::borrow_flashloan_base(DEEP/USDC pool, 1_000 DEEP)
 *      -> (Coin<DEEP>, FlashLoan)
 *   2. deepbook::pool::return_flashloan_base(DEEP/USDC pool, coin, FlashLoan)
 *
 * No swap, no external coins — just exercise the borrow/repay pair.
 * Calls sui_devInspectTransactionBlock to dry-run the PTB.
 *
 * Expected outcomes:
 *   - status=success when the DeepBookV3 package is correctly
 *     addressed and the pool object is reachable. The PTB is
 *     execution-ready on a funded sender.
 *   - status=failure with a clear error message (e.g.
 *     "MoveAbort ... at deepbook::vault") if the pool ID or
 *     package ID is wrong. The error message is enough to
 *     diagnose; the wiring either works or it doesn't.
 *
 * Usage:
 *   SUI_PRIVATE_KEY=... npx tsx scripts/smoke-deepbook.ts
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromB64 } from '@mysten/sui/utils';
import { loadConfig, isDeepbookFlashloan } from '../src/config.js';
import { borrowFlashloan, repayFlashloan } from '../src/ptb/deepbook.js';

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
  if (!isDeepbookFlashloan(config.flashloan)) {
    console.error('Config `flashloan.provider` must be "deepbook" for this smoke test.');
    console.error('Set provider in config.json and rerun.');
    process.exit(1);
  }
  const rpcUrl = ['testnet', 'mainnet', 'devnet', 'localnet'].includes(config.rpcUrl)
    ? getFullnodeUrl(config.rpcUrl as 'testnet' | 'mainnet' | 'devnet' | 'localnet')
    : config.rpcUrl;
  const client = new SuiClient({ url: rpcUrl });
  const sender = await resolveSender(config.privateKey);

  const fl = config.flashloan;
  console.log(`Sender:        ${sender}`);
  console.log(`RPC:           ${rpcUrl}`);
  console.log(`Package:       ${fl.packageId}`);
  console.log(`Pool:          ${fl.borrowPoolId}`);
  console.log(`Base / Quote:  ${fl.borrowBaseType}  /  ${fl.borrowQuoteType}`);
  console.log();

  // 1_000 DEEP = 1_000 * 1_000_000 raw (DEEP has 6 decimals).
  // 1_000 DEEP is well above the pool's min_size of 10 DEEP and well
  // below any liquidity cap.
  const borrowAmount = 1_000_000_000n;

  const tx = new Transaction();
  tx.setSender(sender);

  console.log(`Building PTB: deepbook::pool::borrow_flashloan_base(${borrowAmount}) -> return_flashloan_base(...)\n`);
  const { coin, flashLoan } = borrowFlashloan(tx, fl, borrowAmount);
  repayFlashloan(tx, fl, coin, flashLoan);

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
    process.exit(1);
  }

  if (inspect.error && inspect.effects?.status?.status === 'success') {
    console.log('devInspect returned an error:');
    console.log(`  error: ${inspect.error}`);
    process.exit(1);
  }

  const status = inspect.effects?.status?.status;
  const errMsg = inspect.effects?.status?.error ?? '';
  if (status === 'success') {
    console.log('devInspect SUCCEEDED');
    console.log(`  status: ${status}`);
    console.log(`  gasUsed: ${JSON.stringify(inspect.effects.gasUsed)}`);
    console.log('\n[OK] DeepBookV3 flashloan integration is fully wired.');
    console.log('  - borrow 1000 DEEP: succeeded');
    console.log('  - return_flashloan_base: succeeded');
    console.log('  - PTB is execution-ready on a funded sender');
    return;
  }

  console.log(`PTB dry-run reverted: ${errMsg}`);
  if (errMsg.includes('Package object does not exist')) {
    console.log('\n[!] The configured DeepBookV3 package is not deployed on this network.');
    console.log('    The deepbook package ID is mainnet V6 (Jan 2026):');
    console.log('    0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497');
  } else if (errMsg.includes('is not an object')) {
    console.log('\n[!] The configured borrow pool ID is not a valid object.');
  } else if (errMsg.includes('MoveAbort') || errMsg.includes('abort')) {
    console.log('\n[!] PTB reached on-chain logic but aborted. Check:');
    console.log('    1. The pool exists and is a DeepBookV3 Pool<DEEP, USDC>.');
    console.log('    2. The pool has enough DEEP for the borrow.');
    console.log('    3. The type arguments [borrowBaseType, borrowQuoteType] match the pool.');
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('smoke-deepbook failed:', err);
  process.exit(1);
});
