/**
 * Profitability check.
 *
 * Reads live SUI/USDC pool sqrt_price from Cetus and Turbos, then
 * computes the round-trip arb PnL for a flashloan-borrowed SUI
 * position.
 *
 * CLMM pools store virtual reserves in `coin_a`/`coin_b` that don't
 * reflect actual token amounts. The spot price is derived from
 * `sqrt_price`:
 *   price_raw = (sqrt_price / 2^64)^2
 * For Pool<SUI, USDC> (Turbos): price_raw = USDC_raw / SUI_raw,
 *   USDC per SUI = price_raw * 10^(dec_SUI - dec_USDC) = price_raw * 10^3
 * For Pool<USDC, SUI> (Cetus): price_raw = SUI_raw / USDC_raw,
 *   USDC per SUI = 10^3 / price_raw
 *
 * For a 3 SUI trade on a >$1M TVL pool, price impact is < 5 bps so
 * we use the spot price as the quote (constant-price model). This
 * is the realistic PnL estimate, not an upper bound.
 *
 * Arb shape:
 *   borrow 3 SUI from NAVI (5 bps fee → repay 3.0015 SUI)
 *   sell 3 SUI on DEX A for USDC
 *   buy SUI on DEX B with that USDC
 *   repay 3.0015 SUI to NAVI
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

const CETUS_POOL = '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105';
const TURBOS_POOL = '0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443';
const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const SUI_TYPE = '0x2::sui::SUI';

const Q64 = 1n << 64n;

interface PoolSnapshot {
  name: string;
  sqrtPrice: bigint;
  feeBps: number;
  type: string;
}

function usdcPerSui(snap: PoolSnapshot): number {
  // Pool<X, Y> means coin_a = X, coin_b = Y
  // sqrt_price = sqrt(coin_b_raw / coin_a_raw) * 2^64
  const isCoinAUsdc = snap.type.includes(USDC_TYPE) && snap.type.indexOf(USDC_TYPE) < snap.type.indexOf(SUI_TYPE);
  const sqrtPriceF = Number(snap.sqrtPrice) / Number(Q64);
  const priceRaw = sqrtPriceF * sqrtPriceF; // = coin_b_raw / coin_a_raw
  // SUI 9 decimals, USDC 6 decimals
  // 1 normalized SUI = 10^9 raw SUI, 1 normalized USDC = 10^6 raw USDC
  // Turbos (Pool<SUI, USDC>): price_raw = USDC_raw/SUI_raw
  //   1 SUI in USDC_raw = price_raw * 10^9
  //   1 SUI in USDC = (price_raw * 10^9) / 10^6 = price_raw * 10^3
  // Cetus (Pool<USDC, SUI>): price_raw = SUI_raw/USDC_raw
  //   1 SUI in USDC_raw = 10^9 / (price_raw * 10^6) — needs price_raw > 0
  //   1 SUI in USDC = (10^9 / (price_raw * 10^6)) / 10^6 = 10^9 / (price_raw * 10^12) = 1 / (price_raw * 10^3)
  //   = 10^3 / price_raw (rearranged)
  const decAdj = 1000; // 10^(9-6)
  return isCoinAUsdc ? decAdj / priceRaw : priceRaw * decAdj;
}

async function fetchPool(client: SuiClient, id: string, name: string): Promise<PoolSnapshot> {
  const res = await client.getObject({ id, options: { showContent: true, showType: true } });
  if (!res.data || res.error) {
    throw new Error(`Failed to fetch ${name} pool ${id}: ${res.error ?? 'no data'}`);
  }
  const content = res.data.content;
  if (content?.dataType !== 'moveObject') {
    throw new Error(`${name} pool is not a Move object`);
  }
  const fields = content.fields as Record<string, unknown>;
  const type = res.data.type ?? '';
  const sqrtPriceRaw = fields.sqrt_price ?? fields.current_sqrt_price;
  const sqrtPrice = BigInt(String(sqrtPriceRaw));
  // Both Cetus (fee_rate) and Turbos (fee) encode in 1/100 bps
  const feeRaw = Number(fields.fee ?? fields.fee_rate ?? 0);
  const feeBps = feeRaw / 100;
  return { name, sqrtPrice, feeBps, type };
}

async function main() {
  const client = new SuiClient({ url: getFullnodeUrl('mainnet') });
  console.log('Fetching live SUI/USDC pool sqrt_price from SUI mainnet...\n');

  const [cetus, turbos] = await Promise.all([
    fetchPool(client, CETUS_POOL, 'cetus'),
    fetchPool(client, TURBOS_POOL, 'turbos'),
  ]);

  const cetusPx = usdcPerSui(cetus);
  const turbosPx = usdcPerSui(turbos);
  console.log('=== Spot prices (from sqrt_price) ===');
  console.log(`Cetus:  SUI/USDC = $${cetusPx.toFixed(6)}  (sqrt_price=${cetus.sqrtPrice}, ${cetus.feeBps} bps fee)`);
  console.log(`Turbos: SUI/USDC = $${turbosPx.toFixed(6)}  (sqrt_price=${turbos.sqrtPrice}, ${turbos.feeBps} bps fee)`);

  const spreadBps = (Math.abs(cetusPx - turbosPx) / Math.min(cetusPx, turbosPx)) * 10_000;
  console.log(`\nRaw price spread: ${spreadBps.toFixed(4)} bps`);

  // Round-trip arb using spot-price quote (constant-price model).
  // For 3 SUI on >$1M pool, price impact is < 5 bps, so this is
  // a realistic lower bound on revenue. Real CLMM math would give
  // a slightly higher number (we'd pocket a bit of price impact
  // on the side that's paying more).
  const borrowSui = 3_000_000_000n; // 3 SUI (NAVI minimum)
  const naviFeeBps = 5;
  const naviFee = (borrowSui * BigInt(naviFeeBps)) / 10_000n;
  const repaySui = borrowSui + naviFee;
  console.log(`\n=== Arb: borrow 3 SUI from NAVI, fee ${Number(naviFee) / 1e9} SUI, repay ${Number(repaySui) / 1e9} SUI ===\n`);

  // Sell on the more-expensive pool (higher USDC-per-SUI = more USDC received)
  const sellDex = cetusPx > turbosPx ? cetus : turbos;
  const buyDex = sellDex === cetus ? turbos : cetus;
  const sellName = sellDex.name;
  const buyName = buyDex.name;
  const sellPx = sellDex === cetus ? cetusPx : turbosPx;
  const buyPx = buyDex === cetus ? cetusPx : turbosPx;
  console.log(`Direction: SELL SUI on ${sellName} (SUI @ $${sellPx.toFixed(4)}), BUY SUI on ${buyName} (SUI @ $${buyPx.toFixed(4)})\n`);

  // Step 1: sell 3 SUI on the higher-priced pool
  // gross usdc = 3 SUI * sellPx USDC/SUI
  // after DEX fee: gross * (1 - sellFee)
  const grossUsdcRaw = BigInt(Math.round((Number(borrowSui) / 1e9) * sellPx * 1e6));
  const usdcOut = (grossUsdcRaw * BigInt(10_000 - sellDex.feeBps)) / 10_000n;

  // Step 2: buy SUI on the lower-priced pool with that USDC
  // gross sui = usdc / buyPx
  // after DEX fee: gross * (1 - buyFee)
  const grossSuiRaw = BigInt(Math.round((Number(usdcOut) / 1e6) * (1 / buyPx) * 1e9));
  const suiBack = (grossSuiRaw * BigInt(10_000 - buyDex.feeBps)) / 10_000n;

  console.log(`Step 1: borrow ${Number(borrowSui) / 1e9} SUI from NAVI`);
  console.log(`Step 2: sell ${Number(borrowSui) / 1e9} SUI on ${sellName} (${sellDex.feeBps} bps fee) → ${(Number(usdcOut) / 1e6).toFixed(6)} USDC`);
  console.log(`Step 3: buy SUI on ${buyName} with ${(Number(usdcOut) / 1e6).toFixed(6)} USDC (${buyDex.feeBps} bps fee) → ${(Number(suiBack) / 1e9).toFixed(9)} SUI`);
  console.log(`Step 4: repay ${Number(repaySui) / 1e9} SUI to NAVI`);

  const pnlSui = suiBack - repaySui;
  const refPrice = Math.max(cetusPx, turbosPx);
  const pnlUsd = (Number(pnlSui) / 1e9) * refPrice;
  console.log(`\n=== Result ===`);
  console.log(`PnL: ${(Number(pnlSui) / 1e9).toFixed(9)} SUI ($${pnlUsd.toFixed(6)})`);
  console.log(`Status: ${pnlSui > 0n ? 'PROFITABLE' : pnlSui === 0n ? 'BREAKEVEN' : 'UNPROFITABLE'}`);

  // Gas estimate: ~5M MIST (0.005 SUI) for a 5-call PTB
  const gasEstimateSui = 0.005;
  const gasSui = BigInt(Math.round(gasEstimateSui * 1e9));
  const pnlAfterGas = pnlSui - gasSui;
  console.log(`Gas estimate: ${gasEstimateSui} SUI`);
  console.log(`PnL after gas: ${(Number(pnlAfterGas) / 1e9).toFixed(9)} SUI ($${((Number(pnlAfterGas) / 1e9) * refPrice).toFixed(6)})`);
  console.log(`Status: ${pnlAfterGas > 0n ? 'PROFITABLE after gas' : pnlAfterGas === 0n ? 'BREAKEVEN after gas' : 'UNPROFITABLE after gas'}`);

  // Required spread for break-even
  const requiredSpreadBps = naviFeeBps + sellDex.feeBps + buyDex.feeBps;
  console.log(`\n=== Required gross spread for break-even ===`);
  console.log(`NAVI fee: ${naviFeeBps} bps`);
  console.log(`${sellName} fee: ${sellDex.feeBps} bps`);
  console.log(`${buyName} fee: ${buyDex.feeBps} bps`);
  console.log(`Required: ${requiredSpreadBps} bps (before gas)`);
  console.log(`Observed: ${spreadBps.toFixed(4)} bps`);
  console.log(`\nVerdict: ${spreadBps > requiredSpreadBps ? 'OPPORTUNITY EXISTS at this snapshot' : 'NO OPPORTUNITY at this snapshot'}`);

  // Note: this is a single-snapshot, single-pair check
  console.log(`\n=== Time-series check (10 samples at 1s interval) ===`);
  let maxSpread = 0;
  let minSpread = Infinity;
  for (let i = 0; i < 10; i++) {
    const [c, t] = await Promise.all([
      fetchPool(client, CETUS_POOL, 'cetus'),
      fetchPool(client, TURBOS_POOL, 'turbos'),
    ]);
    const cp = usdcPerSui(c);
    const tp = usdcPerSui(t);
    const s = (Math.abs(cp - tp) / Math.min(cp, tp)) * 10_000;
    maxSpread = Math.max(maxSpread, s);
    minSpread = Math.min(minSpread, s);
    console.log(`  t+${i}s: cetus=$${cp.toFixed(4)} turbos=$${tp.toFixed(4)} spread=${s.toFixed(2)} bps`);
    if (i < 9) await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`\nObserved spread range: ${minSpread.toFixed(2)} - ${maxSpread.toFixed(2)} bps`);
  console.log(`Required for break-even: ${requiredSpreadBps} bps`);
  console.log(`\n${maxSpread > requiredSpreadBps ? 'OPPORTUNITY observed during poll' : 'NO OPPORTUNITY observed in 10s window'}`);

  console.log(`\n=== Notes ===`);
  console.log(`- Single-pair, single-snapshot test. Bot monitors every 1s across multiple pairs/DEXes.`);
  console.log(`- DEEP/USDC and other long-tail pairs often have wider spreads (less efficient).`);
  console.log(`- Spreads on SUI/USDC are typically 1-5 bps; profitable arb requires an edge > ${requiredSpreadBps} bps.`);
  console.log(`- For a $0.74 SUI, 3 SUI trade, that's $0.0075 of gross edge needed to break even.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
