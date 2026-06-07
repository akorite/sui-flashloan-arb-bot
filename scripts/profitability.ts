/**
 * Profitability check across multiple SUI pools and pairs.
 *
 * Reads live sqrt_price from multiple CLMM pools, then computes the
 * round-trip arb PnL for a flashloan-borrowed position. We test all
 * pool pairs to find the best possible edge.
 *
 * Pools tested:
 *   SUI/USDC: Cetus 0.25%, Cetus 0.05%, Turbos 0.05%
 *   DEEP/SUI: Cetus 0.05%
 *
 * CLMM sqrt_price decoding (verified empirically):
 *   For Pool<typeBase, typeQuote>:
 *     sqrt_price = sqrt(typeQuote_raw / typeBase_raw) * 2^64
 *   Cetus 0.25% (Pool<USDC, SUI>): sqrt_price = sqrt(SUI_raw/USDC_raw) * 2^64
 *   Turbos 0.05% (Pool<SUI, USDC>): sqrt_price = sqrt(USDC_raw/SUI_raw) * 2^64
 *   normalized ratio (typeQuote per typeBase) = (sqrt_price/2^64)^2 * 10^(dec_typeQuote - dec_typeBase)
 *
 * For a small trade on a $1M+ pool, price impact is < 5 bps so we
 * use the spot price as the quote (constant-price model). This is
 * a realistic lower bound on revenue.
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
  // The DEX types the pool as Pool<typeBase, typeQuote>; sqrt_price encodes
  // sqrt(typeQuote_raw / typeBase_raw) * 2^64.
  typeBase: 'usdc' | 'sui' | 'deep';
  typeQuote: 'sui' | 'usdc' | 'deep';
  feeBps: number;
}

const POOLS: PoolDef[] = [
  { id: '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105', name: 'Cetus 0.25% SUI/USDC', typeBase: 'usdc', typeQuote: 'sui', feeBps: 25 },
  { id: '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab', name: 'Cetus 0.05% SUI/USDC', typeBase: 'usdc', typeQuote: 'sui', feeBps: 5 },
  { id: '0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443', name: 'Turbos 0.05% SUI/USDC', typeBase: 'sui', typeQuote: 'usdc', feeBps: 5 },
  { id: '0xd978d331772a5b90d5a4781e1232d18afd12019d0c35db79e3674beeda8f9126', name: 'Cetus 0.05% DEEP/SUI', typeBase: 'deep', typeQuote: 'sui', feeBps: 5 },
];

interface PoolSnapshot {
  def: PoolDef;
  sqrtPrice: bigint;
  feeBps: number;
  type: string;
  // Spot price in normalized units: 1 typeBase costs this many typeQuote.
  typeBaseInTypeQuote: number;
}

/** Read a pool and return the spot price in normalized units (typeQuote per typeBase). */
async function fetchPool(client: SuiClient, def: PoolDef): Promise<PoolSnapshot> {
  const res = await client.getObject({ id: def.id, options: { showContent: true, showType: true } });
  if (!res.data || res.error) {
    throw new Error(`Failed to fetch ${def.name}: ${res.error ?? 'no data'}`);
  }
  const content = res.data.content;
  if (content?.dataType !== 'moveObject') {
    throw new Error(`${def.name} is not a Move object`);
  }
  const fields = content.fields as Record<string, unknown>;
  const type = res.data.type ?? '';
  const sqrtPrice = BigInt(String(fields.sqrt_price ?? fields.current_sqrt_price));
  // price_raw (typeQuote_raw per typeBase_raw) = (sqrt_price / 2^64)^2
  const sqrtF = Number(sqrtPrice) / Number(Q64);
  const priceRaw = sqrtF * sqrtF;
  const decB = DECIMALS[def.typeBase];
  const decQ = DECIMALS[def.typeQuote];
  // Normalize: 1 typeBase in raw = priceRaw typeQuote in raw
  //           1 typeBase normalized (10^decB raw) = priceRaw * 10^decB typeQuote_raw
  //           In normalized typeQuote (10^decQ): (priceRaw * 10^decB) / 10^decQ
  //           = priceRaw * 10^(decB - decQ)
  const typeBaseInTypeQuote = priceRaw * Math.pow(10, decB - decQ);
  const feeRaw = Number(fields.fee ?? fields.fee_rate ?? 0);
  const feeBps = feeRaw / 100;
  return { def, sqrtPrice, feeBps, type, typeBaseInTypeQuote };
}

