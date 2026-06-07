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

export interface FlashloanConfig {
  provider: 'navi' | 'suilend';
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
const VALID_FLASHLOAN_PROVIDERS = ['navi', 'suilend'] as const;

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
  const flashloan: FlashloanConfig = {
    provider: fl.provider as FlashloanConfig['provider'],
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
