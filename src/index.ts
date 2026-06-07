/**
 * Process entry point. Loads config, builds the logger, and hands off
 * to the bot loop.
 *
 * This file is intentionally thin — all the bot logic lives in src/bot/.
 * Keeping the entry point minimal makes it easy to inspect and reason
 * about what runs at startup.
 */

import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { runBot } from './bot/loop.js';

async function main(): Promise<void> {
  const logger = createLogger({ component: 'main' });
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error('config_error', { message: err.message });
    } else {
      logger.error('config_error', { message: (err as Error).message });
    }
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

  try {
    await runBot(config, logger);
  } catch (err) {
    logger.error('shutdown', { message: (err as Error).message });
    process.exit(1);
  }
}

main();
