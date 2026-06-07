/**
 * Configuration loader and validator.
 *
 * Reads `config.json` from the project root and validates that every
 * required key is present and well-formed. Exits the process with a clear
 * error if anything is missing — better to fail at startup than to crash
 * mid-trade.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Pair {
  base: string;
  quote: string;
}

export interface NaviFlashloanConfig {
  provider: 'navi';
  /** NAVI package ID, e.g. testnet 0xc371fc618faca4671253811faef480903b86c58966e8f899184ebaa640120c64 */
  packageId: string;
  /**
   * NAVI flashloanConfig shared object ID, e.g. testnet
   * 0x071e0587c9a9e9238ee52c8d482876fd7ef3fff9041ffd7b21d32d89d06f2922.
   * This is the `Config` shared object passed as the first argument to
   * `lending::flash_loan_with_ctx_v2`.
   */
  configId: string;
  /**
   * NAVI storage shared object ID, e.g. testnet
   * 0x111b9d70174462646e7e47e6fec5da9eb50cea14e6c5a55a910c8b0e44cd2913.
   * Required for `lending::flash_repay_with_ctx`.
   */
  storageId: string;
  /**
   * SuiSystemState shared object ID. Hardcoded to 0x6 on every network;
   * kept in config for clarity.
   */
  suiSystemStateId: string;
  /** Clock shared object ID. Hardcoded to 0x6 on every network. */
  clockId: string;
  /**
   * The NAVI lending pool object ID for the asset you intend to borrow.
   * For SUI on testnet: 0x68b420259e3adcdadf165350984f59dfdaf677c3d639aaa54c1d907dae2dd1a3.
   * For USDC on testnet: 0x8bf81e96302d4307d8da07e49328875e1f2e205dc0c4d457bffe6a8c1740ba25.
   * The pool object ID is paired with `borrowCoinType` below.
   */
  borrowPoolId: string;
  /** Coin type to borrow, e.g. SUI = "0x2::sui::SUI". */
  borrowCoinType: string;
  /** Borrow function name. NAVI's is `flash_loan_with_ctx_v2`. */
  borrowFn: string;
  /** Repay function name. NAVI's is `flash_repay_with_ctx`. */
  repayFn: string;
}

/**
 * DeepBookV3 flashloan configuration.
 *
 * DeepBookV3 charges NO direct loan fee — the borrow is enforced by a
 * Move "hot potato" (FlashLoan struct with no abilities) that the
 * transaction must consume via `return_flashloan_base` /
 * `return_flashloan_quote` in the same PTB. This drops the required
 * break-even spread from `navi_fee + dex_a + dex_b` to just
 * `dex_a + dex_b`, which unlocks DEEP-paired cross-DEX arbs that
 * would be unprofitable under NAVI's 5 bps surcharge.
 *
 * The borrowed asset is the BaseAsset of the chosen pool. For
 * arb against DEXes that quote in DEEP, borrow the DEEP/USDC or
 * DEEP/SUI pool and return the same `Coin<DEEP>` after the trade.
 */
export interface DeepbookFlashloanConfig {
  provider: 'deepbook';
  /**
   * DeepBookV3 package ID. Mainnet V6 (Jan 2026):
   * 0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497.
   */
  packageId: string;
  /**
   * DeepBookV3 registry ID. Mainnet:
   * 0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d.
   * Currently informational only; the registry's poolKey -> ID lookup
   * is bypassed by passing the pool object directly.
   */
  registryId: string;
  /**
   * Pool object ID for the (BaseAsset, QuoteAsset) pair to borrow from.
   * e.g. DEEP/USDC on mainnet: 0xf948981b806057580f91622417534f491da5f61aeaf33d0ed8e69fd5691c95ce.
   * The DEEP/SUI pool: 0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22.
   * Pass as a shared object to `deepbook::pool::borrow_flashloan_base`.
   */
  borrowPoolId: string;
  /** Base asset coin type of the pool. The asset that gets borrowed. */
  borrowBaseType: string;
  /** Quote asset coin type of the pool. */
  borrowQuoteType: string;
}

