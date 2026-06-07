/**
 * NAVI flashloan integration.
 *
 * Calls NAVI's lending module on SUI testnet. The function names and
 * shared object IDs are config-driven.
 *
 * NAVI's PTB flow (lending module, v2 context API):
 *   1. `lending::flash_loan_with_ctx_v2(config, pool, amount, sui_system)`
 *      returns a tuple (Balance<T>, Receipt).
 *   2. The Balance<T> must be converted to Coin<T> via `coin::from_balance`
 *      and split/swapped through the user-provided path. The Receipt is
 *      a hot potato that must be consumed by step 3 in the same PTB.
 *   3. `lending::flash_repay_with_ctx(clock, storage, pool, receipt, balance)`
 *      consumes the Receipt and returns the leftover balance.
 *
 * The repaying balance must be at least
 *   loan_amount + supplier_fee + treasury_fee
 * which the bot calculates from NAVI's published FlashLoanAsset config
 * (see scripts/discover.ts).
 */

import { Transaction } from '@mysten/sui/transactions';
import type { TransactionObjectArgument, TransactionResult } from '@mysten/sui/transactions';
import type { NaviFlashloanConfig } from '../config.js';

export interface FlashloanBorrowResult {
  /** The borrowed coin (already wrapped from Balance via coin::from_balance). */
  coin: TransactionObjectArgument;
  /** The receipt that must be consumed before the PTB ends. */
  receipt: TransactionResult;
}

export function borrowFlashloan(
  tx: Transaction,
  config: NaviFlashloanConfig,
  sizeIn: bigint
): FlashloanBorrowResult {
  // NAVI's v2 context API takes 4 args. The Sui SDK's TransactionResult
  // is a Proxy that supports tuple-like destructuring at runtime, but
  // the static type is a single Result intersected with an array of
  // NestedResult. We index it directly to avoid the lossy
  // `as unknown as [...]` double cast.
  const result = tx.moveCall({
    target: `${config.packageId}::lending::${config.borrowFn}`,
    arguments: [
      tx.object(config.configId),
      tx.object(config.borrowPoolId),
      tx.pure.u64(sizeIn),
      tx.object(config.suiSystemStateId),
    ],
    typeArguments: [config.borrowCoinType],
  });
  // NAVI's loan returns a (Balance<T>, Receipt) tuple. The Sui SDK's
  // TransactionResult is a Proxy that supports tuple-like destructuring
  // at runtime, but the static type is a single Result intersected
  // with an array of NestedResult. We index it directly to get the
  // Balance (index 0) and the Receipt (index 1).
  const balance = result[0] as TransactionObjectArgument;
  const receipt = result[1] as unknown as TransactionResult;
  // Wrap the Balance<T> into a Coin<T> so the swap path can consume it.
  const coin = tx.moveCall({
    target: '0x2::coin::from_balance',
    arguments: [balance],
    typeArguments: [config.borrowCoinType],
  });
  return { coin, receipt };
}

export function repayFlashloan(
  tx: Transaction,
  config: NaviFlashloanConfig,
  receipt: TransactionResult,
  repayCoin: TransactionObjectArgument
): void {
  // The last moveCall argument is the Balance<T> that NAVI will consume.
  // We extract a Balance from the repay coin via coin::into_balance so
  // we don't need to know its value; NAVI asserts the balance is at
  // least loan + supplier_fee + treasury_fee and returns any surplus.
  const repayBalance = tx.moveCall({
    target: '0x2::coin::into_balance',
    arguments: [repayCoin],
    typeArguments: [config.borrowCoinType],
  });
  tx.moveCall({
    target: `${config.packageId}::lending::${config.repayFn}`,
    arguments: [
      tx.object(config.clockId),
      tx.object(config.storageId),
      tx.object(config.borrowPoolId),
      receipt,
      repayBalance,
    ],
    typeArguments: [config.borrowCoinType],
  });
}
