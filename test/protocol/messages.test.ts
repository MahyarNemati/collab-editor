import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ErrorCode,
  LIMITS,
  MessageType,
  ProtocolError,
  decodeAwarenessClientIds,
  decodeMessage,
  encodeAwareness,
  encodeMessage,
  encodeSyncStep1,
  encodeUpdate,
  isValidDocId,
} from '../../src/protocol/index.js';

describe('wire format', () => {
  it('round-trips every message type', () => {
    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'round trip');
    const update = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);

    const cases = [
      { type: MessageType.Auth, token: 'abc.def' },
      {
        type: MessageType.AuthOk,
        session: { docId: 'demo', userId: 'u1', role: 'write' },
      },
      { type: MessageType.SyncStep1, stateVector },
      { type: MessageType.SyncStep2, update },
      { type: MessageType.Update, update },
      { type: MessageType.Awareness, update },
      { type: MessageType.Error, code: ErrorCode.Forbidden, message: 'nope' },
    ] as const;

    for (const message of cases) {
      const decoded = decodeMessage(encodeMessage(message));
      expect(decoded).toEqual(message);
    }
  });

  it('carries an update that still applies to a fresh document', () => {
    const source = new Y.Doc();
    source.getText('body').insert(0, 'payload survives framing');
    const frame = encodeUpdate(Y.encodeStateAsUpdate(source));

    const decoded = decodeMessage(frame);
    expect(decoded.type).toBe(MessageType.Update);
    const target = new Y.Doc();
    if (decoded.type === MessageType.Update) {
      Y.applyUpdate(target, decoded.update);
    }
    expect(target.getText('body').toString()).toBe('payload survives framing');
  });

  it('rejects an empty frame', () => {
    expect(() => decodeMessage(new Uint8Array())).toThrowError(
      /empty frame/,
    );
  });

  it('rejects an unknown message type with a protocol error', () => {
    try {
      decodeMessage(new Uint8Array([200, 1, 2, 3]));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe(ErrorCode.BadRequest);
      expect((err as ProtocolError).message).toContain('unknown message type');
    }
  });

  it('rejects a truncated frame rather than returning a short payload', () => {
    const frame = encodeSyncStep1(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const truncated = frame.subarray(0, frame.byteLength - 4);
    expect(() => decodeMessage(truncated)).toThrowError(/malformed frame/);
  });

  it('rejects an update above the per-update limit', () => {
    const oversized = new Uint8Array(LIMITS.maxUpdateBytes + 1);
    const frame = encodeUpdate(oversized);
    try {
      decodeMessage(frame);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ErrorCode.PayloadTooLarge);
    }
  });

  it('rejects a frame above the overall frame limit', () => {
    const frame = new Uint8Array(LIMITS.maxFrameBytes + 1);
    frame[0] = MessageType.Update;
    try {
      decodeMessage(frame);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ErrorCode.PayloadTooLarge);
    }
  });
});

describe('document ids', () => {
  it('accepts ordinary ids', () => {
    for (const id of ['demo', 'doc-1', 'A_b-9', 'x'.repeat(64)]) {
      expect(isValidDocId(id), id).toBe(true);
    }
  });

  it('rejects anything that could escape the data directory or a filename', () => {
    for (const id of [
      '',
      '.',
      '..',
      '../etc/passwd',
      'a/b',
      'a\\b',
      'a b',
      '-leading-hyphen',
      '_leading-underscore',
      'a'.repeat(65),
      'doc\u0000',
      'doc.ylog',
    ]) {
      expect(isValidDocId(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe('awareness client id extraction', () => {
  it('reads the client ids an awareness update addresses', async () => {
    const { Awareness, encodeAwarenessUpdate } = await import(
      'y-protocols/awareness'
    );
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalStateField('user', { name: 'alice' });
    const update = encodeAwarenessUpdate(awareness, [doc.clientID]);

    expect(decodeAwarenessClientIds(update)).toEqual([doc.clientID]);

    const framed = encodeAwareness(update);
    const decoded = decodeMessage(framed);
    expect(decoded.type).toBe(MessageType.Awareness);
    awareness.destroy();
    doc.destroy();
  });

  it('rejects an awareness payload with trailing garbage', () => {
    const bogus = new Uint8Array([1, 7, 0, 99, 99, 99]);
    expect(() => decodeAwarenessClientIds(bogus)).toThrowError(
      /malformed awareness update|trailing bytes/,
    );
  });
});
