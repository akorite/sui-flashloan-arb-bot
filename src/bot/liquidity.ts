/**
 * Liquidity cap.
 *
 * Enforces R6: never submit a PTB whose swap size exceeds the
 * available liquidity of either target pool. The detector picks the
 * size that maximizes the spread, but it operates against pool
 * snapshots; the loop applies a second, more conservative check before
 * submission.
 *
 * The default fraction is 0.5 — the size cannot exceed 50% of the
 * shallower pool's reserves — operator-tunable via config.
 */

import type { Opportunity } from '../detector/opportunity.js';
import { min } from '../util/bigint.js';

export function liquidityOk(opportunity: Opportunity, capFraction: number): boolean {
  if (capFraction <= 0 || capFraction > 1) {
    throw new Error(`liquidityCapFraction must be in (0, 1]; got ${capFraction}`);
  }
  const buyCap = (opportunity.states.buy.reserveQuote * BigInt(Math.floor(capFraction * 1_000_000))) / 1_000_000n;
  const sellCap = (opportunity.states.sell.reserveBase * BigInt(Math.floor(capFraction * 1_000_000))) / 1_000_000n;
  const cap = min(buyCap, sellCap);
  return opportunity.sizeIn <= cap;
}
