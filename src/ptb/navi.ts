/**
 * NAVI flashloan integration.
 *
 * Wraps NAVI's flashloan module as a typed helper. The actual function
 * signature depends on the current NAVI contract; the package ID,
 * module name, and function names are config-driven so the bot does not
 * hardcode testnet addresses.
 *
 * Architectural note: NAVI's flashloan uses a "receipt" hot potato that
 * must be consumed in the same PTB by either repayment or settlement.
 * This is the architectural anchor of R4 — if the receipt is not
 * consumed, the PTB is invalid by Sui's PTB type system.
 */

import type { Transaction, TransactionObjectArgument, TransactionResult } from '@mysten/sui/transactions';
import type { FlashloanConfig } from '../config.js';
import type { Pair } from '../dex/types.js';

export interface FlashloanBorrowResult {
  /** The borrowed coin, to be passed into the first swap. */
  coin: TransactionObjectArgument;
  /** The receipt that must be consumed before the PTB ends. */
  receipt: TransactionResult;
}

export function borrowFlashloan(
  tx: Transaction,
  config: FlashloanConfig,
  pair: Pair,
  sizeIn: bigint
): FlashloanBorrowResult {
  const result = tx.moveCall({
    target: `${config.packageId}::${config.moduleName}::${config.borrowFn}`,
    arguments: [tx.pure.u64(sizeIn)],
    typeArguments: [coinTypeFor(pair.quote)],
  });
  const [coin, receipt] = result as unknown as [TransactionObjectArgument, TransactionResult];
  return { coin, receipt };
}

export function repayFlashloan(
  tx: Transaction,
  config: FlashloanConfig,
  pair: Pair,
  coin: TransactionObjectArgument,
  receipt: TransactionResult,
  amount: bigint
): void {
  tx.moveCall({
    target: `${config.packageId}::${config.moduleName}::${config.repayFn}`,
    arguments: [coin, receipt, tx.pure.u64(amount)],
    typeArguments: [coinTypeFor(pair.quote)],
  });
}

function coinTypeFor(symbol: string): string {
  return `0x${symbol.toLowerCase()}::coin::COIN`;
}

// PLACEHOLDER: the helpers in `src/dex/utils.ts` and the local one above
// return synthesized strings, not real Sui coin types. The real type
// registry (e.g. 0x2::sui::SUI) must be wired before the bot is run on
// testnet. Tracked as akorite/sui-flashloan-arb-bot issue #2.
