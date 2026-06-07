import { describe, it, expect } from 'vitest';
import { liquidityOk } from '../../src/bot/liquidity.js';
import type { Opportunity } from '../../src/detector/opportunity.js';
import type { PoolState } from '../../src/dex/types.js';

const PAIR = { base: 'SUI', quote: 'USDC' };

function opp(sizeIn: bigint, buyReserves: bigint, sellReserves: bigint): Opportunity {
  const buy: PoolState = { pair: PAIR, reserveBase: 0n, reserveQuote: buyReserves, price: 0n, readAt: 0 };
  const sell: PoolState = { pair: PAIR, reserveBase: sellReserves, reserveQuote: 0n, price: 0n, readAt: 0 };
  return {
    pair: PAIR,
    buyDex: 'cetus',
    sellDex: 'aftermath',
    sizeIn,
    expectedOutCheap: 0n,
    expectedOutExpensive: 0n,
    grossSpreadBps: 100,
    slippageBps: 0,
    estimatedGas: 0n,
    flashloanFee: 0n,
    netSpreadBps: 100,
    states: { buy, sell },
    computedAt: 0,
  };
}

describe('liquidityOk', () => {
  it('passes when size is below the cap', () => {
    expect(liquidityOk(opp(100n, 10_000n, 10_000n), 0.5)).toBe(true);
  });

  it('rejects when size exceeds the cap', () => {
    // cap = min(10_000, 10_000) * 0.5 = 5000
    expect(liquidityOk(opp(6_000n, 10_000n, 10_000n), 0.5)).toBe(false);
  });

  it('uses the shallower pool for the cap', () => {
    // cap = min(100_000, 5_000) * 0.5 = 2_500
    expect(liquidityOk(opp(2_000n, 100_000n, 5_000n), 0.5)).toBe(true);
    expect(liquidityOk(opp(3_000n, 100_000n, 5_000n), 0.5)).toBe(false);
  });

  it('rejects invalid cap fraction', () => {
    expect(() => liquidityOk(opp(1n, 10_000n, 10_000n), 0)).toThrow();
    expect(() => liquidityOk(opp(1n, 10_000n, 10_000n), 1.5)).toThrow();
  });
});
