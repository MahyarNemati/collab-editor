import { describe, expect, it } from 'vitest';
import {
  Connection,
  type ConnectionLimits,
  type Transport,
} from '../../src/server/connection.js';
import {
  ErrorCode,
  MessageType,
  decodeMessage,
} from '../../src/protocol/index.js';

/** A socket whose buffer we control, which is what makes backpressure testable. */
class FakeTransport implements Transport {
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  send(data: Uint8Array): void {
    this.sent.push(data);
    // A real socket drains asynchronously; here it never does unless the test
    // says so, which is exactly the slow-consumer condition.
    this.bufferedAmount += data.byteLength;
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
}

const limits = (overrides: Partial<ConnectionLimits> = {}): ConnectionLimits => ({
  inboundFramesPerSecond: 100,
  inboundBurst: 10,
  awarenessHighWaterMark: 1_000,
  maxBufferedBytes: 4_000,
  ...overrides,
});

describe('inbound rate limiting', () => {
  it('allows a burst then refuses, and refills over time', () => {
    let now = 0;
    const conn = new Connection(1, new FakeTransport(), limits(), () => now);

    for (let i = 0; i < 10; i += 1) {
      expect(conn.allowInbound(), `frame ${i} of the burst`).toBe(true);
    }
    expect(conn.allowInbound()).toBe(false);
    expect(conn.stats.rateLimited).toBe(1);

    // 100 frames/s means 10 frames of credit after 100ms.
    now += 100;
    for (let i = 0; i < 10; i += 1) {
      expect(conn.allowInbound(), `frame ${i} after refill`).toBe(true);
    }
    expect(conn.allowInbound()).toBe(false);
    expect(conn.stats.rateLimited).toBe(2);
  });

  it('never accumulates more credit than the burst size', () => {
    let now = 0;
    const conn = new Connection(1, new FakeTransport(), limits(), () => now);
    now += 60_000; // an hour of idleness would be 100k frames of credit
    let allowed = 0;
    while (conn.allowInbound()) allowed += 1;
    expect(allowed).toBe(10);
  });
});

describe('outbound backpressure', () => {
  it('drops droppable awareness frames once the socket is behind', () => {
    const transport = new FakeTransport();
    const conn = new Connection(1, transport, limits());

    // Fill past the awareness high-water mark but below the hard limit.
    expect(conn.send(new Uint8Array(1_100))).toBe(true);
    expect(transport.bufferedAmount).toBe(1_100);

    expect(conn.send(new Uint8Array(50), { droppable: true })).toBe(false);
    expect(conn.stats.awarenessDropped).toBe(1);
    expect(transport.sent).toHaveLength(1);

    // Document updates are not droppable and still go out.
    expect(conn.send(new Uint8Array(50))).toBe(true);
    expect(transport.sent).toHaveLength(2);
  });

  it('resumes sending awareness once the socket drains', () => {
    const transport = new FakeTransport();
    const conn = new Connection(1, transport, limits());
    conn.send(new Uint8Array(1_100));
    expect(conn.send(new Uint8Array(10), { droppable: true })).toBe(false);

    transport.bufferedAmount = 0; // the kernel caught up
    expect(conn.send(new Uint8Array(10), { droppable: true })).toBe(true);
    expect(conn.stats.awarenessDropped).toBe(1);
  });

  it('disconnects a peer whose buffer passes the hard limit', () => {
    const transport = new FakeTransport();
    const conn = new Connection(7, transport, limits());

    conn.send(new Uint8Array(3_900));
    expect(conn.isClosed).toBe(false);

    expect(conn.send(new Uint8Array(200))).toBe(false);
    expect(conn.isClosed).toBe(true);
    expect(transport.closedWith?.code).toBe(4009);

    // The peer is told why: the last frame written is an Error frame, not the
    // payload that tipped it over.
    const last = transport.sent.at(-1);
    expect(last).toBeDefined();
    const decoded = decodeMessage(last as Uint8Array);
    expect(decoded.type).toBe(MessageType.Error);
    if (decoded.type === MessageType.Error) {
      expect(decoded.code).toBe(4009);
      expect(decoded.message).toContain('slow consumer');
    }
  });

  it('sends nothing more after close', () => {
    const transport = new FakeTransport();
    const conn = new Connection(1, transport, limits());
    conn.close(1000, 'bye');
    expect(conn.send(new Uint8Array(10))).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it('reports a protocol error before closing', () => {
    const transport = new FakeTransport();
    const conn = new Connection(1, transport, limits());
    conn.fail(ErrorCode.Forbidden, 'read-only token');

    const decoded = decodeMessage(transport.sent[0] as Uint8Array);
    expect(decoded.type).toBe(MessageType.Error);
    if (decoded.type === MessageType.Error) {
      expect(decoded.code).toBe(ErrorCode.Forbidden);
      expect(decoded.message).toBe('read-only token');
    }
    expect(transport.closedWith?.code).toBe(ErrorCode.Forbidden);
  });
});
