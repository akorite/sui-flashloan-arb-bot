import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('logger', () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a parseable JSON line with required fields', () => {
    const logger = createLogger({ component: 'test' });
    logger.info('startup', { foo: 'bar' });

    expect(stdoutWrites).toHaveLength(1);
    const line = stdoutWrites[0]!.trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('startup');
    expect(parsed.component).toBe('test');
    expect(parsed.foo).toBe('bar');
    expect(typeof parsed.ts).toBe('string');
    expect(new Date(parsed.ts as string).toString()).not.toBe('Invalid Date');
  });

  it('routes error level to stderr', () => {
    const logger = createLogger();
    logger.error('ptb_error', { reason: 'slippage' });

    expect(stderrWrites).toHaveLength(1);
    expect(stdoutWrites).toHaveLength(0);
    const parsed = JSON.parse(stderrWrites[0]!.trim()) as Record<string, unknown>;
    expect(parsed.level).toBe('error');
    expect(parsed.event).toBe('ptb_error');
  });

  it('child logger inherits and overrides base fields', () => {
    const root = createLogger({ bot: 'arb' });
    const child = root.child({ tick: 3 });
    child.info('poll_cycle', { pair: 'SUI/USDC' });

    const parsed = JSON.parse(stdoutWrites[0]!.trim()) as Record<string, unknown>;
    expect(parsed.bot).toBe('arb');
    expect(parsed.tick).toBe(3);
    expect(parsed.event).toBe('poll_cycle');
  });
});
