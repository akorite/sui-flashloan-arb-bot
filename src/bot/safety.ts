/**
 * Safety cap.
 *
 * Enforces R8: a misbehaving run cannot exhaust the operator's gas
 * budget before the operator notices. The cap is a per-run counter on
 * PTB submissions; once it reaches zero, the bot process exits.
 *
 * The cap counts attempts, not just successes. A revert still consumed
 * gas, so it counts. The cap is process-local; a fresh process starts
 * fresh, which is the documented v1 behavior.
 */

export class SafetyCap {
  private remaining: number;

  constructor(maxSubmissions: number) {
    if (!Number.isInteger(maxSubmissions) || maxSubmissions <= 0) {
      throw new Error(`SafetyCap requires a positive integer; got ${maxSubmissions}`);
    }
    this.remaining = maxSubmissions;
  }

  canSubmit(): boolean {
    return this.remaining > 0;
  }

  recordAttempt(): void {
    if (this.remaining <= 0) {
      throw new Error('SafetyCap: cannot record attempt after cap reached');
    }
    this.remaining -= 1;
  }

  get remainingCount(): number {
    return this.remaining;
  }
}
