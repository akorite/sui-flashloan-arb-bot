/**
 * Factory: build the configured set of DexClient instances from config.
 *
 * The factory wires a default `fetchStateImpl` that returns `null` for
 * every pair — production callers replace this with an RPC-backed
 * implementation. The default is intentional: the unit tests verify
 * behavior with synthetic state and do not need a real RPC.
 */

import type { Config } from '../config.js';
import { CetusClient } from './cetus.js';
import { TurbosClient } from './turbos.js';
import { AftermathClient } from './aftermath.js';
import type { DexClient, Pair, PoolState } from './types.js';

export type DexClientMap = Partial<Record<'cetus' | 'turbos' | 'aftermath', DexClient>>;

export interface BuildDexClientsOptions {
  fetchState?: (dex: DexClient['name'], pair: Pair) => Promise<PoolState | null>;
}

const neverFound: (dex: DexClient['name'], pair: Pair) => Promise<PoolState | null> =
  async () => null;

export function buildDexClients(
  config: Config,
  opts: BuildDexClientsOptions = {}
): DexClientMap {
  const fetchState = opts.fetchState ?? neverFound;

  const out: DexClientMap = {};
  for (const dex of config.dexes) {
    switch (dex) {
      case 'cetus':
        out.cetus = new CetusClient(config.dexContracts.cetus, (pair) => fetchState('cetus', pair));
        break;
      case 'turbos':
        out.turbos = new TurbosClient(config.dexContracts.turbos, (pair) => fetchState('turbos', pair));
        break;
      case 'aftermath':
        out.aftermath = new AftermathClient(
          config.dexContracts.aftermath,
          (pair) => fetchState('aftermath', pair)
        );
        break;
    }
  }
  return out;
}
