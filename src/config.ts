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
  packageId: string;
  moduleName: string;
  borrowFn: string;
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
    moduleName: requireString(fl, 'moduleName'),
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
