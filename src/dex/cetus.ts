/**
 * Cetus CLMM adapter.
 *
 * Implementation contract:
 *   - `getPoolState` reads the pool object from RPC and parses reserves
 *     and the current sqrt-price.
 *   - `quoteSwap` runs a CLMM quote computation locally against the
 *     pool's reserves; exact formula depends on Cetus's tick math.
 *   - `buildSwapCall` emits the configured `swap` moveCall into the TX.
 *
 * The `packageId` / `swapModule` / `swapFn` come from config so the
 * adapter does not hardcode testnet addresses.
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

export class CetusClient implements DexClient {
  readonly name: DexName = 'cetus';

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
    // Default DexClient.quoteSwap is "buy base with quote" — the input
    // is quote-side and the output is base-side.
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

/**
 * Direction-agnostic constant-product quote. Given a pool's reserves
 * for the two sides and the size being put in, returns the expected
 * output and the price impact in basis points.
 *
 * Used as the building block for both "buy base with quote" and
 * "sell base for quote" — the caller picks which reserve is the
 * input side and which is the output side. The function does not know
 * about base/quote; that knowledge lives in the caller.
 */
export function quoteConstantProduct(
  reserveIn: bigint,
  reserveOut: bigint,
  sizeIn: bigint
): Quote {
  if (sizeIn <= 0n) {
    return { expectedOut: 0n, priceImpactBps: 0 };
  }
  if (reserveIn === 0n || reserveOut === 0n) {
    return { expectedOut: 0n, priceImpactBps: 10000 };
  }
  // out = reserveOut * sizeIn / (reserveIn + sizeIn)
  const numerator = reserveOut * sizeIn;
  const denominator = reserveIn + sizeIn;
  const expectedOut = numerator / denominator;
  // price impact ≈ sizeIn / (reserveIn + sizeIn) (fraction of pool consumed)
  const impactBps = Number((sizeIn * 10000n) / (reserveIn + sizeIn));
  return { expectedOut, priceImpactBps: impactBps };
}

function poolObjectIdFor(dex: DexName, pair: Pair): string {
  // Operator fills these in config.dexContracts[dex] and the caller
  // passes the package ID; this stub is a placeholder kept for callers
  // that want a hard reference. Real implementations look up the pool
  // object ID from a registry indexed by (dex, pair).
  return `pool-${dex}-${pair.base}-${pair.quote}`;
}

function coinTypeFor(symbol: string): string {
  return `0x${symbol.toLowerCase()}::coin::COIN`;
}
