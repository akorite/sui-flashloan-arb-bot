import { describe, it, expect } from 'vitest';
import { passesThreshold } from '../../src/detector/threshold.js';
import type { Opportunity } from '../../src/detector/opportunity.js';

const PAIR = { base: 'SUI', quote: 'USDC' };

function opp(netSpreadBps: number): Opportunity {
  return {
    pair: PAIR,
    buyDex: 'cetus',
    sellDex: 'aftermath',
    sizeIn: 1_000n,
    expectedOutCheap: 1_000n,
    expectedOutExpensive: 1_050n,
    grossSpreadBps: netSpreadBps + 100,
    slippageBps: 100,
    estimatedGas: 0n,
    flashloanFee: 0n,
    netSpreadBps,
    states: {
      buy: { pair: PAIR, reserveBase: 0n, reserveQuote: 0n, price: 0n, readAt: 0 },
      sell: { pair: PAIR, reserveBase: 0n, reserveQuote: 0n, price: 0n, readAt: 0 },
    },
  };
}

describe('passesThreshold', () => {
  it('passes when net spread equals threshold', () => {
    expect(passesThreshold(opp(50), 50)).toBe(true);
  });

  it('passes when net spread exceeds threshold', () => {
    expect(passesThreshold(opp(100), 50)).toBe(true);
  });

  it('rejects when net spread is below threshold', () => {
    expect(passesThreshold(opp(10), 50)).toBe(false);
  });

  it('rejects negative net spread', () => {
    expect(passesThreshold(opp(-5), 0)).toBe(false);
  });

  it('treats threshold of 0 as "any non-negative edge"', () => {
    expect(passesThreshold(opp(0), 0)).toBe(true);
  });

  it('rejects negative threshold', () => {
    expect(() => passesThreshold(opp(0), -1)).toThrow();
  });
});
