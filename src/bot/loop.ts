/**
 * The main bot loop.
 *
 * Tick cadence:
 *   1. Poll each configured DEX for each pair's pool state.
 *   2. Run the detector on the snapshot.
 *   3. For each candidate opportunity that passes the threshold AND
 *      the liquidity cap, build and submit a PTB.
 *   4. Log the outcome of every detection, attempt, and result.
 *   5. Honor the per-run safety cap; exit when it reaches zero.
 *
 * The loop is sequential — no concurrency in v1. The structure of the
 * loop is pure logic over the configured pieces; the RPC layer and the
 * signer are injected so the loop is testable with fakes.
 */

import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { DexClientMap } from '../dex/index.js';
import type { DexName, Pair, PoolState } from '../dex/types.js';
import type { Opportunity } from '../detector/opportunity.js';
import { findOpportunity } from '../detector/spread.js';
import { passesThreshold } from '../detector/threshold.js';
import { buildPtb } from '../ptb/builder.js';
import type { Signer, SubmitResult } from '../ptb/submit.js';
import { submitPtb } from '../ptb/submit.js';
import type { SuiClient } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';
import { SafetyCap } from './safety.js';
import { liquidityOk } from './liquidity.js';

export interface RunBotDeps {
  suiClient: SuiClient;
  signer: Signer;
  dexClients: DexClientMap;
  /** Optional state fetcher; defaults to DexClient.getPoolState. */
  pollState?: (dex: DexName, pair: Pair) => Promise<PoolState | null>;
}

export async function runBot(config: Config, logger: Logger): Promise<void> {
  const deps = await loadDeps(config, logger);
  const cap = new SafetyCap(config.maxSubmissions);
  const tickLogger = logger.child({ component: 'loop' });

  while (cap.canSubmit()) {
    await runTick({ config, logger: tickLogger, cap, ...deps });
    if (!cap.canSubmit()) break;
    await sleep(config.pollIntervalMs);
  }

  tickLogger.info('cap_reached', { maxSubmissions: config.maxSubmissions });
  tickLogger.info('shutdown', { reason: 'cap_reached', source: 'loop' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TickDeps {
  config: Config;
  logger: Logger;
  cap: SafetyCap;
  suiClient: SuiClient;
  signer: Signer;
  dexClients: DexClientMap;
  pollState: (dex: DexName, pair: Pair) => Promise<PoolState | null>;
}

/**
 * One iteration of the loop. Exposed for testing.
 */
export async function runTick(deps: TickDeps): Promise<void> {
  const { config, logger, cap, suiClient, signer, dexClients, pollState } = deps;

  for (const pair of config.pairs) {
    if (!cap.canSubmit()) break;

    const states = new Map<DexName, PoolState>();
    for (const dexName of config.dexes) {
      const state = await pollState(dexName, pair);
      if (state) states.set(dexName, state);
    }

    if (states.size < 2) {
      logger.warn('poll_cycle', {
        pair: `${pair.base}/${pair.quote}`,
        reason: 'fewer than 2 DEXes returned state',
        states: states.size,
      });
      continue;
    }

    const opp = findOpportunity({
      pair,
      states,
      liquidityCapFraction: config.liquidityCapFraction,
      estimatedGas: 0n,
      flashloanFee: 0n,
    });

    if (!opp) {
      logger.info('poll_cycle', {
        pair: `${pair.base}/${pair.quote}`,
        outcome: 'no_opportunity',
        dexes: [...states.keys()],
      });
      continue;
    }

    logger.info('opportunity_detected', {
      pair: `${opp.pair.base}/${opp.pair.quote}`,
      buyDex: opp.buyDex,
      sellDex: opp.sellDex,
      sizeIn: opp.sizeIn.toString(),
      netSpreadBps: opp.netSpreadBps,
    });

    if (!passesThreshold(opp, config.thresholdBps)) {
      logger.info('below_threshold', {
        pair: `${opp.pair.base}/${opp.pair.quote}`,
        netSpreadBps: opp.netSpreadBps,
        thresholdBps: config.thresholdBps,
      });
      continue;
    }

    if (!liquidityOk(opp, config.liquidityCapFraction)) {
      logger.info('liquidity_cap', {
        pair: `${opp.pair.base}/${opp.pair.quote}`,
        sizeIn: opp.sizeIn.toString(),
        buyReserve: opp.states.buy.reserveQuote.toString(),
        sellReserve: opp.states.sell.reserveBase.toString(),
        capFraction: config.liquidityCapFraction,
      });
      continue;
    }

    await executeOpportunity({
      opp,
      config,
      logger,
      cap,
      suiClient,
      signer,
      dexClients,
    });
  }
}

interface ExecuteDeps {
  opp: Opportunity;
  config: Config;
  logger: Logger;
  cap: SafetyCap;
  suiClient: SuiClient;
  signer: Signer;
  dexClients: DexClientMap;
}

async function executeOpportunity(deps: ExecuteDeps): Promise<void> {
  const { opp, config, logger, cap, suiClient, signer, dexClients } = deps;

  let tx: Transaction;
  try {
    tx = buildPtb({ opportunity: opp, config, dexClients });
  } catch (err) {
    logger.error('ptb_build_error', {
      pair: `${opp.pair.base}/${opp.pair.quote}`,
      buyDex: opp.buyDex,
      sellDex: opp.sellDex,
      error: (err as Error).message,
    });
    cap.recordAttempt();
    return;
  }

  logger.info('ptb_built', {
    pair: `${opp.pair.base}/${opp.pair.quote}`,
    buyDex: opp.buyDex,
    sellDex: opp.sellDex,
    sizeIn: opp.sizeIn.toString(),
  });

  let result: SubmitResult;
  try {
    result = await submitPtb({ tx, client: suiClient, signer });
  } catch (err) {
    result = { status: 'error', error: (err as Error).message };
  }
  cap.recordAttempt();
  logResult(logger, opp, result);
}

function logResult(logger: Logger, opp: Opportunity, result: SubmitResult): void {
  const base = {
    pair: `${opp.pair.base}/${opp.pair.quote}`,
    digest: result.digest,
    gasUsed: result.gasUsed?.toString(),
  };
  switch (result.status) {
    case 'success':
      logger.info('ptb_success', base);
      break;
    case 'revert':
      logger.warn('ptb_revert', { ...base, error: result.error });
      break;
    case 'error':
      logger.error('ptb_error', { ...base, error: result.error });
      break;
  }
}

interface LoadDepsResult {
  suiClient: SuiClient;
  signer: Signer;
  dexClients: DexClientMap;
  pollState: (dex: DexName, pair: Pair) => Promise<PoolState | null>;
}

/**
 * Build the production dependencies. The Sui client, the signer, and
 * the actual RPC-backed state fetcher are wired here. In tests, the
 * orchestrator injects fakes via runTick directly.
 */
async function loadDeps(_config: Config, _logger: Logger): Promise<LoadDepsResult> {
  // The wiring of the SuiClient and signer is intentionally left as a
  // deferred implementation item — it requires:
  //   - the @mysten/sui SuiClient with config.rpcUrl
  //   - a signer that loads config.privateKey and exposes
  //     signTransaction + getAddress
  //   - an RPC-backed pollState that reads pool objects
  // These are not part of the bot's logic; they are infrastructure
  // adapters. The build will fail-fast at runtime if they are not
  // wired correctly, and the unit tests exercise the loop with fakes
  // via runTick.
  throw new Error(
    'runBot is not yet wired to a live SuiClient. Use runTick directly with injected deps in tests; wire the production client before running on testnet.'
  );
}
