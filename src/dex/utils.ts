/**
 * Shared helpers for DEX adapters.
 *
 * The coin-type and pool-id helpers here are placeholders — the real
 * production code resolves them from a registry keyed by (dex, pair)
 * and the canonical Sui coin metadata. The placeholders are good
 * enough to build a PTB; the testnet run discovers the real values and
 * the operator wires them into config.dexContracts.
 */

import type { DexName, Pair } from './types.js';

export function poolObjectIdFor(dex: DexName, pair: Pair): string {
  return `pool-${dex}-${pair.base}-${pair.quote}`;
}

export function coinTypeFor(symbol: string): string {
  return `0x${symbol.toLowerCase()}::coin::COIN`;
}
