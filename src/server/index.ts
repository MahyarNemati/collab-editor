#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './config.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';

const logger = createLogger();

/**
 * Serve the built client when it exists.
 *
 * In development the client is served by Vite on its own port and this stays
 * null; in the container the build output sits next to the compiled server, so
 * one process serves both and there is nothing to configure.
 */
function findStaticDir(): string | null {
  if (process.env.COLLAB_STATIC_DIR) return process.env.COLLAB_STATIC_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, '../client'),
    resolve(here, '../../dist/client'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  const base = configFromEnv();
  const server = await startServer({ ...base, staticDir: findStaticDir() }, { logger });

  if (base.allowTokenEndpoint) {
    logger.warn(
      'token endpoint is enabled: anyone who can reach this server can mint a write token',
      { hint: 'set COLLAB_ALLOW_TOKEN_ENDPOINT=0 in production' },
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // Rooms flush their buffered updates during close, so an in-flight edit
    // made milliseconds before SIGTERM still reaches the log.
    void server
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error('shutdown failed', { err: String(err) });
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.error('failed to start', { err: String(err) });
  process.exitCode = 1;
});
