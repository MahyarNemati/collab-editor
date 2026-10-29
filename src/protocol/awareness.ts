import * as decoding from 'lib0/decoding';
import { ErrorCode, ProtocolError } from './messages.js';

/**
 * Read the client ids addressed by a `y-protocols/awareness` update without
 * applying it.
 *
 * The awareness wire format is `varuint count` followed by `count` records of
 * `varuint clientId, varuint clock, varstring state`. We need the ids *before*
 * applying, because the ownership check — a connection may not move another
 * connection's cursor — has to reject the frame rather than undo it.
 */
export function decodeAwarenessClientIds(update: Uint8Array): number[] {
  const dec = decoding.createDecoder(update);
  try {
    const count = decoding.readVarUint(dec);
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(decoding.readVarUint(dec));
      decoding.readVarUint(dec); // clock
      decoding.readVarString(dec); // state json
    }
    if (decoding.hasContent(dec)) {
      throw new ProtocolError(
        ErrorCode.BadRequest,
        'awareness update has trailing bytes',
      );
    }
    return ids;
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError(
      ErrorCode.BadRequest,
      `malformed awareness update: ${(err as Error).message}`,
    );
  }
}
