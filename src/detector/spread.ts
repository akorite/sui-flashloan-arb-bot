/**
 * Spread detection.
 *
 * For a single pair across N DEXes, finds the best cross-DEX arb
 * opportunity. The function is pure over its inputs — it takes a
 * snapshot of pool states and returns zero or one Opportunity. No
 * network calls; no logging.
 *
 * Algorithm:
 *   1. Sort DEXes by mid-price ascending.
 *   2. For each (cheap, expensive) pair, find the trade size that
 *      maximizes the net spread via a coarse search over sizes
 *      (10 logarithmically-spaced samples between minSize and the
 *      effective liquidity cap).
 *   3. Pick the (cheap, expensive) pair with the highest net spread.
 *   4. Return null if no pair produces a positive net.
 *
 * The search is deliberately coarse — the goal is a deterministic
 * detector that's easy to test, not a high-fidelity optimizer. Real
 * execution gets the exact price from the on-chain swap.
 */

import type { DexName, Pair, PoolState } from '../dex/types.js';
import { quoteConstantProduct } from '../dex/cetus.js';
import type { Opportunity } from './opportunity.js';

export interface DetectorInputs {
  pair: Pair;
  states: Map<DexName, PoolState>;
  /** Number of size samples to evaluate during the search. */
  sizeSamples?: number;
  /** Minimum trade size in quote units. Defaults to 1_000n. */
  minSizeIn?: bigint;
  /** Estimated gas in quote units. */
  estimatedGas?: bigint;
  /** Flashloan fee in quote units. */
  flashloanFee?: bigint;
  /** Liquidity cap fraction — same as config.liquidityCapFraction. */
  liquidityCapFraction: number;
}

const DEFAULT_SIZE_SAMPLES = 10;
const DEFAULT_MIN_SIZE_IN = 1_000n;

export function findOpportunity(inputs: DetectorInputs): Opportunity | null {
  const {
    pair,
    states,
    sizeSamples = DEFAULT_SIZE_SAMPLES,
    minSizeIn = DEFAULT_MIN_SIZE_IN,
    estimatedGas = 0n,
    flashloanFee = 0n,
    liquidityCapFraction,
  } = inputs;

  if (states.size < 2) return null;

  const sorted = [...states.entries()].sort((a, b) =>
    a[1].reserveQuote * b[1].reserveBase < b[1].reserveQuote * a[1].reserveBase ? -1 : 1
  );

  let best: Opportunity | null = null;

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const [cheapDex, cheapState] = sorted[i]!;
      const [expensiveDex, expensiveState] = sorted[j]!;

      const capBase = min(cheapState.reserveQuote, expensiveState.reserveBase);
      const cap = (capBase * BigInt(Math.floor(liquidityCapFraction * 1_000_000))) / 1_000_000n;
      if (cap <= minSizeIn) continue;

      const candidate = searchBestSize({
        pair,
        cheapDex,
        expensiveDex,
        cheapState,
        expensiveState,
        minSizeIn,
        maxSizeIn: cap,
        samples: sizeSamples,
        estimatedGas,
        flashloanFee,
      });
      if (candidate && (best === null || candidate.netSpreadBps > best.netSpreadBps)) {
        best = candidate;
      }
    }
  }

  return best;
}

interface SearchArgs {
  pair: Pair;
  cheapDex: DexName;
  expensiveDex: DexName;
  cheapState: PoolState;
  expensiveState: PoolState;
  minSizeIn: bigint;
  maxSizeIn: bigint;
  samples: number;
  estimatedGas: bigint;
  flashloanFee: bigint;
}

function searchBestSize(args: SearchArgs): Opportunity | null {
  const { minSizeIn, maxSizeIn, samples } = args;
  if (maxSizeIn <= minSizeIn) return null;

  let best: Opportunity | null = null;
  for (let s = 0; s < samples; s++) {
    const sizeIn = geometricSample(minSizeIn, maxSizeIn, s, samples);
    const candidate = evaluateSize({ ...args, sizeIn });
    if (candidate && (best === null || candidate.netSpreadBps > best.netSpreadBps)) {
      best = candidate;
    }
  }
  return best;
}

interface EvaluateArgs extends SearchArgs {
  sizeIn: bigint;
}

function evaluateSize(args: EvaluateArgs): Opportunity | null {
  const {
    pair,
    cheapDex,
    expensiveDex,
    cheapState,
    expensiveState,
    sizeIn,
    estimatedGas,
    flashloanFee,
  } = args;

  // Leg 1: put `sizeIn` quote into the cheap DEX, get base out.
  const cheapQuote = quoteConstantProduct(
    cheapState.reserveQuote,
    cheapState.reserveBase,
    sizeIn
  );
  if (cheapQuote.expectedOut === 0n) return null;

  // Leg 2: put the base we got into the expensive DEX, get quote out.
  // For this leg, the "input reserve" is the base reserve and the
  // "output reserve" is the quote reserve.
  const expensiveQuote = quoteConstantProduct(
    expensiveState.reserveBase,
    expensiveState.reserveQuote,
    cheapQuote.expectedOut
  );
  if (expensiveQuote.expectedOut === 0n) return null;

  const grossOut = expensiveQuote.expectedOut - sizeIn;
  if (grossOut <= 0n) return null;

  const grossSpreadBps = Number((grossOut * 10_000n) / sizeIn);

  const slippageBps = cheapQuote.priceImpactBps + expensiveQuote.priceImpactBps;
  const estimatedGasBps = sizeIn === 0n ? 0 : Number((estimatedGas * 10_000n) / sizeIn);
  const flashloanFeeBps = sizeIn === 0n ? 0 : Number((flashloanFee * 10_000n) / sizeIn);
  const netSpreadBps = grossSpreadBps - slippageBps - estimatedGasBps - flashloanFeeBps;

  if (netSpreadBps <= 0) return null;

  return {
    pair,
    buyDex: cheapDex,
    sellDex: expensiveDex,
    sizeIn,
    expectedOutCheap: cheapQuote.expectedOut,
    expectedOutExpensive: expensiveQuote.expectedOut,
    grossSpreadBps,
    slippageBps,
    estimatedGas,
    flashloanFee,
    netSpreadBps,
    states: { buy: cheapState, sell: expensiveState },
    computedAt: Date.now(),
  };
}

function geometricSample(min: bigint, max: bigint, idx: number, total: number): bigint {
  if (total <= 1) return max;
  // log-spaced between min and max
  const t = idx / (total - 1);
  // min * (max/min)^t — done in floating point then converted back.
  const minF = Number(min);
  const maxF = Number(max);
  if (!Number.isFinite(minF) || !Number.isFinite(maxF) || minF <= 0 || maxF <= 0) {
    return max;
  }
  const sample = minF * Math.pow(maxF / minF, t);
  return BigInt(Math.max(1, Math.floor(sample)));
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
