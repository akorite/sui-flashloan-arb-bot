/**
 * DeepBookV3 flashloan integration.
 *
 * DeepBookV3 exposes free (0 bps) flashloans via the hot-potato
 * pattern. A successful call to
 *   deepbook::pool::borrow_flashloan_base<BaseAsset, QuoteAsset>(pool, amount, ctx)
 * returns `(Coin<BaseAsset>, FlashLoan)`. The `FlashLoan` is a
 * struct with NO abilities — it cannot be stored, dropped, or
 * copied. The transaction aborts unless the same PTB calls
 *   deepbook::pool::return_flashloan_base<BaseAsset, QuoteAsset>(pool, coin, flash_loan)
 * which consumes both the coin and the receipt.
 *
 * There is NO flashloan fee. The break-even on a DEEP-borrowed
 * cross-DEX arb is just the sum of the two DEX swap fees.
 *
 * Source: https://github.com/MystenLabs/deepbookv3/blob/main/packages/deepbook/sources/pool.move
 *   public fun borrow_flashloan_base<BaseAsset, QuoteAsset>(
 *       self: &mut Pool<BaseAsset, QuoteAsset>,
 *       base_amount: u64,
 *       ctx: &mut TxContext,
 *   ): (Coin<BaseAsset>, FlashLoan)
 *   public fun return_flashloan_base<BaseAsset, QuoteAsset>(
 *       self: &mut Pool<BaseAsset, QuoteAsset>,
 *       coin: Coin<BaseAsset>,
 *       flash_loan: FlashLoan,
 *   )
 */

import { Transaction } from '@mysten/sui/transactions';
import type { TransactionObjectArgument, TransactionResult } from '@mysten/sui/transactions';
import type { DeepbookFlashloanConfig } from '../config.js';

export interface DeepbookBorrowResult {
  /** The borrowed Coin<BaseAsset> (already a Coin — no Balance wrap needed). */
  coin: TransactionObjectArgument;
  /** The FlashLoan hot potato that must be consumed by the same PTB. */
  flashLoan: TransactionResult;
}

export function borrowFlashloan(
  tx: Transaction,
  config: DeepbookFlashloanConfig,
  sizeIn: bigint
): DeepbookBorrowResult {
  // The Move signature returns a (Coin<BaseAsset>, FlashLoan) tuple.
  // The Sui SDK's TransactionResult supports tuple-like destructuring
  // at runtime, but the static type is a single Result. Index it
  // directly the same way we do for NAVI.
  const result = tx.moveCall({
    target: `${config.packageId}::pool::borrow_flashloan_base`,
    arguments: [tx.object(config.borrowPoolId), tx.pure.u64(sizeIn)],
    typeArguments: [config.borrowBaseType, config.borrowQuoteType],
  });
  const coin = result[0] as TransactionObjectArgument;
  const flashLoan = result[1] as unknown as TransactionResult;
  return { coin, flashLoan };
}

export function repayFlashloan(
  tx: Transaction,
  config: DeepbookFlashloanConfig,
  coin: TransactionObjectArgument,
  flashLoan: TransactionResult
): void {
  // DeepBookV3's return_flashloan_base takes the Coin<BaseAsset>
  // directly — no coin::into_balance wrapper. The coin must be of
  // EXACTLY the borrowed amount; any surplus can be transferred to
  // the sender as profit.
  tx.moveCall({
    target: `${config.packageId}::pool::return_flashloan_base`,
    arguments: [tx.object(config.borrowPoolId), coin, flashLoan],
    typeArguments: [config.borrowBaseType, config.borrowQuoteType],
  });
}
