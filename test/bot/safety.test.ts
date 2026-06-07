import { describe, it, expect } from 'vitest';
import { SafetyCap } from '../../src/bot/safety.js';

describe('SafetyCap', () => {
  it('starts with the configured max', () => {
    const cap = new SafetyCap(5);
    expect(cap.remainingCount).toBe(5);
    expect(cap.canSubmit()).toBe(true);
  });

  it('rejects construction with non-positive max', () => {
    expect(() => new SafetyCap(0)).toThrow();
    expect(() => new SafetyCap(-1)).toThrow();
    expect(() => new SafetyCap(2.5)).toThrow();
  });

  it('decrements on recordAttempt and refuses when exhausted', () => {
    const cap = new SafetyCap(2);
    cap.recordAttempt();
    expect(cap.remainingCount).toBe(1);
    expect(cap.canSubmit()).toBe(true);
    cap.recordAttempt();
    expect(cap.remainingCount).toBe(0);
    expect(cap.canSubmit()).toBe(false);
  });

  it('refuses to record past the cap', () => {
    const cap = new SafetyCap(1);
    cap.recordAttempt();
    expect(() => cap.recordAttempt()).toThrow();
  });
});
