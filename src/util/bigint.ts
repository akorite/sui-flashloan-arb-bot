/**
 * Small bigint helpers used across the bot.
 */

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
