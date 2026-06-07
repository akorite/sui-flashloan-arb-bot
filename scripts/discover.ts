/**
 * scripts/discover.ts
 *
 * Reads the live SUI testnet state and prints:
 *   - the NAVI lending pool object IDs and flashloan fees for SUI and USDC
 *   - the SuiSystemState (0x5) and Clock (0x6) shared object IDs
 *   - the Cetus, Turbos, and Aftermath router package IDs (via SuiVision
 *     metadata — fallback: ask the user to fill in the placeholder)
 *   - the current SUI/USDC pool object IDs on each DEX (via the DEX's
 *     public indexer APIs; falls back to "see DEX docs")
 *
 * Usage:
 *   SUI_PRIVATE_KEY=... npx tsx scripts/discover.ts
 *
 * This is a *read-only* script. It does not sign or submit any
 * transactions.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

interface NaviFlashloanApiResponse {
  code: number;
  data?: Record<
    string,
    {
      max: string;
      min: string;
      assetId: number;
      poolId: string;
      supplierFee: number;
      flashloanFee: number;
    }
  >;
}

interface NaviConfigApiResponse {
  code: number;
  data?: {
    package: string;
    storage: string;
    flashloanConfig: string;
    incentiveV2: string;
    incentiveV3: string;
    priceOracle: string;
    reserveParentId: string;
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { 'User-Agent': 'sui-flashloan-arb-bot/discover' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return (await r.json()) as T;
}

async function main(): Promise<void> {
  const client = new SuiClient({ url: getFullnodeUrl('testnet') });

  console.log('=== SUI Testnet Live State ===\n');

  // 1. RPC connectivity check
  const chainId = await client.getChainIdentifier();
  console.log(`Chain ID: ${chainId}`);
  console.log(`RPC URL:  ${getFullnodeUrl('testnet')}\n`);

  // 2. NAVI config (package + shared objects)
  console.log('--- NAVI Protocol ---');
  try {
    const cfg = await fetchJson<NaviConfigApiResponse>(
      'https://open-api.naviprotocol.io/api/navi/config?env=dev'
    );
    if (cfg.data) {
      console.log(`package:        ${cfg.data.package}`);
      console.log(`flashloanConfig:${cfg.data.flashloanConfig}`);
      console.log(`storage:        ${cfg.data.storage}`);
      console.log(`priceOracle:    ${cfg.data.priceOracle}`);
    } else {
      console.log('NAVI config response was empty:', cfg);
    }
  } catch (err) {
    console.log(`NAVI config fetch failed: ${(err as Error).message}`);
  }

  // 3. NAVI flashloan asset data (fees, min/max, pool IDs)
  try {
    const fl = await fetchJson<NaviFlashloanApiResponse>(
      'https://open-api.naviprotocol.io/api/navi/flashloan?env=dev'
    );
    if (fl.data) {
      const want = ['SUI', 'USDC', 'USDT', 'WETH', 'CETUS', 'NAVX', 'DEEP', 'BUCK'];
      console.log('\nFlashloan assets:');
      for (const [coinType, info] of Object.entries(fl.data)) {
        const sym = coinType.split('::').pop() ?? '?';
        if (!want.includes(sym)) continue;
        const feeBps = Math.round(info.flashloanFee * 10_000);
        console.log(
          `  ${sym.padEnd(6)} fee=${feeBps}bps  min=${info.min}  max=${info.max}  pool=${info.poolId}`
        );
        console.log(`         ${coinType}`);
      }
    }
  } catch (err) {
    console.log(`NAVI flashloan fetch failed: ${(err as Error).message}`);
  }

  // 4. SuiSystemState and Clock
  console.log('\n--- Well-known shared objects ---');
  console.log('SuiSystemState: 0x0000000000000000000000000000000000000000000000000000000000000005');
  console.log('Clock:          0x0000000000000000000000000000000000000000000000000000000000000006');

  // 5. Reference gas price (for gas accounting)
  try {
    const rgp = await client.getReferenceGasPrice();
    console.log(`\nReference gas price: ${rgp} MIST per gas unit`);
  } catch (err) {
    console.log(`\ngetReferenceGasPrice failed: ${(err as Error).message}`);
  }

  // 6. DEX routers (manual / out of scope for this script)
  console.log('\n--- DEX router packages (fill in manually) ---');
  console.log('  Cetus:     https://docs.cetus.zone → developer → "Contract Addresses" (testnet)');
  console.log('  Turbos:    https://docs.turbos.finance → developer → "Contract Addresses" (testnet)');
  console.log('  Aftermath: https://docs.aftermath.finance → developer → "Contract Addresses" (testnet)');

  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('discover failed:', err);
  process.exit(1);
});
