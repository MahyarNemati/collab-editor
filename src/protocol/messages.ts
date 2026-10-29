import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { LIMITS } from './limits.js';

/**
 * Wire format.
 *
 * Every frame is `[varuint type][payload]`. The payload shape depends on the
 * type and is documented on each variant below. We write our own envelope
 * rather than reusing `y-websocket`'s so that auth, errors and server-side
 * limits are first-class messages instead of out-of-band conventions — and so
 * the framing is something this repository can actually test.
 *
 * The CRDT algorithm itself is *not* reimplemented: SYNC_STEP1/2 and UPDATE
 * carry payloads produced by `y-protocols/sync`, and AWARENESS carries
 * payloads produced by `y-protocols/awareness`. Reinventing those would be a
 * worse project, not a better one.
 */
export const MessageType = {
  /** client->server, first frame. payload: `varstring token` */
  Auth: 0,
  /** server->client. payload: `varstring json({ docId, userId, role })` */
  AuthOk: 1,
  /** both directions. payload: Yjs state vector */
  SyncStep1: 2,
  /** both directions. payload: Yjs update answering a SyncStep1 */
  SyncStep2: 3,
  /** both directions. payload: Yjs update */
  Update: 4,
  /** both directions. payload: awareness update */
  Awareness: 5,
  /** server->client. payload: `varuint code``varstring message` */
  Error: 6,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const ErrorCode = {
  Unauthorized: 4401,
  Forbidden: 4403,
  BadRequest: 4400,
  PayloadTooLarge: 4413,
  RateLimited: 4429,
  DocumentFull: 4507,
  SlowConsumer: 4009,
  InternalError: 4500,
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type Role = 'read' | 'write';

export interface AuthOkPayload {
  docId: string;
  userId: string;
  role: Role;
}

export type Message =
  | { type: typeof MessageType.Auth; token: string }
  | { type: typeof MessageType.AuthOk; session: AuthOkPayload }
  | { type: typeof MessageType.SyncStep1; stateVector: Uint8Array }
  | { type: typeof MessageType.SyncStep2; update: Uint8Array }
  | { type: typeof MessageType.Update; update: Uint8Array }
  | { type: typeof MessageType.Awareness; update: Uint8Array }
  | { type: typeof MessageType.Error; code: number; message: string };

export class ProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function encodeWith(fn: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder();
  fn(enc);
  return encoding.toUint8Array(enc);
}

export function encodeMessage(msg: Message): Uint8Array {
  return encodeWith((enc) => {
    encoding.writeVarUint(enc, msg.type);
    switch (msg.type) {
      case MessageType.Auth:
        encoding.writeVarString(enc, msg.token);
        return;
      case MessageType.AuthOk:
        encoding.writeVarString(enc, JSON.stringify(msg.session));
        return;
      case MessageType.SyncStep1:
        encoding.writeVarUint8Array(enc, msg.stateVector);
        return;
      case MessageType.SyncStep2:
      case MessageType.Update:
      case MessageType.Awareness:
        encoding.writeVarUint8Array(enc, msg.update);
        return;
      case MessageType.Error:
        encoding.writeVarUint(enc, msg.code);
        encoding.writeVarString(enc, msg.message);
        return;
    }
  });
}

/**
 * Decode one frame. Throws {@link ProtocolError} on anything malformed,
 * truncated, oversized or unknown — the caller is expected to answer with an
 * Error frame and close, never to guess.
 */
export function decodeMessage(data: Uint8Array): Message {
  if (data.byteLength === 0) {
    throw new ProtocolError(ErrorCode.BadRequest, 'empty frame');
  }
  if (data.byteLength > LIMITS.maxFrameBytes) {
    throw new ProtocolError(
      ErrorCode.PayloadTooLarge,
      `frame of ${data.byteLength}B exceeds limit of ${LIMITS.maxFrameBytes}B`,
    );
  }
  const dec = decoding.createDecoder(data);
  let type: number;
  try {
    type = decoding.readVarUint(dec);
  } catch {
    throw new ProtocolError(ErrorCode.BadRequest, 'frame has no message type');
  }

  try {
    switch (type) {
      case MessageType.Auth: {
        const token = decoding.readVarString(dec);
        if (token.length > LIMITS.maxTokenBytes) {
          throw new ProtocolError(ErrorCode.PayloadTooLarge, 'token too large');
        }
        return { type: MessageType.Auth, token };
      }
      case MessageType.AuthOk: {
        const session = JSON.parse(decoding.readVarString(dec)) as AuthOkPayload;
        return { type: MessageType.AuthOk, session };
      }
      case MessageType.SyncStep1:
        return {
          type: MessageType.SyncStep1,
          stateVector: decoding.readVarUint8Array(dec),
        };
      case MessageType.SyncStep2: {
        const update = readBounded(dec, LIMITS.maxUpdateBytes, 'update');
        return { type: MessageType.SyncStep2, update };
      }
      case MessageType.Update: {
        const update = readBounded(dec, LIMITS.maxUpdateBytes, 'update');
        return { type: MessageType.Update, update };
      }
      case MessageType.Awareness: {
        const update = readBounded(dec, LIMITS.maxAwarenessBytes, 'awareness');
        return { type: MessageType.Awareness, update };
      }
      case MessageType.Error: {
        const code = decoding.readVarUint(dec);
        const message = decoding.readVarString(dec);
        return { type: MessageType.Error, code, message };
      }
      default:
        throw new ProtocolError(
          ErrorCode.BadRequest,
          `unknown message type ${type}`,
        );
    }
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError(
      ErrorCode.BadRequest,
      `malformed frame for type ${type}: ${(err as Error).message}`,
    );
  }
}

function readBounded(
  dec: decoding.Decoder,
  max: number,
  what: string,
): Uint8Array {
  const bytes = decoding.readVarUint8Array(dec);
  if (bytes.byteLength > max) {
    throw new ProtocolError(
      ErrorCode.PayloadTooLarge,
      `${what} of ${bytes.byteLength}B exceeds limit of ${max}B`,
    );
  }
  return bytes;
}

export const encodeAuth = (token: string): Uint8Array =>
  encodeMessage({ type: MessageType.Auth, token });
export const encodeSyncStep1 = (stateVector: Uint8Array): Uint8Array =>
  encodeMessage({ type: MessageType.SyncStep1, stateVector });
export const encodeSyncStep2 = (update: Uint8Array): Uint8Array =>
  encodeMessage({ type: MessageType.SyncStep2, update });
export const encodeUpdate = (update: Uint8Array): Uint8Array =>
  encodeMessage({ type: MessageType.Update, update });
export const encodeAwareness = (update: Uint8Array): Uint8Array =>
  encodeMessage({ type: MessageType.Awareness, update });
export const encodeError = (code: number, message: string): Uint8Array =>
  encodeMessage({ type: MessageType.Error, code, message });
