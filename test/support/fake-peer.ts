import { Connection, type Transport } from '../../src/server/connection.js';
import { decodeMessage, type Message } from '../../src/protocol/index.js';

export class RecordingTransport implements Transport {
  bufferedAmount = 0;
  readonly frames: Uint8Array[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  send(data: Uint8Array): void {
    this.frames.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  messages(): Message[] {
    return this.frames.map((frame) => decodeMessage(frame));
  }

  ofType<T extends Message['type']>(type: T): Extract<Message, { type: T }>[] {
    return this.messages().filter(
      (m): m is Extract<Message, { type: T }> => m.type === type,
    );
  }
}

export interface FakePeer {
  connection: Connection;
  transport: RecordingTransport;
}

let nextId = 1;

export function fakePeer(role: 'read' | 'write' = 'write'): FakePeer {
  const transport = new RecordingTransport();
  const connection = new Connection(nextId++, transport, {
    inboundFramesPerSecond: 1_000,
    inboundBurst: 1_000,
    awarenessHighWaterMark: 1024 * 1024,
    maxBufferedBytes: 8 * 1024 * 1024,
  });
  connection.session = { docId: 'test', userId: `peer-${nextId}`, role };
  return { connection, transport };
}
