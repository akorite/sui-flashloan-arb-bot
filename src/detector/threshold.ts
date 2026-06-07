/**
 * Threshold gate.
 *
 * Pure function: returns true iff the opportunity's net spread meets or
 * exceeds the configured minimum. No side effects, easy to test.
 */

import type { Opportunity } from './opportunity.js';

export function passesThreshold(opportunity: Opportunity, thresholdBps: number): boolean {
  if (thresholdBps < 0) {
    throw new Error(`thresholdBps must be >= 0, got ${thresholdBps}`);
  }
  return opportunity.netSpreadBps >= thresholdBps;
}
