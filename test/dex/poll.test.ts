import { describe, it, expect } from 'vitest';
import { CetusClient, quoteConstantProduct } from '../../src/dex/cetus.js';
import { TurbosClient } from '../../src/dex/turbos.js';
import { AftermathClient } from '../../src/dex/aftermath.js';
import { PairNotFoundError, DexRpcError } from '../../src/dex/types.js';
import type { PoolState } from '../../src/dex/types.js';

const PAIR = { base: 'SUI', quote: 'USDC' };

const STATE_A: PoolState = {
  pair: PAIR,
  reserveBase: 1_000_000n,
  reserveQuote: 2_000_000n,
  price: 2n,
  readAt: 0,
};

const STATE_B: PoolState = {
  ...STATE_A,
  reserveQuote: 2_100_000n,
};

describe('DexClient adapters', () => {
  describe('CetusClient', () => {
    it('returns the pool state from the fetcher', async () => {
      const client = new CetusClient(
        { packageId: '0xcetus', swapModule: 'router', swapFn: 'swap' },
        async () => STATE_A
      );
      const state = await client.getPoolState(PAIR);
      expect(state).toEqual(STATE_A);
    });

    it('throws PairNotFoundError when fetcher returns null', async () => {
      const client = new CetusClient(
        { packageId: '0xcetus', swapModule: 'router', swapFn: 'swap' },
        async () => null
      );
      await expect(client.getPoolState(PAIR)).rejects.toBeInstanceOf(PairNotFoundError);
    });

    it('wraps RPC errors as DexRpcError', async () => {
      const client = new CetusClient(
        { packageId: '0xcetus', swapModule: 'router', swapFn: 'swap' },
        async () => {
          throw new Error('boom');
        }
      );
      await expect(client.getPoolState(PAIR)).rejects.toBeInstanceOf(DexRpcError);
    });
  });

  describe('TurbosClient', () => {
    it('returns the pool state from the fetcher', async () => {
      const client = new TurbosClient(
        { packageId: '0xturbos', swapModule: 'router', swapFn: 'swap' },
        async () => STATE_B
      );
      const state = await client.getPoolState(PAIR);
      expect(state.reserveQuote).toBe(2_100_000n);
    });

    it('throws PairNotFoundError when fetcher returns null', async () => {
      const client = new TurbosClient(
        { packageId: '0xturbos', swapModule: 'router', swapFn: 'swap' },
        async () => null
      );
      await expect(client.getPoolState(PAIR)).rejects.toBeInstanceOf(PairNotFoundError);
    });
  });

  describe('AftermathClient', () => {
    it('returns the pool state from the fetcher', async () => {
      const client = new AftermathClient(
        { packageId: '0xaftermath', swapModule: 'router', swapFn: 'swap' },
        async () => STATE_A
      );
      const state = await client.getPoolState(PAIR);
      expect(state.reserveBase).toBe(1_000_000n);
    });
  });

  describe('quoteConstantProduct', () => {
    it('returns zero for zero input', () => {
      const q = quoteConstantProduct(1_000n, 1_000n, 0n);
      expect(q.expectedOut).toBe(0n);
      expect(q.priceImpactBps).toBe(0);
    });

    it('returns zero output and 100% impact for empty pool', () => {
      const q = quoteConstantProduct(0n, 0n, 100n);
      expect(q.expectedOut).toBe(0n);
      expect(q.priceImpactBps).toBe(10000);
    });

    it('matches constant-product math', () => {
      const sizeIn = 100_000n;
      const q = quoteConstantProduct(2_000_000n, 1_000_000n, sizeIn);
      // out = reserveOut * sizeIn / (reserveIn + sizeIn) = 1e6 * 1e5 / (2e6 + 1e5) = 47619
      expect(q.expectedOut).toBe(47619n);
      // impact ≈ sizeIn / (reserveIn + sizeIn) ≈ 100000 / 2100000 = 4.76% = 476 bps
      expect(q.priceImpactBps).toBe(476);
    });
  });
});