export type FlashloanConfig = NaviFlashloanConfig | DeepbookFlashloanConfig;

export function isNaviFlashloan(c: FlashloanConfig): c is NaviFlashloanConfig {
  return c.provider === 'navi';
}

export function isDeepbookFlashloan(c: FlashloanConfig): c is DeepbookFlashloanConfig {
  return c.provider === 'deepbook';
}

export interface DexContractConfig {
  packageId: string;
  swapModule: string;
  swapFn: string;
}

export interface DexContracts {
  cetus: DexContractConfig;
  turbos: DexContractConfig;
  aftermath: DexContractConfig;
}

export interface Config {
  rpcUrl: string;
  privateKey: string;
  pairs: Pair[];
  dexes: ('cetus' | 'turbos' | 'aftermath')[];
  thresholdBps: number;
  maxSubmissions: number;
  pollIntervalMs: number;
  liquidityCapFraction: number;
  /** Estimated gas cost per PTB, in quote units. Used by the detector to compute netSpreadBps. */
  estimatedGasQuote: string;
  /** Flashloan fee in basis points. 9 means 0.09%. Used by the detector to compute netSpreadBps. */
  flashloanFeeBps: number;
  flashloan: FlashloanConfig;
  dexContracts: DexContracts;
}

const VALID_DEXES = ['cetus', 'turbos', 'aftermath'] as const;
const VALID_FLASHLOAN_PROVIDERS = ['navi', 'suilend', 'deepbook'] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load and validate config from the given path. Throws ConfigError on
 * any validation failure. Caller is expected to catch and exit.
 */
