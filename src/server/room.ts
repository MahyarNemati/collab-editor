import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { ErrorCode, encodeAwareness, encodeUpdate } from '../protocol/messages.js';
import { decodeAwarenessClientIds } from '../protocol/awareness.js';
import type { Connection } from './connection.js';
import type { DocumentStore } from './store/index.js';

export interface RoomOptions {
  persistFlushIntervalMs: number;
  presenceTimeoutMs: number;
  presenceSweepIntervalMs: number;
  maxDocumentBytes: number;
  maxAwarenessClientsPerConnection: number;
}

export const ROOM_DEFAULTS = {
  maxAwarenessClientsPerConnection: 4,
} as const;

export type ApplyResult =
  | { ok: true }
  | { ok: false; code: number; message: string };

/** Origin tag used when replaying persisted updates, so we do not re-persist. */
const STORE_ORIGIN = Symbol('store');

/**
 * One document and everybody currently editing it.
 *
 * The room owns the authoritative `Y.Doc`, the ephemeral awareness state, and
 * the write path to the store. The division is the important part:
 *
 *   - document updates are broadcast **and** persisted;
 *   - awareness updates are broadcast and **never** persisted.
 *
 * Persisting presence is a tempting shortcut — it is just another update
 * stream — and it is wrong: presence describes a live connection, so a stored
 * cursor is a cursor belonging to somebody who left, and it reappears on every
 * load as a ghost. Expiry is here for the same reason: a peer whose process
 * was killed never sends a removal, so the room has to notice the silence.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly peers = new Set<Connection>();

  /**
   * Running total of accepted update bytes. Deliberately an over-estimate of
   * the document's real size (deletions add bytes here too), which is the safe
   * direction for a quota: it can refuse a write slightly early, never late.
   */
  private appliedBytes = 0;
  private pending: Uint8Array[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> = Promise.resolve();
  private closing = false;
  private destroyed = false;

  private constructor(
    readonly docId: string,
    private readonly store: DocumentStore,
    private readonly options: RoomOptions,
  ) {
    this.awareness = new Awareness(this.doc);
    // The server is a relay, not a participant: it must not appear as a peer
    // with a cursor of its own.
    this.awareness.setLocalState(null);

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === STORE_ORIGIN) return;
      this.broadcastUpdate(update, origin);
      this.pending.push(update);
      this.scheduleFlush();
    });

    this.awareness.on(
      'update',
      (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [
          ...changes.added,
          ...changes.updated,
          ...changes.removed,
        ];
        if (changed.length === 0) return;
        const frame = encodeAwareness(
          encodeAwarenessUpdate(this.awareness, changed),
        );
        for (const peer of this.peers) {
          if (peer === origin) continue;
          peer.send(frame, { droppable: true });
        }
      },
    );
  }

  static async open(
    docId: string,
    store: DocumentStore,
    options: RoomOptions,
  ): Promise<Room> {
    const room = new Room(docId, store, options);
    const frames = await store.load(docId);
    if (frames.length > 0) {
      // One transaction so observers see a single load, not a replay.
      room.doc.transact(() => {
        for (const frame of frames) {
          Y.applyUpdate(room.doc, frame, STORE_ORIGIN);
        }
      }, STORE_ORIGIN);
      room.appliedBytes = frames.reduce((sum, f) => sum + f.byteLength, 0);
    }
    room.startPresenceSweeper();
    return room;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get documentBytes(): number {
    return this.appliedBytes;
  }

  addPeer(conn: Connection): void {
    this.peers.add(conn);
  }

  removePeer(conn: Connection): void {
    this.peers.delete(conn);
    if (conn.awarenessClients.size > 0) {
      removeAwarenessStates(this.awareness, [...conn.awarenessClients], 'peer-left');
      conn.awarenessClients.clear();
    }
  }

  /** Yjs state vector, for answering a peer's SYNC_STEP1. */
  stateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /** The diff a peer is missing, given the state vector it sent us. */
  diffSince(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  /** Full awareness snapshot, for a peer that has just joined. */
  awarenessSnapshot(): Uint8Array | null {
    const clients = [...this.awareness.getStates().keys()];
    if (clients.length === 0) return null;
    return encodeAwarenessUpdate(this.awareness, clients);
  }

  applyDocumentUpdate(update: Uint8Array, origin: Connection): ApplyResult {
    if (this.destroyed || this.closing) {
      return { ok: false, code: ErrorCode.InternalError, message: 'room closed' };
    }
    // A CRDT update is opaque: the server cannot judge what it *means*. What it
    // can do is refuse bytes that are not a well-formed update at all, and
    // refuse writes that would push the document past its quota. See README
    // "Authorisation and the opaque-update problem".
    try {
      Y.decodeUpdate(update);
    } catch (err) {
      return {
        ok: false,
        code: ErrorCode.BadRequest,
        message: `not a decodable Yjs update: ${(err as Error).message}`,
      };
    }

    if (this.appliedBytes + update.byteLength > this.options.maxDocumentBytes) {
      return {
        ok: false,
        code: ErrorCode.DocumentFull,
        message: `document quota of ${this.options.maxDocumentBytes}B reached`,
      };
    }

    try {
      Y.applyUpdate(this.doc, update, origin);
    } catch (err) {
      return {
        ok: false,
        code: ErrorCode.BadRequest,
        message: `update rejected by Yjs: ${(err as Error).message}`,
      };
    }
    this.appliedBytes += update.byteLength;
    return { ok: true };
  }

  applyAwarenessUpdate(update: Uint8Array, origin: Connection): ApplyResult {
    let ids: number[];
    try {
      ids = decodeAwarenessClientIds(update);
    } catch (err) {
      return {
        ok: false,
        code: ErrorCode.BadRequest,
        message: (err as Error).message,
      };
    }

    for (const id of ids) {
      if (conflictsWithAnotherPeer(this.peers, origin, id)) {
        return {
          ok: false,
          code: ErrorCode.Forbidden,
          message: `client id ${id} belongs to another connection`,
        };
      }
    }
    const claimed = new Set([...origin.awarenessClients, ...ids]);
    if (claimed.size > this.options.maxAwarenessClientsPerConnection) {
      return {
        ok: false,
        code: ErrorCode.Forbidden,
        message: `a connection may claim at most ${this.options.maxAwarenessClientsPerConnection} awareness client ids`,
      };
    }

    for (const id of ids) origin.awarenessClients.add(id);
    applyAwarenessUpdate(this.awareness, update, origin);
    return { ok: true };
  }

  private broadcastUpdate(update: Uint8Array, origin: unknown): void {
    const frame = encodeUpdate(update);
    for (const peer of this.peers) {
      if (peer === origin) continue;
      peer.send(frame);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.destroyed || this.closing) return;
    if (this.options.persistFlushIntervalMs <= 0) {
      void this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.options.persistFlushIntervalMs);
    this.flushTimer.unref?.();
  }

  /**
   * Write buffered updates as one merged frame.
   *
   * Coalescing matters: a burst of keystrokes is dozens of tiny updates, and
   * one merged append is both fewer syscalls and fewer log frames to compact
   * later.
   */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.pending;
    if (batch.length === 0) {
      await this.flushInFlight;
      return;
    }
    this.pending = [];
    const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    this.flushInFlight = this.flushInFlight
      .catch(() => undefined)
      .then(() => this.store.append(this.docId, merged));
    await this.flushInFlight;
  }

  private startPresenceSweeper(): void {
    if (this.options.presenceSweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      this.sweepPresence();
    }, this.options.presenceSweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Drop peers that have stopped reporting.
   *
   * A clean disconnect removes presence via {@link Room.removePeer}; this is
   * for the unclean ones — a killed tab, a dropped mobile radio — where the
   * socket stays half-open and nobody ever says goodbye.
   */
  sweepPresence(now: number = Date.now()): number[] {
    const stale: number[] = [];
    for (const [clientId, meta] of this.awareness.meta) {
      if (clientId === this.doc.clientID) continue;
      if (!this.awareness.getStates().has(clientId)) continue;
      if (now - meta.lastUpdated >= this.options.presenceTimeoutMs) {
        stale.push(clientId);
      }
    }
    if (stale.length > 0) {
      removeAwarenessStates(this.awareness, stale, 'presence-timeout');
      for (const peer of this.peers) {
        for (const id of stale) peer.awarenessClients.delete(id);
      }
    }
    return stale;
  }

  async close(): Promise<void> {
    if (this.destroyed || this.closing) return;
    // `closing` rather than `destroyed`: it stops new work being scheduled
    // while still allowing the final flush to run.
    this.closing = true;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    await this.flush();
    this.destroyed = true;
    this.awareness.destroy();
    this.doc.destroy();
  }
}

function conflictsWithAnotherPeer(
  peers: Iterable<Connection>,
  origin: Connection,
  clientId: number,
): boolean {
  for (const peer of peers) {
    if (peer !== origin && peer.awarenessClients.has(clientId)) return true;
  }
  return false;
}
