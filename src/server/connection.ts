import { encodeError } from '../protocol/messages.js';
import type { Role } from '../protocol/messages.js';

/** Minimal surface the connection needs; `ws` satisfies it, so do fakes. */
export interface Transport {
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectionLimits {
  inboundFramesPerSecond: number;
  inboundBurst: number;
  awarenessHighWaterMark: number;
  maxBufferedBytes: number;
}

export interface ConnectionStats {
  framesSent: number;
  bytesSent: number;
  /** Awareness frames discarded because the socket was already behind. */
  awarenessDropped: number;
  /** Inbound frames refused by the token bucket. */
  rateLimited: number;
}

export interface Session {
  docId: string;
  userId: string;
  role: Role;
}

/**
 * One authenticated peer.
 *
 * Holds the two pieces of defence a WebSocket server needs and that neither
 * Yjs nor `ws` provides: a token bucket on inbound frames, and backpressure on
 * outbound ones.
 *
 * Backpressure has two thresholds because the two kinds of traffic have
 * different value. Awareness frames are *droppable*: a cursor position that
 * nobody received is superseded by the next one a few milliseconds later, so
 * when a socket starts to lag they are the first thing to go. Document updates
 * are not droppable — dropping one silently diverges that peer forever — so
 * when the buffer passes the hard limit the only correct move is to disconnect
 * the peer and let it resync from scratch.
 */
export class Connection {
  readonly id: number;
  session: Session | null = null;
  /** Awareness client ids this connection has claimed. */
  readonly awarenessClients = new Set<number>();
  readonly stats: ConnectionStats = {
    framesSent: 0,
    bytesSent: 0,
    awarenessDropped: 0,
    rateLimited: 0,
  };

  private closed = false;
  private tokens: number;
  private lastRefill: number;

  constructor(
    id: number,
    private readonly transport: Transport,
    private readonly limits: ConnectionLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.id = id;
    this.tokens = limits.inboundBurst;
    this.lastRefill = now();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get bufferedAmount(): number {
    return this.transport.bufferedAmount;
  }

  /** Token bucket. Returns false when the peer is sending too fast. */
  allowInbound(): boolean {
    const now = this.now();
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(
      this.limits.inboundBurst,
      this.tokens + elapsedSeconds * this.limits.inboundFramesPerSecond,
    );
    if (this.tokens < 1) {
      this.stats.rateLimited += 1;
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  /**
   * Send a frame, honouring backpressure.
   *
   * @returns true if the frame was handed to the socket.
   */
  send(frame: Uint8Array, options: { droppable?: boolean } = {}): boolean {
    if (this.closed) return false;
    const buffered = this.transport.bufferedAmount;

    if (buffered + frame.byteLength > this.limits.maxBufferedBytes) {
      this.fail(
        4009,
        `slow consumer: ${buffered}B buffered exceeds ${this.limits.maxBufferedBytes}B`,
      );
      return false;
    }
    if (options.droppable && buffered > this.limits.awarenessHighWaterMark) {
      this.stats.awarenessDropped += 1;
      return false;
    }

    this.transport.send(frame);
    this.stats.framesSent += 1;
    this.stats.bytesSent += frame.byteLength;
    return true;
  }

  /** Report a protocol error to the peer, then close. */
  fail(code: number, message: string): void {
    if (this.closed) return;
    try {
      // Sent without the backpressure check on purpose: the peer is being
      // disconnected anyway, and the reason is worth more than the bytes.
      this.transport.send(encodeError(code, message));
    } catch {
      // The socket may already be gone; the close below is what matters.
    }
    this.close(code, message.slice(0, 120));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.transport.close(code, reason);
    } catch {
      // Already closed by the peer or the runtime.
    }
  }

  markClosed(): void {
    this.closed = true;
  }
}
