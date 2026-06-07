/**
 * Structured JSON-line logger.
 *
 * Emits one JSON object per line to stdout. Each line has a stable shape:
 *   { ts, level, event, ...fields }
 *
 * Levels: info, warn, error.
 *
 * Designed for `npm run dev | tee bot.log` style piping. No file rotation,
 * no remote shipping — the operator owns persistence.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEvent =
  | 'startup'
  | 'shutdown'
  | 'config_error'
  | 'poll_cycle'
  | 'opportunity_detected'
  | 'below_threshold'
  | 'liquidity_cap'
  | 'ptb_built'
  | 'ptb_build_error'
  | 'ptb_submitted'
  | 'ptb_success'
  | 'ptb_revert'
  | 'ptb_error'
  | 'cap_reached';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/**
 * Create a logger that prefixes every event with `baseFields`.
 *
 * Output goes to stdout for info/warn and stderr for error. This makes
 * operator-side `2> errors.log` filtering work without extra config.
 */
export function createLogger(baseFields: LogFields = {}): Logger {
  const emit = (level: LogLevel, event: LogEvent, fields?: LogFields): void => {
    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      ...baseFields,
      ...(fields ?? {}),
    };
    const text = JSON.stringify(line) + '\n';
    if (level === 'error') {
      process.stderr.write(text);
    } else {
      process.stdout.write(text);
    }
  };

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (extra) => createLogger({ ...baseFields, ...extra }),
  };
}