/** Display helper: convert (typeBase, typeQuote, price) to a natural pair display. */
function describePrice(snap: PoolSnapshot): string {
  const { typeBase, typeQuote } = snap.def;
  const px = snap.typeBaseInTypeQuote;
  // Common pair formatters: SUI/USDC shows $0.74 per SUI, not 1.34M SUI per USDC
  if (typeBase === 'usdc' && typeQuote === 'sui') {
    // price = SUI per USDC. Invert for "USDC per SUI" (the natural way to display SUI price)
    return `1 SUI = ${(1 / px).toFixed(6)} USDC`;
  }
  if (typeBase === 'sui' && typeQuote === 'usdc') {
    return `1 SUI = ${px.toFixed(6)} USDC`;
  }
  if (typeBase === 'deep' && typeQuote === 'sui') {
    // price = SUI per DEEP
    return `1 DEEP = ${px.toFixed(4)} SUI = ${(px * 0.745).toFixed(6)} USDC`;
  }
  return `1 ${typeBase.toUpperCase()} = ${px.toFixed(6)} ${typeQuote.toUpperCase()}`;
}

interface ArbResult {
  pair: string;
  sellPool: string;
  buyPool: string;
  pnlSui: bigint; // in MIST (1e9 = 1 SUI)
  pnlUsd: number;
  spreadBps: number;
  requiredBps: number;
  sellUsdcPerSui: number;
  buyUsdcPerSui: number;
}

/**
 * Simulate: borrow SUI, sell for USDC on sellPool, buy SUI back on buyPool.
 * sellUsdcPerSui / buyUsdcPerSui are the spot prices in USDC per SUI terms.
 */
function simulateSuiArb(
  borrowSui: bigint,
  naviFeeBps: number,
  sellPool: PoolSnapshot,
  buyPool: PoolSnapshot,
  sellUsdcPerSui: number,
  buyUsdcPerSui: number,
  gasSui: bigint
): { pnl: bigint; required: number } {
  const repaySui = borrowSui + (borrowSui * BigInt(naviFeeBps)) / 10_000n;

  // Step 1: sell borrowSui SUI on sellPool, get USDC
  // gross usdc = borrowSui * sellUsdcPerSui
  // after DEX fee: gross * (1 - sellFee)
  const sellGrossUsdcRaw = BigInt(Math.round((Number(borrowSui) / 1e9) * sellUsdcPerSui * 1e6));
  const usdcOut = (sellGrossUsdcRaw * BigInt(10_000 - sellPool.feeBps)) / 10_000n;

  // Step 2: buy SUI on buyPool with that USDC
  // gross sui = usdcOut / buyUsdcPerSui
  // after DEX fee: gross * (1 - buyFee)
  const buyGrossSuiRaw = BigInt(Math.round((Number(usdcOut) / 1e6) * (1 / buyUsdcPerSui) * 1e9));
  const suiBack = (buyGrossSuiRaw * BigInt(10_000 - buyPool.feeBps)) / 10_000n;

  const pnl = suiBack - repaySui - gasSui;
  const required = naviFeeBps + sellPool.feeBps + buyPool.feeBps;
  return { pnl, required };
}

function poolUsdcPerSui(snap: PoolSnapshot): number | null {
  const { typeBase, typeQuote } = snap.def;
  if (typeBase === 'sui' && typeQuote === 'usdc') return snap.typeBaseInTypeQuote;
  if (typeBase === 'usdc' && typeQuote === 'sui') return 1 / snap.typeBaseInTypeQuote;
  return null;
}

