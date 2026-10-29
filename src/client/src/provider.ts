import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  ErrorCode,
  MessageType,
  decodeMessage,
  encodeAuth,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
} from '../../protocol/index.js';

import type { Role } from '../../protocol/messages.js';

export type ConnectionStatus =
  | 'offline'
  | 'connecting'
  | 'authenticating'
  | 'synced'
  | 'error';

export interface ProviderEvents {
  status: { status: ConnectionStatus; detail?: string };
  /** Number of local updates produced since the last successful sync. */
  pending: { count: number };
}

export interface ProviderOptions {
  url: string;
  docId: string;
  token: string;
  doc: Y.Doc;
  awareness: Awareness;
  /** Resend local presence this often, so the server's expiry clock resets. */
  presenceHeartbeatMs?: number;
  maxBackoffMs?: number;
  /** Start disconnected. Used by the demo's "offline" toggle across reloads. */
  startOffline?: boolean;
  WebSocketImpl?: typeof WebSocket;
}

type Listener<K extends keyof ProviderEvents> = (
  payload: ProviderEvents[K],
) => void;

/**
 * WebSocket provider for one Yjs document.
 *
 * There is deliberately **no outbound queue of updates** here, and that is the
 * most interesting thing about this file.
 *
 * The obvious offline-first design is a FIFO of unsent updates, replayed on
 * reconnect. With a CRDT that queue is redundant and strictly worse: the local
 * `Y.Doc` *is* the queue. Every edit made while disconnected is already in it,
 * and on reconnect the two sides exchange state vectors — "here is what I
 * have" — and each sends exactly the delta the other is missing. A replay
 * queue would additionally have to survive a reload, be deduplicated against
 * what the server already saw, and be ordered; the state-vector handshake
 * needs none of that, is idempotent, and costs one round trip regardless of
 * how long the client was away.
 *
 * What *does* need handling is everything around it: reconnect backoff,
 * clearing remote presence when the link drops (otherwise cursors of peers you
 * can no longer see linger), and a presence heartbeat so the server does not
 * expire us while we sit idle.
 */
export class WebSocketProvider {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'offline';
  private offline: boolean;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingLocalUpdates = 0;
  /** Role as reported by the server, not as requested by the client. */
  private role: Role | null = null;
  private destroyed = false;
  private readonly listeners = new Map<string, Set<Listener<never>>>();
  private readonly ws: typeof WebSocket;

