export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Structured logs on stderr, so stdout stays usable for piping. */
export function createLogger(
  level: LogLevel = (process.env.COLLAB_LOG_LEVEL as LogLevel | undefined) ??
    'info',
): Logger {
  const threshold = ORDER[level] ?? ORDER.info;
  const emit =
    (lvl: LogLevel) => (msg: string, fields: Record<string, unknown> = {}) => {
      if (ORDER[lvl] < threshold) return;
      process.stderr.write(
        `${JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields })}\n`,
      );
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