async function main() {
  const client = new SuiClient({ url: getFullnodeUrl('mainnet') });
  console.log('Fetching live pool sqrt_price from SUI mainnet...\n');

  const snaps = await Promise.all(POOLS.map((p) => fetchPool(client, p)));

  console.log('=== Spot prices ===');
  for (const s of snaps) {
    const desc = describePrice(s);
    console.log(`  ${s.def.name.padEnd(28)} ${desc}  (sqrt_price=${s.sqrtPrice}, ${s.feeBps} bps)`);
  }

  const naviFeeBps = 5;
  const gasSui = 5_000_000n; // 0.005 SUI
  const borrowSui = 3_000_000_000n; // 3 SUI

  // SUI/USDC arb: test all pairs
  const suiUsdcSnaps = snaps.filter((s) => (s.def.typeBase === 'sui' && s.def.typeQuote === 'usdc') || (s.def.typeBase === 'usdc' && s.def.typeQuote === 'sui'));
  console.log(`\n=== SUI/USDC arb (borrow 3 SUI, repay 3.0015 SUI + 0.005 gas) ===\n`);

  const results: ArbResult[] = [];
  for (let i = 0; i < suiUsdcSnaps.length; i++) {
    for (let j = 0; j < suiUsdcSnaps.length; j++) {
      if (i === j) continue;
      const sell = suiUsdcSnaps[i];
      const buy = suiUsdcSnaps[j];
      const sellPx = poolUsdcPerSui(sell);
      const buyPx = poolUsdcPerSui(buy);
      if (sellPx === null || buyPx === null) continue;
      const { pnl, required } = simulateSuiArb(borrowSui, naviFeeBps, sell, buy, sellPx, buyPx, gasSui);
      const spreadBps = (Math.abs(sellPx - buyPx) / Math.min(sellPx, buyPx)) * 10_000;
      const pnlUsd = (Number(pnl) / 1e9) * Math.max(sellPx, buyPx);
      const profitable = pnl > 0n ? '✓' : ' ';
      console.log(`  ${profitable} ${sell.def.name.padEnd(28)} @ $${sellPx.toFixed(6)} → ${buy.def.name.padEnd(28)} @ $${buyPx.toFixed(6)} | spread=${spreadBps.toFixed(2)} bps req=${required} bps | PnL=${(Number(pnl) / 1e9).toFixed(6)} SUI ($${pnlUsd.toFixed(6)})`);
      results.push({ pair: `${sell.def.name} → ${buy.def.name}`, sellPool: sell.def.name, buyPool: buy.def.name, pnlSui: pnl, pnlUsd, spreadBps, requiredBps: required, sellUsdcPerSui: sellPx, buyUsdcPerSui: buyPx });
    }
  }

  // Best arb (highest pnlSui, i.e. least negative)
  const best = results.length > 0
    ? results.reduce<ArbResult>((a, b) => (b.pnlSui > a.pnlSui ? b : a), results[0])
    : null;
  console.log(`\n=== Best SUI/USDC arb ===`);
  if (best && best.pnlSui > 0n) {
    console.log(`✓ ${best.pair}`);
    console.log(`  PnL: ${(Number(best.pnlSui) / 1e9).toFixed(6)} SUI ($${best.pnlUsd.toFixed(6)})`);
    console.log(`  Spread: ${best.spreadBps.toFixed(2)} bps, required: ${best.requiredBps} bps`);
  } else if (best) {
    console.log(`✗ NO profitable SUI/USDC arb at this snapshot.`);
    console.log(`  Best (least-negative) PnL: ${(Number(best.pnlSui) / 1e9).toFixed(6)} SUI`);
    console.log(`  Best spread: ${best.spreadBps.toFixed(2)} bps, min required: ${best.requiredBps} bps`);
  } else {
    console.log(`  (no SUI/USDC pool combinations tested)`);
  }

  // DEEP/SUI status
  const deepSuiSnap = snaps.find((s) => s.def.typeBase === 'deep' || s.def.typeQuote === 'deep');
  if (deepSuiSnap) {
    console.log(`\n=== DEEP/SUI status ===`);
    console.log(`  ${describePrice(deepSuiSnap)}`);
    console.log(`  Only 1 DEEP pool found in our search; cross-DEX DEEP arb needs a second DEEP pool.`);
  }

  // Time-series check (5 samples at 1s)
  console.log(`\n=== Time-series check (5 samples at 1s) ===`);
  // Only consider pools that participate in the 0.05% + 0.05% tier
  // (Turbos 0.05% + Cetus 0.05% combo needs 15 bps to break even)
  const tier5BpsIds = new Set([
    '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab', // Cetus 0.05% SUI/USDC
    '0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443', // Turbos 0.05% SUI/USDC
  ]);
  const tier5BpsPools = POOLS.filter((p) => tier5BpsIds.has(p.id));
  let maxSpread5 = 0;
  let bestPair5 = '';
  let maxSpreadAny = 0;
  let bestPairAny = '';
  for (let t = 0; t < 5; t++) {
    const ts = await Promise.all(POOLS.map((p) => fetchPool(client, p)));
    // 0.05% + 0.05% combo
    const [a, b] = ts.filter((s) => tier5BpsIds.has(s.def.id));
    const pa = poolUsdcPerSui(a);
    const pb = poolUsdcPerSui(b);
    if (pa !== null && pb !== null) {
      const sp = (Math.abs(pa - pb) / Math.min(pa, pb)) * 10_000;
      if (sp > maxSpread5) {
        maxSpread5 = sp;
        bestPair5 = `${a.def.name} ↔ ${b.def.name}`;
      }
    }
    // Any tier
    let localMax = 0;
    let localPair = '';
    for (let i = 0; i < suiUsdcSnaps.length; i++) {
      for (let j = i + 1; j < suiUsdcSnaps.length; j++) {
        const px1 = poolUsdcPerSui(ts[POOLS.indexOf(suiUsdcSnaps[i].def)]);
        const px2 = poolUsdcPerSui(ts[POOLS.indexOf(suiUsdcSnaps[j].def)]);
        if (px1 === null || px2 === null) continue;
        const sp = (Math.abs(px1 - px2) / Math.min(px1, px2)) * 10_000;
        if (sp > localMax) {
          localMax = sp;
          localPair = `${suiUsdcSnaps[i].def.name} ↔ ${suiUsdcSnaps[j].def.name}`;
        }
      }
    }
    if (localMax > maxSpreadAny) {
      maxSpreadAny = localMax;
      bestPairAny = localPair;
    }
    if (t < 4) await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  0.05% + 0.05% combo (Cetus 0.05% ↔ Turbos 0.05%): max spread = ${maxSpread5.toFixed(2)} bps (need 15 bps)`);
  console.log(`  Any tier: max spread = ${maxSpreadAny.toFixed(2)} bps (${bestPairAny})`);

  console.log(`\n=== Verdict ===`);
  if (maxSpread5 > 15) {
    console.log(`✓ 0.05% + 0.05% combo (Cetus 0.05% ↔ Turbos 0.05%) shows > 15 bps spread — viable opportunity`);
  } else {
    console.log(`✗ 0.05% + 0.05% SUI/USDC spreads are < 15 bps — primary low-fee path is unprofitable.`);
    if (maxSpreadAny > 35) {
      console.log(`  But cross-tier spread (${bestPairAny}) is ${maxSpreadAny.toFixed(2)} bps — needs > 35 bps to be profitable.`);
    } else {
      console.log(`  All spreads < 35 bps, no SUI/USDC arb possible at any tier.`);
    }
    console.log(`\n  Next steps to find profit:`);
    console.log(`  1. Long-tail pairs (NAVX, WAL, HIPPO) on multiple DEXes — these have wider spreads but lower TVL`);
    console.log(`  2. DeepBook CLOB (zero-fee midpoint routing) for the bigger leg`);
    console.log(`  3. Wait for higher-volatility periods (large swap moves price more on thin pools)`);
    console.log(`  4. SUI flashloan via SUI Margin Pool (DeepBook Margin) — only 0 bps? — confirm`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