  constructor(private readonly options: ProviderOptions) {
    this.ws = options.WebSocketImpl ?? WebSocket;
    this.offline = options.startOffline ?? false;

    this.options.doc.on('update', this.onDocUpdate);
    this.options.awareness.on('update', this.onAwarenessUpdate);

    if (!this.offline) this.connect();
    else this.setStatus('offline');
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  get isOffline(): boolean {
    return this.offline;
  }

  get pendingCount(): number {
    return this.pendingLocalUpdates;
  }

  /**
   * Whether the server has granted write access.
   *
   * A CRDT is always writable *locally* — there is no way to make a `Y.Doc`
   * refuse an edit — so a read-only client has to decline to send rather than
   * decline to edit. Its local changes are real but private, and the editor UI
   * is what marks the document read-only.
   */
  get canWrite(): boolean {
    return this.role !== 'read';
  }

  on<K extends keyof ProviderEvents>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<never>);
    this.listeners.set(event, set);
    return () => set.delete(listener as Listener<never>);
  }

  private emit<K extends keyof ProviderEvents>(
    event: K,
    payload: ProviderEvents[K],
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<K>)(payload);
    }
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.emit('status', detail === undefined ? { status } : { status, detail });
  }

  private setPending(count: number): void {
    this.pendingLocalUpdates = count;
    this.emit('pending', { count });
  }

  /** Simulate losing the network, or come back from it. */
  setOffline(offline: boolean): void {
    if (this.offline === offline) return;
    this.offline = offline;
    if (offline) {
      this.teardownSocket(4000, 'client went offline');
      this.clearRemotePresence();
      this.setStatus('offline');
    } else {
      this.attempt = 0;
      this.connect();
    }
  }

  private connect(): void {
    if (this.destroyed || this.offline) return;
    if (this.socket !== null) return;
    this.setStatus('connecting');

    const socket = new this.ws(this.options.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.setStatus('authenticating');
      this.sendRaw(encodeAuth(this.options.token));
    };
    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      this.handleFrame(new Uint8Array(event.data));
    };
    socket.onerror = () => {
      // `onclose` always follows, and carries the only useful information.
      this.setStatus('error', 'websocket error');
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.role = null;
      this.stopHeartbeat();
      this.clearRemotePresence();
      if (this.destroyed || this.offline) return;
      this.scheduleReconnect(event.reason || `closed with code ${event.code}`);
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer !== null) return;
    this.attempt += 1;
    const max = this.options.maxBackoffMs ?? 10_000;
    // Exponential with full jitter: a server restart otherwise produces a
    // thundering herd of every client reconnecting on the same tick.
    const ceiling = Math.min(max, 250 * 2 ** Math.min(this.attempt, 6));
    const delay = Math.random() * ceiling;
    this.setStatus('connecting', `${reason}; retrying in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleFrame(bytes: Uint8Array): void {
    let message;
    try {
      message = decodeMessage(bytes);
    } catch (err) {
      this.setStatus('error', `undecodable frame: ${(err as Error).message}`);
      return;
    }

    switch (message.type) {
      case MessageType.AuthOk: {
        this.attempt = 0;
        this.role = message.session.role;
        // Symmetric handshake: tell the server what we have, and it will send
        // the difference. Its own SYNC_STEP1 arrives in the same burst.
        this.sendRaw(encodeSyncStep1(Y.encodeStateVector(this.options.doc)));
        this.startHeartbeat();
        this.broadcastLocalPresence();
        return;
      }
      case MessageType.SyncStep1: {
        // Answering with SYNC_STEP2 is a write. A read-only peer must not,
        // and the server does not ask it to.
        if (!this.canWrite) return;
        this.sendRaw(
          encodeSyncStep2(
            Y.encodeStateAsUpdate(this.options.doc, message.stateVector),
          ),
        );
        return;
      }
      case MessageType.SyncStep2: {
        Y.applyUpdate(this.options.doc, message.update, this);
        // Everything we had locally has now been offered to the server, and
        // everything it had has been applied here.
        this.setPending(0);
        this.setStatus('synced');
        return;
      }
      case MessageType.Update: {
        Y.applyUpdate(this.options.doc, message.update, this);
        return;
      }
      case MessageType.Awareness: {
        applyAwarenessUpdate(this.options.awareness, message.update, this);
        return;
      }
      case MessageType.Error: {
        const fatal =
          message.code === ErrorCode.Unauthorized ||
          message.code === ErrorCode.Forbidden;
        this.setStatus('error', `${message.code}: ${message.message}`);
        if (fatal) {
          // Retrying a rejected token just produces the same rejection.
          this.offline = true;
          this.teardownSocket(1000, 'authorisation failed');
        }
        return;
      }
      default:
        return;
    }
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    if (!this.canWrite) return;
    this.setPending(this.pendingLocalUpdates + 1);
    if (this.sendRaw(encodeUpdate(update))) {
      this.setPending(0);
    }
  };

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (changed.length === 0) return;
    this.sendRaw(
      encodeAwareness(encodeAwarenessUpdate(this.options.awareness, changed)),
    );
  };

  private broadcastLocalPresence(): void {
    this.sendRaw(
      encodeAwareness(
        encodeAwarenessUpdate(this.options.awareness, [
          this.options.doc.clientID,
        ]),
      ),
    );
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.presenceHeartbeatMs ?? 10_000;
    this.heartbeatTimer = setInterval(() => {
      // Re-setting the same state bumps the awareness clock, which is what
      // stops the server expiring an idle but present peer.
      const state = this.options.awareness.getLocalState();
      if (state !== null) this.options.awareness.setLocalState(state);
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Forget every peer's cursor.
   *
   * Presence describes who is reachable *now*. Once the socket is gone we know
   * nothing about the other editors, so keeping their carets on screen is a
   * lie that gets worse the longer the disconnection lasts.
   */
  private clearRemotePresence(): void {
    const remote = [...this.options.awareness.getStates().keys()].filter(
      (id) => id !== this.options.doc.clientID,
    );
    if (remote.length > 0) {
      removeAwarenessStates(this.options.awareness, remote, this);
    }
  }

  private sendRaw(frame: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== 1 /* OPEN */) return false;
    try {
      socket.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  private teardownSocket(code: number, reason: string): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(code, reason);
      } catch {
        // Already closing.
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.options.doc.off('update', this.onDocUpdate);
    this.options.awareness.off('update', this.onAwarenessUpdate);
    this.teardownSocket(1000, 'provider destroyed');
  }
}
