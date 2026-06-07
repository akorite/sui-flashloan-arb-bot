/**
 * Opportunity type — a single detected cross-DEX arb candidate.
 *
 * The detector produces zero or more of these per poll cycle. The
 * threshold gate and PTB builder consume them downstream. Fields are
 * deliberately self-describing: every log line and every PTB carries
 * the same shape so the operator can audit decisions after the fact.
 */

import type { DexName, Pair, PoolState } from '../dex/types.js';

export interface Opportunity {
  pair: Pair;
  buyDex: DexName;
  sellDex: DexName;
  /** Trade size in quote-side units (u64). The amount to flashloan and route through the cheap DEX. */
  sizeIn: bigint;
  /** Expected output from the cheap DEX (u64). */
  expectedOutCheap: bigint;
  /** Expected output from the expensive DEX (u64) when selling the cheap DEX's output. */
  expectedOutExpensive: bigint;
  /** Gross spread = (expectedOutExpensive - expectedOutCheap) / expectedOutCheap, in bps. */
  grossSpreadBps: number;
  /** Estimated slippage at the chosen size, in bps (sum of both sides). */
  slippageBps: number;
  /** Estimated gas cost in quote units (u64). Conservative default: 0 (testnet gas is effectively free). */
  estimatedGas: bigint;
  /** Flashloan fee in quote units (u64). Operator-supplied via config or computed from provider rate. */
  flashloanFee: bigint;
  /** Net spread = grossSpreadBps - (slippageBps + estimatedGasBps + flashloanFeeBps), in bps. */
  netSpreadBps: number;
  /** Pool state snapshots used to compute the opportunity — carried for the liquidity cap check. */
  states: { buy: PoolState; sell: PoolState };
}
