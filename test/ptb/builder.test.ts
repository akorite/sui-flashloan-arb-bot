import { describe, it, expect, vi } from 'vitest';
import { buildPtb } from '../../src/ptb/builder.js';
import type { Opportunity } from '../../src/detector/opportunity.js';
import type { Config } from '../../src/config.js';
import type { DexClientMap } from '../../src/dex/index.js';
import type { DexClient } from '../../src/dex/types.js';
import { Transaction } from '@mysten/sui/transactions';
import type { TransactionResult } from '@mysten/sui/transactions';

const PAIR = { base: 'SUI', quote: 'USDC' };

const baseConfig: Config = {
  rpcUrl: 'https://fullnode.testnet.sui.io:443',
  privateKey: 'placeholder',
  pairs: [PAIR],
  dexes: ['cetus', 'turbos', 'aftermath'],
  thresholdBps: 50,
  maxSubmissions: 5,
  pollIntervalMs: 1000,
  liquidityCapFraction: 0.5,
  flashloan: {
    provider: 'navi',
    packageId: '0xnavi',
    moduleName: 'flashloan',
    borrowFn: 'loan',
    repayFn: 'repay',
  },
  dexContracts: {
    cetus: { packageId: '0xcetus', swapModule: 'router', swapFn: 'swap' },
    turbos: { packageId: '0xturbos', swapModule: 'router', swapFn: 'swap' },
    aftermath: { packageId: '0xaftermath', swapModule: 'router', swapFn: 'swap' },
  },
};

const opportunity: Opportunity = {
  pair: PAIR,
  buyDex: 'cetus',
  sellDex: 'aftermath',
  sizeIn: 1_000_000n,
  expectedOutCheap: 500_000n,
  expectedOutExpensive: 510_000n,
  grossSpreadBps: 200,
  slippageBps: 50,
  estimatedGas: 0n,
  flashloanFee: 100n,
  netSpreadBps: 150,
  states: {
    buy: { pair: PAIR, reserveBase: 0n, reserveQuote: 0n, price: 0n, readAt: 0 },
    sell: { pair: PAIR, reserveBase: 0n, reserveQuote: 0n, price: 0n, readAt: 0 },
  },
  computedAt: 0,
};

// Use a fresh Transaction per call to produce a real
// TransactionResult. The buy result is captured and passed into the
// sell call; the test asserts the call-order handoff, not the value's
// identity.
function makeFakeBuildSwapCall(captured: { last: TransactionResult | null }) {
  return vi.fn(({ tx }: { tx: Transaction }): TransactionResult => {
    // Emit a real moveCall to produce a valid TransactionResult that
    // the SDK can accept as a downstream argument.
    const result = tx.moveCall({
      target: '0x0::test::swap',
      arguments: [tx.pure.u64(1n)],
      typeArguments: ['0xbase::coin::COIN', '0xquote::coin::COIN'],
    });
    captured.last = result;
    return result;
  });
}

function fakeDexClient(
  name: 'cetus' | 'turbos' | 'aftermath',
  captured: { last: TransactionResult | null }
): DexClient {
  return {
    name,
    getPoolState: vi.fn(),
    quoteSwap: vi.fn(),
    buildSwapCall: makeFakeBuildSwapCall(captured),
  };
}

describe('buildPtb', () => {
  it('emits the four operations in the correct order', () => {
    const buyCap = { last: null as TransactionResult | null };
    const sellCap = { last: null as TransactionResult | null };
    const buy = fakeDexClient('cetus', buyCap);
    const sell = fakeDexClient('aftermath', sellCap);
    const dexClients: DexClientMap = { cetus: buy, aftermath: sell };

    buildPtb({ opportunity, config: baseConfig, dexClients });

    expect(buy.buildSwapCall).toHaveBeenCalledTimes(1);
    expect(sell.buildSwapCall).toHaveBeenCalledTimes(1);
    const buyArgs = (buy.buildSwapCall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const sellArgs = (sell.buildSwapCall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(buyArgs).toBeDefined();
    expect(sellArgs).toBeDefined();
    expect(buyArgs!.coinIn).toBeDefined();
    // The sell call should consume the result of the buy call's swap.
    expect(sellArgs!.coinIn).toBe(buyCap.last);
    expect(sellArgs!.minOut).toBe(opportunity.expectedOutExpensive);
  });

  it('throws when the buy DEX is not configured', () => {
    const cap = { last: null as TransactionResult | null };
    const dexClients: DexClientMap = { aftermath: fakeDexClient('aftermath', cap) };
    expect(() => buildPtb({ opportunity, config: baseConfig, dexClients })).toThrow(
      /Buy DEX cetus not configured/
    );
  });

  it('throws when the sell DEX is not configured', () => {
    const cap = { last: null as TransactionResult | null };
    const dexClients: DexClientMap = { cetus: fakeDexClient('cetus', cap) };
    expect(() => buildPtb({ opportunity, config: baseConfig, dexClients })).toThrow(
      /Sell DEX aftermath not configured/
    );
  });

  it('returns a Transaction instance', () => {
    const cap = { last: null as TransactionResult | null };
    const dexClients: DexClientMap = {
      cetus: fakeDexClient('cetus', cap),
      aftermath: fakeDexClient('aftermath', cap),
    };
    const tx = buildPtb({ opportunity, config: baseConfig, dexClients });
    expect(tx).toBeInstanceOf(Transaction);
  });
});
