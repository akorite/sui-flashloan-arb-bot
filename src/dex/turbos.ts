/**
 * Turbos CLMM adapter. Mirrors the Cetus contract — same interface,
 * same deterministic quote function. Implementation differences (module
 * names, function signatures) are confined to `buildSwapCall` and the
 * package IDs in config.
 */

import type { TransactionResult } from '@mysten/sui/transactions';
import type {
  DexClient,
  DexName,
  Pair,
  PoolState,
  Quote,
  SwapCallArgs,
} from './types.js';
import { PairNotFoundError, DexRpcError } from './types.js';
import type { DexContractConfig } from '../config.js';
import { quoteConstantProduct } from './cetus.js';
import { coinTypeFor, poolObjectIdFor } from './utils.js';

export class TurbosClient implements DexClient {
  readonly name: DexName = 'turbos';

  constructor(
    private readonly contract: DexContractConfig,
    private readonly fetchStateImpl: (pair: Pair) => Promise<PoolState | null>
  ) {}

  async getPoolState(pair: Pair): Promise<PoolState> {
    try {
      const state = await this.fetchStateImpl(pair);
      if (!state) throw new PairNotFoundError(this.name, pair);
      return state;
    } catch (err) {
      if (err instanceof PairNotFoundError) throw err;
      throw new DexRpcError(this.name, err);
    }
  }

  async quoteSwap(pair: Pair, sizeIn: bigint): Promise<Quote> {
    const state = await this.getPoolState(pair);
    return quoteConstantProduct(state.reserveQuote, state.reserveBase, sizeIn);
  }

  buildSwapCall({ tx, pair, coinIn, minOut }: SwapCallArgs): TransactionResult {
    return tx.moveCall({
      target: `${this.contract.packageId}::${this.contract.swapModule}::${this.contract.swapFn}`,
      arguments: [
        tx.object(poolObjectIdFor(this.name, pair)),
        coinIn,
        tx.pure.u64(minOut),
      ],
      typeArguments: [coinTypeFor(pair.base), coinTypeFor(pair.quote)],
    });
  }
}
