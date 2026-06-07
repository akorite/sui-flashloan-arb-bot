/**
 * Process entry point. Loads config, builds the logger, and hands off
 * to the bot loop.
 *
 * This file is intentionally thin — all the bot logic lives in src/bot/.
 * Keeping the entry point minimal makes it easy to inspect and reason
 * about what runs at startup.
 */

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { runBot } from './bot/loop.js';

async function main(): Promise<void> {
  const logger = createLogger({ component: 'main' });
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error('config_error', { message: (err as Error).message });
    process.exit(1);
  }

  logger.info('startup', {
    rpcUrl: config.rpcUrl,
    pairCount: config.pairs.length,
    dexCount: config.dexes.length,
    thresholdBps: config.thresholdBps,
    maxSubmissions: config.maxSubmissions,
    pollIntervalMs: config.pollIntervalMs,
  });

  installSignalHandlers(logger);

  try {
    await runBot(config, logger);
  } catch (err) {
    logger.error('shutdown', { reason: 'unhandled_error', message: (err as Error).message });
    process.exit(1);
  }
  logger.info('shutdown', { reason: 'loop_returned' });
}

function installSignalHandlers(logger: ReturnType<typeof createLogger>): void {
  const handler = (sig: NodeJS.Signals) => {
    logger.info('shutdown', { reason: 'signal', signal: sig });
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

main();
