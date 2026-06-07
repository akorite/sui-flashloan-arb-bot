/**
 * Aftermath CLMM adapter. Same shape as Cetus/Turbos. Aftermath's router
 * signature is the documented difference; everything else mirrors the
 * other adapters.
 */

import type { Transaction, TransactionResult } from '@mysten/sui/transactions';
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

export class AftermathClient implements DexClient {
  readonly name: DexName = 'aftermath';

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

function poolObjectIdFor(dex: DexName, pair: Pair): string {
  return `pool-${dex}-${pair.base}-${pair.quote}`;
}

function coinTypeFor(symbol: string): string {
  return `0x${symbol.toLowerCase()}::coin::COIN`;
}
