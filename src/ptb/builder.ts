/**
 * PTB builder.
 *
 * Composes the four operations required for a cross-DEX flashloan
 * arbitrage in a single Sui Programmable Transaction Block:
 *
 *   1. borrow from the flashloan provider
 *   2. swap on the cheap DEX (using the borrowed coin)
 *   3. swap on the expensive DEX (using the output of step 2)
 *   4. repay the flashloan
 *
 * The order is critical: the receipt from step 1 must be consumed by
 * step 4, and the coin flowing into step 4 must be the result of step
 * 3. Sui's PTB type system enforces this at sign time.
 */

import { Transaction } from '@mysten/sui/transactions';
import type { TransactionObjectArgument, TransactionResult } from '@mysten/sui/transactions';
import type { Opportunity } from '../detector/opportunity.js';
import type { DexClientMap } from '../dex/index.js';
import type { Config, FlashloanConfig } from '../config.js';
import { isDeepbookFlashloan, isNaviFlashloan } from '../config.js';
import { borrowFlashloan as naviBorrow, repayFlashloan as naviRepay } from './navi.js';
import { borrowFlashloan as deepbookBorrow, repayFlashloan as deepbookRepay } from './deepbook.js';
import type { SwapCallArgs } from '../dex/types.js';

export interface BuildArgs {
  opportunity: Opportunity;
  config: Config;
  dexClients: DexClientMap;
}

/**
 * Build a PTB for the given opportunity. Returns the constructed
 * `Transaction`; the caller is responsible for signing and submitting.
 *
 * Throws if the buy or sell DEX is not present in the dexClients map
 * (which would mean config and reality disagree about which DEXes are
 * available).
 */
export function buildPtb({ opportunity, config, dexClients }: BuildArgs): Transaction {
  const buyClient = dexClients[opportunity.buyDex];
  const sellClient = dexClients[opportunity.sellDex];
  if (!buyClient) {
    throw new Error(`Buy DEX ${opportunity.buyDex} not configured in dexClients`);
  }
  if (!sellClient) {
    throw new Error(`Sell DEX ${opportunity.sellDex} not configured in dexClients`);
  }

  const tx = new Transaction();

  // Step 1: borrow. The flashloan handle type differs by provider.
  //   - NAVI returns (Balance<T>, Receipt)  -> we wrap to Coin<T>
  //   - DeepBookV3 returns (Coin<T>, FlashLoan) -> ready as Coin<T>
  const handle = borrowForProvider(tx, config.flashloan, opportunity.sizeIn);

  // Step 2: swap on the cheap DEX (buy side)
  const buyArgs: SwapCallArgs = {
    tx,
    pair: opportunity.pair,
    coinIn: handle.borrowedCoin,
    minOut: opportunity.expectedOutCheap,
  };
  const intermediateCoin = buyClient.buildSwapCall(buyArgs);

  // Step 3: swap on the expensive DEX (sell side)
  const sellArgs: SwapCallArgs = {
    tx,
    pair: opportunity.pair,
    coinIn: intermediateCoin,
    minOut: opportunity.expectedOutExpensive,
  };
  const repayCoin = sellClient.buildSwapCall(sellArgs);

  // Step 4: repay the flashloan. The exact argument shape depends on
  // the provider — NAVI takes the receipt + balance, DeepBookV3 takes
  // the coin + FlashLoan.
  repayForProvider(tx, config.flashloan, handle, repayCoin);

  return tx;
}

interface BorrowHandle {
  borrowedCoin: TransactionObjectArgument;
  receipt: TransactionResult;
}

function borrowForProvider(
  tx: Transaction,
  config: FlashloanConfig,
  sizeIn: bigint
): BorrowHandle {
  if (isNaviFlashloan(config)) {
    const { coin, receipt } = naviBorrow(tx, config, sizeIn);
    return { borrowedCoin: coin, receipt };
  }
  if (isDeepbookFlashloan(config)) {
    const { coin, flashLoan } = deepbookBorrow(tx, config, sizeIn);
    return { borrowedCoin: coin, receipt: flashLoan };
  }
  throw new Error(`Unsupported flashloan provider: ${(config as { provider: string }).provider}`);
}

function repayForProvider(
  tx: Transaction,
  config: FlashloanConfig,
  handle: BorrowHandle,
  repayCoin: TransactionObjectArgument
): void {
  if (isNaviFlashloan(config)) {
    naviRepay(tx, config, handle.receipt, repayCoin);
    return;
  }
  if (isDeepbookFlashloan(config)) {
    deepbookRepay(tx, config, repayCoin, handle.receipt);
    return;
  }
  throw new Error(`Unsupported flashloan provider: ${(config as { provider: string }).provider}`);
}
