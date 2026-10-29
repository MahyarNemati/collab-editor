import { generateSecret } from './auth.js';

export interface ServerConfig {
  host: string;
  port: number;
  /** HMAC secret for access tokens. */
  authSecret: string;
  /**
   * Whether `GET /api/token` will mint tokens. Convenient for the demo,
   * catastrophic in production — it is an open grant of write access.
   */
  allowTokenEndpoint: boolean;
  /** Directory for the persistence logs, or null for in-memory only. */
  dataDir: string | null;
  /** Directory of built client assets to serve, or null to serve none. */
  staticDir: string | null;
  /** How long an update may sit in the room buffer before it is written. */
  persistFlushIntervalMs: number;
  /** Compact the log once it holds this many frames. */
  compactAfterFrames: number;
  /** Compact the log once it reaches this many bytes. */
  compactAfterBytes: number;
  /** Drop a peer from awareness after this long without an update from it. */
  presenceTimeoutMs: number;
  /** How often the presence sweeper runs. */
  presenceSweepIntervalMs: number;
  /** Inbound frames allowed per second, per connection (token bucket). */
  inboundFramesPerSecond: number;
  /** Burst size of the inbound token bucket. */
  inboundBurst: number;
  /** Above this much buffered on the socket, awareness frames are dropped. */
  awarenessHighWaterMark: number;
  /** Above this much buffered on the socket, the peer is disconnected. */
  maxBufferedBytes: number;
  /** Refuse updates that would take the encoded document past this size. */
  maxDocumentBytes: number;
}

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`expected a number, got ${JSON.stringify(value)}`);
  }
  return parsed;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
};

export const DEFAULTS = {
  persistFlushIntervalMs: 200,
  compactAfterFrames: 64,
  compactAfterBytes: 1024 * 1024,
  presenceTimeoutMs: 30_000,
  presenceSweepIntervalMs: 5_000,
  inboundFramesPerSecond: 200,
  inboundBurst: 400,
  awarenessHighWaterMark: 256 * 1024,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxDocumentBytes: 16 * 1024 * 1024,
} as const;

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const isProduction = env.NODE_ENV === 'production';
  const secret = env.COLLAB_AUTH_SECRET;
  if (isProduction && !secret) {
    throw new Error(
      'COLLAB_AUTH_SECRET must be set when NODE_ENV=production: a generated ' +
        'per-process secret would invalidate every token on restart and ' +
        'cannot be shared between replicas.',
    );
  }
  return {
    host: env.COLLAB_HOST ?? '0.0.0.0',
    port: num(env.COLLAB_PORT, 1234),
    authSecret: secret ?? generateSecret(),
    allowTokenEndpoint: bool(env.COLLAB_ALLOW_TOKEN_ENDPOINT, !isProduction),
    dataDir: env.COLLAB_DATA_DIR ?? 'data',
    staticDir: env.COLLAB_STATIC_DIR ?? null,
    persistFlushIntervalMs: num(
      env.COLLAB_PERSIST_FLUSH_MS,
      DEFAULTS.persistFlushIntervalMs,
    ),
    compactAfterFrames: num(
      env.COLLAB_COMPACT_AFTER_FRAMES,
      DEFAULTS.compactAfterFrames,
    ),
    compactAfterBytes: num(
      env.COLLAB_COMPACT_AFTER_BYTES,
      DEFAULTS.compactAfterBytes,
    ),
    presenceTimeoutMs: num(
      env.COLLAB_PRESENCE_TIMEOUT_MS,
      DEFAULTS.presenceTimeoutMs,
    ),
    presenceSweepIntervalMs: num(
      env.COLLAB_PRESENCE_SWEEP_MS,
      DEFAULTS.presenceSweepIntervalMs,
    ),
    inboundFramesPerSecond: num(
      env.COLLAB_INBOUND_FPS,
      DEFAULTS.inboundFramesPerSecond,
    ),
    inboundBurst: num(env.COLLAB_INBOUND_BURST, DEFAULTS.inboundBurst),
    awarenessHighWaterMark: num(
      env.COLLAB_AWARENESS_HWM,
      DEFAULTS.awarenessHighWaterMark,
    ),
    maxBufferedBytes: num(
      env.COLLAB_MAX_BUFFERED_BYTES,
      DEFAULTS.maxBufferedBytes,
    ),
    maxDocumentBytes: num(
      env.COLLAB_MAX_DOC_BYTES,
      DEFAULTS.maxDocumentBytes,
    ),
  };
}