export function loadConfig(configPath = 'config.json'): Config {
  const abs = resolve(configPath);
  if (!existsSync(abs)) {
    throw new ConfigError(
      `Config file not found at ${abs}. Copy config.example.json to config.json and fill in the placeholders.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf-8'));
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('Config root must be a JSON object');
  }
  const cfg = raw as Record<string, unknown>;

  // Required scalars
  requireString(cfg, 'rpcUrl');
  requireString(cfg, 'privateKey');

  // Pairs
  if (!Array.isArray(cfg.pairs) || cfg.pairs.length === 0) {
    throw new ConfigError('Config `pairs` must be a non-empty array');
  }
  const pairs: Pair[] = cfg.pairs.map((p, i) => {
    if (typeof p !== 'object' || p === null) {
      throw new ConfigError(`pairs[${i}] must be an object`);
    }
    const pair = p as Record<string, unknown>;
    if (typeof pair.base !== 'string' || typeof pair.quote !== 'string') {
      throw new ConfigError(`pairs[${i}].base and .quote must be strings`);
    }
    return { base: pair.base, quote: pair.quote };
  });

  // DEXes
  if (!Array.isArray(cfg.dexes) || cfg.dexes.length === 0) {
    throw new ConfigError('Config `dexes` must be a non-empty array');
  }
  for (const d of cfg.dexes) {
    if (typeof d !== 'string' || !VALID_DEXES.includes(d as (typeof VALID_DEXES)[number])) {
      throw new ConfigError(`Invalid dex name: ${String(d)}. Must be one of ${VALID_DEXES.join(', ')}`);
    }
  }

  // Numeric
  const thresholdBps = requireNumber(cfg, 'thresholdBps');
  if (thresholdBps < 0) throw new ConfigError('thresholdBps must be >= 0');
  const maxSubmissions = requireNumber(cfg, 'maxSubmissions');
  if (maxSubmissions <= 0 || !Number.isInteger(maxSubmissions)) {
    throw new ConfigError('maxSubmissions must be a positive integer');
  }
  const pollIntervalMs = requireNumber(cfg, 'pollIntervalMs');
  if (pollIntervalMs < 100) {
    throw new ConfigError('pollIntervalMs must be >= 100 (the requirement R1 caps at 1s minimum)');
  }
  const liquidityCapFraction = requireNumber(cfg, 'liquidityCapFraction');
  if (liquidityCapFraction <= 0 || liquidityCapFraction > 1) {
    throw new ConfigError('liquidityCapFraction must be in (0, 1]');
  }
  const estimatedGasQuote = requireString(cfg, 'estimatedGasQuote');
  if (!/^[0-9]+$/.test(estimatedGasQuote)) {
    throw new ConfigError('estimatedGasQuote must be a non-negative integer string (bigint-serializable)');
  }
  const flashloanFeeBps = requireNumber(cfg, 'flashloanFeeBps');
  if (flashloanFeeBps < 0 || flashloanFeeBps > 10000) {
    throw new ConfigError('flashloanFeeBps must be in [0, 10000]');
  }

  // Flashloan
  if (typeof cfg.flashloan !== 'object' || cfg.flashloan === null) {
    throw new ConfigError('Config `flashloan` must be an object');
  }
  const fl = cfg.flashloan as Record<string, unknown>;
  if (typeof fl.provider !== 'string' || !VALID_FLASHLOAN_PROVIDERS.includes(fl.provider as (typeof VALID_FLASHLOAN_PROVIDERS)[number])) {
    throw new ConfigError(`Invalid flashloan.provider: ${String(fl.provider)}`);
  }
  let flashloan: FlashloanConfig;
  if (fl.provider === 'deepbook') {
    flashloan = {
      provider: 'deepbook',
      packageId: requireString(fl, 'packageId'),
      registryId: requireString(fl, 'registryId'),
      borrowPoolId: requireString(fl, 'borrowPoolId'),
      borrowBaseType: requireString(fl, 'borrowBaseType'),
      borrowQuoteType: requireString(fl, 'borrowQuoteType'),
    };
  } else {
    // navi or suilend (same shape as NAVI v2)
    flashloan = {
      provider: fl.provider as 'navi',
      packageId: requireString(fl, 'packageId'),
      configId: requireString(fl, 'configId'),
      storageId: requireString(fl, 'storageId'),
      suiSystemStateId: requireString(fl, 'suiSystemStateId'),
      clockId: requireString(fl, 'clockId'),
      borrowPoolId: requireString(fl, 'borrowPoolId'),
      borrowCoinType: requireString(fl, 'borrowCoinType'),
      borrowFn: requireString(fl, 'borrowFn'),
      repayFn: requireString(fl, 'repayFn'),
    };
  }

  // DEX contracts
  if (typeof cfg.dexContracts !== 'object' || cfg.dexContracts === null) {
    throw new ConfigError('Config `dexContracts` must be an object');
  }
  const dc = cfg.dexContracts as Record<string, unknown>;
  const dexContracts: DexContracts = {
    cetus: requireDexContract(dc, 'cetus'),
    turbos: requireDexContract(dc, 'turbos'),
    aftermath: requireDexContract(dc, 'aftermath'),
  };

  return {
    rpcUrl: cfg.rpcUrl as string,
    privateKey: cfg.privateKey as string,
    pairs,
    dexes: cfg.dexes as Config['dexes'],
    thresholdBps,
    maxSubmissions,
    pollIntervalMs,
    liquidityCapFraction,
    estimatedGasQuote,
    flashloanFeeBps,
    flashloan,
    dexContracts,
  };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ConfigError(`Config \`${key}\` must be a non-empty string`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ConfigError(`Config \`${key}\` must be a finite number`);
  }
  return v;
}

function requireDexContract(obj: Record<string, unknown>, dex: string): DexContractConfig {
  const v = obj[dex];
  if (typeof v !== 'object' || v === null) {
    throw new ConfigError(`Config \`dexContracts.${dex}\` must be an object`);
  }
  const dc = v as Record<string, unknown>;
  return {
    packageId: requireString(dc, 'packageId'),
    swapModule: requireString(dc, 'swapModule'),
    swapFn: requireString(dc, 'swapFn'),
  };
}
