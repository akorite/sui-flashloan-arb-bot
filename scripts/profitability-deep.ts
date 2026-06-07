/**
 * Profitability check for DEEP-paired cross-DEX arbs (DeepBookV3 flashloan).
 *
 * Pools tested:
 *   DEEP/SUI:
 *     - Cetus 0.25%   0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2
 *     - Cetus 0.05%   0xd978d331772a5b90d5a4781e1232d18afd12019d0c35db79e3674beeda8f9126
 *     - Bluefin 0.175% (0x7242459a663c4e59434252ceb27c228f6b1f21f2ba506f3b62d71b19a7421cc1) — older fmt
 *   DEEP/USDC:
 *     - Cetus 0.05%   (lookup)
 *     - Turbos        (lookup)
 *     - Bluefin 0.2%  (lookup)
 *
 * The break-even for a DEEP-borrowed 2-leg cross-DEX arb is just the
 * SUM of the two DEX swap fees (DeepBookV3 charges 0 bps on the
 * flashloan). Compare:
 *   SUI/USDC NAVI:  5 (NAVI) + dex_a + dex_b  =  15-35 bps to break even
 *   DEEP-pairs:                  dex_a + dex_b  =  10-50 bps to break even
 *
 * Lower break-even + long-tail tokens = wider, more frequent opportunities.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

const Q64 = 1n << 64n;

const DECIMALS: Record<string, number> = {
  sui: 9,
  usdc: 6,
  deep: 6,
};

interface PoolDef {
  id: string;
  name: string;
  typeBase: 'deep' | 'sui' | 'usdc';
  typeQuote: 'sui' | 'usdc' | 'deep';
  feeBps: number;
}

const POOLS: PoolDef[] = [
  // DEEP/SUI
  { id: '0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2', name: 'Cetus 0.25% DEEP/SUI', typeBase: 'deep', typeQuote: 'sui', feeBps: 25 },
  { id: '0xd978d331772a5b90d5a4781e1232d18afd12019d0c35db79e3674beeda8f9126', name: 'Cetus 0.05% DEEP/SUI', typeBase: 'deep', typeQuote: 'sui', feeBps: 5 },
  { id: '0x7242459a663c4e59434252ceb27c228f6b1f21f2ba506f3b62d71b19a7421cc1', name: 'Bluefin 0.175% DEEP/SUI', typeBase: 'deep', typeQuote: 'sui', feeBps: 17.5 },
  // DEEP/USDC
  { id: '0xa2f4e24dc234cf024bae1bd5b1275ab5bdc7c28dd1ec84dd98c2d012bbd315f0', name: 'Cetus 0.05% DEEP/USDC', typeBase: 'deep', typeQuote: 'usdc', feeBps: 5 },
  { id: '0xd5e3a3c7396702d8f358a63ef921cc7c1951f52c6dfc2051cc8772cf7cb9900c', name: 'Bluefin 0.2% DEEP/USDC', typeBase: 'deep', typeQuote: 'usdc', feeBps: 20 },
];

interface PoolSnapshot {
  def: PoolDef;
  sqrtPrice: bigint;
  feeBps: number;
  typeBaseInTypeQuote: number;
}

async function fetchPool(client: SuiClient, def: PoolDef): Promise<PoolSnapshot> {
  const res = await client.getObject({ id: def.id, options: { showContent: true, showType: true } });
  if (!res.data || res.error) throw new Error(`Failed to fetch ${def.name}: ${res.error ?? 'no data'}`);
  const content = res.data.content;
  if (content?.dataType !== 'moveObject') throw new Error(`${def.name} is not a Move object`);
  const fields = content.fields as Record<string, unknown>;
  const sqrtPrice = BigInt(String(fields.sqrt_price ?? fields.current_sqrt_price));
  const sqrtF = Number(sqrtPrice) / Number(Q64);
  const priceRaw = sqrtF * sqrtF;
  const decB = DECIMALS[def.typeBase];
  const decQ = DECIMALS[def.typeQuote];
  const typeBaseInTypeQuote = priceRaw * Math.pow(10, decB - decQ);
  const feeRaw = Number(fields.fee ?? fields.fee_rate ?? 0);
  const feeBps = feeRaw / 100;
  return { def, sqrtPrice, feeBps, typeBaseInTypeQuote };
}

function describe(snap: PoolSnapshot): string {
  const px = snap.typeBaseInTypeQuote;
  if (snap.def.typeBase === 'deep' && snap.def.typeQuote === 'sui') {
    return `1 DEEP = ${px.toFixed(6)} SUI = ${(px * 0.745).toFixed(6)} USDC`;
  }
  if (snap.def.typeBase === 'deep' && snap.def.typeQuote === 'usdc') {
    return `1 DEEP = ${px.toFixed(6)} USDC`;
  }
  return `1 ${snap.def.typeBase.toUpperCase()} = ${px.toFixed(6)} ${snap.def.typeQuote.toUpperCase()}`;
}

interface ArbResult {
  pair: string;
  sellPool: string;
  buyPool: string;
  pnlDeep: bigint;
  pnlUsd: number;
  spreadBps: number;
  requiredBps: number;
}

function simulateDeepArb(
  borrowDeep: bigint,
  sellPool: PoolSnapshot,
  buyPool: PoolSnapshot,
  sellUsdPerDeep: number,
  buyUsdPerDeep: number,
  gasUsd: number
): { pnl: bigint; required: number } {
  // Step 1: sell borrowDeep DEEP on sellPool for USDC.
  // gross usdc = borrowDeep * sellUsdPerDeep
  // after DEX fee: gross * (1 - sellFee)
  const sellGrossUsdcRaw = BigInt(Math.round((Number(borrowDeep) / 1e6) * sellUsdPerDeep * 1e6));
  const usdcOut = (sellGrossUsdcRaw * BigInt(Math.round(10_000 - sellPool.feeBps))) / 10_000n;

  // Step 2: buy DEEP on buyPool with that USDC.
  const buyGrossDeepRaw = BigInt(Math.round((Number(usdcOut) / 1e6) * (1 / buyUsdPerDeep) * 1e6));
  const deepBack = (buyGrossDeepRaw * BigInt(Math.round(10_000 - buyPool.feeBps))) / 10_000n;

  const gasDeep = BigInt(Math.round((gasUsd / sellUsdPerDeep) * 1e6));
  const pnl = deepBack - borrowDeep - gasDeep;
  const required = sellPool.feeBps + buyPool.feeBps;
  return { pnl, required };
}

function poolUsdPerDeep(snap: PoolSnapshot): number | null {
  const px = snap.typeBaseInTypeQuote;
  if (snap.def.typeBase === 'deep' && snap.def.typeQuote === 'usdc') return px;
  if (snap.def.typeBase === 'deep' && snap.def.typeQuote === 'sui') return px * 0.745;
  if (snap.def.typeBase === 'sui' && snap.def.typeQuote === 'deep') return (1 / px) * 0.745;
  if (snap.def.typeBase === 'usdc' && snap.def.typeQuote === 'deep') return 1 / px;
  return null;
}

async function main(): Promise<void> {
  const client = new SuiClient({ url: getFullnodeUrl('mainnet') });
  console.log('Fetching live DEEP-pair pool sqrt_price from SUI mainnet...\n');

  const snaps: PoolSnapshot[] = [];
  for (const p of POOLS) {
    try {
      snaps.push(await fetchPool(client, p));
    } catch (err) {
      console.log(`  (skip ${p.name}: ${(err as Error).message})`);
    }
  }

  console.log('=== Spot prices (DEEP-paired) ===');
  for (const s of snaps) {
    console.log(`  ${s.def.name.padEnd(28)} ${describe(s)}  (sqrt_price=${s.sqrtPrice}, ${s.feeBps} bps)`);
  }

  // DEEP-borrowed cross-DEX arb. DeepBookV3 charges 0 bps; only DEX fees.
  const borrowDeep = 100_000_000_000n; // 100,000 DEEP = ~$1,650
  const gasUsd = 0.005; // ~0.005 USD of SUI gas

  console.log(`\n=== DEEP-borrowed 2-leg cross-DEX arb (borrow ${Number(borrowDeep) / 1e6} DEEP, DeepBookV3 fee=0 bps) ===\n`);

  const results: ArbResult[] = [];
  for (let i = 0; i < snaps.length; i++) {
    for (let j = 0; j < snaps.length; j++) {
      if (i === j) continue;
      const sell = snaps[i];
      const buy = snaps[j];
      const sellPx = poolUsdPerDeep(sell);
      const buyPx = poolUsdPerDeep(buy);
      if (sellPx === null || buyPx === null) continue;
      const { pnl, required } = simulateDeepArb(borrowDeep, sell, buy, sellPx, buyPx, gasUsd);
      const spreadBps = (Math.abs(sellPx - buyPx) / Math.min(sellPx, buyPx)) * 10_000;
      const pnlUsd = (Number(pnl) / 1e6) * Math.max(sellPx, buyPx);
      const profitable = pnl > 0n ? '✓' : ' ';
      console.log(`  ${profitable} ${sell.def.name.padEnd(28)} @ $${sellPx.toFixed(6)} → ${buy.def.name.padEnd(28)} @ $${buyPx.toFixed(6)} | spread=${spreadBps.toFixed(2)} bps req=${required} bps | PnL=${(Number(pnl) / 1e6).toFixed(2)} DEEP ($${pnlUsd.toFixed(4)})`);
      results.push({ pair: `${sell.def.name} → ${buy.def.name}`, sellPool: sell.def.name, buyPool: buy.def.name, pnlDeep: pnl, pnlUsd, spreadBps, requiredBps: required });
    }
  }

  const best = results.length > 0 ? results.reduce<ArbResult>((a, b) => (b.pnlDeep > a.pnlDeep ? b : a), results[0]) : null;
  console.log(`\n=== Best DEEP-borrowed arb ===`);
  if (best && best.pnlDeep > 0n) {
    console.log(`✓ ${best.pair}`);
    console.log(`  PnL: ${(Number(best.pnlDeep) / 1e6).toFixed(2)} DEEP ($${best.pnlUsd.toFixed(4)})`);
    console.log(`  Spread: ${best.spreadBps.toFixed(2)} bps, required: ${best.requiredBps} bps`);
  } else if (best) {
    console.log(`✗ NO profitable DEEP-borrowed arb at this snapshot.`);
    console.log(`  Best (least-negative) PnL: ${(Number(best.pnlDeep) / 1e6).toFixed(2)} DEEP`);
    console.log(`  Best spread: ${best.spreadBps.toFixed(2)} bps, min required: ${best.requiredBps} bps`);
  }

  // Time-series check
  console.log(`\n=== Time-series check (5 samples at 1s) ===`);
  let maxSpread = 0;
  let bestPair = '';
  for (let t = 0; t < 5; t++) {
    const ts: PoolSnapshot[] = [];
    for (const p of POOLS) {
      try { ts.push(await fetchPool(client, p)); } catch { /* skip */ }
    }
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        const px1 = poolUsdPerDeep(ts[i]);
        const px2 = poolUsdPerDeep(ts[j]);
        if (px1 === null || px2 === null) continue;
        const sp = (Math.abs(px1 - px2) / Math.min(px1, px2)) * 10_000;
        if (sp > maxSpread) {
          maxSpread = sp;
          bestPair = `${ts[i].def.name} ↔ ${ts[j].def.name}`;
        }
      }
    }
    if (t < 4) await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  Max spread: ${maxSpread.toFixed(2)} bps (${bestPair})`);

  console.log(`\n=== Verdict ===`);
  if (maxSpread > 30) {
    console.log(`✓ Max DEEP-pair spread > 30 bps — viable opportunity.`);
  } else if (maxSpread > 10) {
    console.log(`? Max DEEP-pair spread is 10-30 bps — needs a low-fee combination (5+5) to break even.`);
  } else {
    console.log(`✗ DEEP-pair spreads < 10 bps — even with free DeepBookV3 flashloan, no arb on this pair.`);
    console.log(`  Try DEEP/SUI 0.05% (Cetus) ↔ DEEP/SUI 0.175% (Bluefin) once we add the Bluefin pool.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
