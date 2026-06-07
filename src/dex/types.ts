/**
 * DEX client interface and shared types.
 *
 * The bot treats all three supported CLMM DEXes through a uniform
 * `DexClient` interface so the detector and PTB builder can be
 * DEX-agnostic. Each DEX adapter implements the same three operations:
 *
 *   1. `getPoolState(pair)` — read reserves and the current price tick.
 *   2. `quoteSwap(pair, sizeIn)` — return the expected output and the
 *      price impact for a given input size.
 *   3. `buildSwapCall(tx, pair, coinIn, minOut)` — emit a `moveCall` for
 *      the DEX's swap function into an in-progress `Transaction`.
 *
 * Implementations live in cetus.ts, turbos.ts, aftermath.ts. The
 * concrete Sui object IDs and module names are taken from config so the
 * adapters are testable offline.
 */

import type { Transaction, TransactionObjectArgument, TransactionResult } from '@mysten/sui/transactions';

export type DexName = 'cetus' | 'turbos' | 'aftermath';

export interface Pair {
  base: string;
  quote: string;
}

export interface PoolState {
  /** Pair identifier — kept on the state to make log lines self-describing. */
  pair: Pair;
  /** Reserves in base units (u64). */
  reserveBase: bigint;
  /** Reserves in quote units (u64). */
  reserveQuote: bigint;
  /** Current sqrt-price or tick (interpreted by the DEX; opaque to the bot). */
  price: bigint;
  /** When the state was read. */
  readAt: number;
}

export interface Quote {
  /** Expected output amount (u64). */
  expectedOut: bigint;
  /** Estimated price impact in basis points (0-10000). */
  priceImpactBps: number;
}

export interface SwapCallArgs {
  tx: Transaction;
  pair: Pair;
  /** Object ID of the input coin to swap. The TX builder wires this. */
  coinIn: TransactionObjectArgument;
  /** Minimum acceptable output — slippage protection at execution time. */
  minOut: bigint;
}

export interface DexClient {
  readonly name: DexName;
  getPoolState(pair: Pair): Promise<PoolState>;
  quoteSwap(pair: Pair, sizeIn: bigint): Promise<Quote>;
  buildSwapCall(args: SwapCallArgs): TransactionResult;
}

/** Errors surfaced by DexClient implementations. Typed for loop-level handling. */
export class PairNotFoundError extends Error {
  readonly dex: DexName;
  readonly pair: Pair;
  constructor(dex: DexName, pair: Pair) {
    super(`Pair ${pair.base}/${pair.quote} not found on ${dex}`);
    this.name = 'PairNotFoundError';
    this.dex = dex;
    this.pair = pair;
  }
}

export class DexRpcError extends Error {
  readonly dex: DexName;
  constructor(dex: DexName, cause: unknown) {
    super(`RPC error from ${dex}: ${(cause as Error)?.message ?? String(cause)}`, {
      cause,
    });
    this.name = 'DexRpcError';
    this.dex = dex;
  }
}
