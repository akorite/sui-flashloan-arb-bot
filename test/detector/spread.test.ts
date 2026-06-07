import { describe, it, expect } from 'vitest';
import { findOpportunity } from '../../src/detector/spread.js';
import type { DexName, PoolState } from '../../src/dex/types.js';

const PAIR = { base: 'SUI', quote: 'USDC' };

function state(dex: DexName, priceNum: number, depth = 1_000_000n): PoolState {
  // Mid-price = reserveQuote / reserveBase. We control price by setting reserves.
  // Use reserveBase = depth, reserveQuote = depth * price.
  return {
    pair: PAIR,
    reserveBase: depth,
    reserveQuote: depth * BigInt(priceNum),
    price: BigInt(priceNum),
    readAt: 0,
  };
}

describe('findOpportunity', () => {
  it('returns null with fewer than 2 states', () => {
    const result = findOpportunity({
      pair: PAIR,
      states: new Map<DexName, PoolState>([['cetus', state('cetus', 2)]]),
      liquidityCapFraction: 0.5,
    });
    expect(result).toBeNull();
  });

  it('returns null when all DEXes are at the same price', () => {
    const states = new Map<DexName, PoolState>([
      ['cetus', state('cetus', 2)],
      ['turbos', state('turbos', 2)],
      ['aftermath', state('aftermath', 2)],
    ]);
    const result = findOpportunity({ pair: PAIR, states, liquidityCapFraction: 0.5 });
    expect(result).toBeNull();
  });

  it('finds the best cross-DEX opportunity when prices differ', () => {
    // Cetus: 2.0, Turbos: 2.1, Aftermath: 2.2. Best: buy on Cetus, sell on Aftermath.
    const states = new Map<DexName, PoolState>([
      ['cetus', state('cetus', 2)],
      ['turbos', state('turbos', 21, 500_000n)], // smaller depth to keep math tractable
      ['aftermath', state('aftermath', 22)],
    ]);
    const result = findOpportunity({
      pair: PAIR,
      states,
      liquidityCapFraction: 0.1,
      flashloanFeeBps: 0,
      estimatedGas: 0n,
    });
    expect(result).not.toBeNull();
    expect(result!.buyDex).toBe('cetus');
    expect(result!.sellDex).toBe('aftermath');
    expect(result!.netSpreadBps).toBeGreaterThan(0);
  });

  it('reports positive gross spread for an obvious arb', () => {
    const states = new Map<DexName, PoolState>([
      ['cetus', state('cetus', 2, 1_000_000n)],
      ['turbos', state('turbos', 3, 1_000_000n)],
    ]);
    const result = findOpportunity({
      pair: PAIR,
      states,
      liquidityCapFraction: 0.1,
      flashloanFeeBps: 0,
      estimatedGas: 0n,
    });
    expect(result).not.toBeNull();
    expect(result!.grossSpreadBps).toBeGreaterThan(0);
  });

  it('skips opportunities whose max size is below minSizeIn', () => {
    // Tiny pools: cap is below minSizeIn
    const states = new Map<DexName, PoolState>([
      ['cetus', state('cetus', 2, 100n)],
      ['turbos', state('turbos', 3, 100n)],
    ]);
    const result = findOpportunity({
      pair: PAIR,
      states,
      liquidityCapFraction: 0.5,
      minSizeIn: 100_000n,
    });
    expect(result).toBeNull();
  });

  it('subtracts flashloan fee and gas from net spread', () => {
    // Cetus 2.0 vs Turbos 3.0, 1M depth each, cap 0.1
    const states = new Map<DexName, PoolState>([
      ['cetus', state('cetus', 2, 1_000_000n)],
      ['turbos', state('turbos', 3, 1_000_000n)],
    ]);
    // 50 bps flashloan fee + 10 quote gas (~1 bps at this depth) -> net
    // should be positive but visibly less than gross
    const result = findOpportunity({
      pair: PAIR,
      states,
      liquidityCapFraction: 0.1,
      flashloanFeeBps: 50,
      estimatedGas: 10n,
    });
    expect(result).not.toBeNull();
    expect(result!.netSpreadBps).toBeLessThan(result!.grossSpreadBps);
    expect(result!.netSpreadBps).toBeGreaterThan(0);
  });
});
