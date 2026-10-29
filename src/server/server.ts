import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ErrorCode,
  MessageType,
  ProtocolError,
  decodeMessage,
  encodeAwareness,
  encodeMessage,
  encodeSyncStep1,
  encodeSyncStep2,
  isValidDocId,
} from '../protocol/index.js';
import type { Role } from '../protocol/messages.js';
import { signToken, verifyToken, type Claims } from './auth.js';
import { configFromEnv, type ServerConfig } from './config.js';
import { Connection, type Transport } from './connection.js';
import { createLogger, type Logger } from './logger.js';
import { ROOM_DEFAULTS, Room } from './room.js';
import { serveStatic } from './static.js';
import { FileStore } from './store/file.js';
import { MemoryStore } from './store/memory.js';
import type { DocumentStore } from './store/index.js';

export const WS_PATH = '/ws';

/** How long a socket may stay silent before it must have authenticated. */
const AUTH_TIMEOUT_MS = 10_000;

export interface CollabServer {
  readonly config: ServerConfig;
  readonly store: DocumentStore;
  readonly port: number;
  readonly url: string;
  readonly wsUrl: string;
  /** Token for the demo client and for tests. */
  mintToken(claims: Omit<Claims, 'exp'> & { exp?: number }): string;
  room(docId: string): Room | undefined;
  /** Wait until every room has written its buffered updates. */
  flushAll(): Promise<void>;
  snapshot(): ServerSnapshot;
  close(): Promise<void>;
}

export interface ServerSnapshot {
  connections: number;
  rooms: { docId: string; peers: number; documentBytes: number }[];
  awarenessDropped: number;
  rateLimited: number;
  authFailures: number;
  rejectedUpdates: number;
}

export async function startServer(
  overrides: Partial<ServerConfig> = {},
  deps: { logger?: Logger; store?: DocumentStore } = {},
): Promise<CollabServer> {
  const config: ServerConfig = { ...configFromEnv(), ...overrides };
  const logger = deps.logger ?? createLogger();
  const store =
    deps.store ??
    (config.dataDir
      ? new FileStore({
          dataDir: config.dataDir,
          compactAfterFrames: config.compactAfterFrames,
          compactAfterBytes: config.compactAfterBytes,
        })
      : new MemoryStore({
          compactAfterFrames: config.compactAfterFrames,
          compactAfterBytes: config.compactAfterBytes,
        }));

  const rooms = new Map<string, Promise<Room>>();
  /** Rooms whose load has completed, so `/metrics` can read them synchronously. */
  const readyRooms = new Map<string, Room>();
  const closingRooms = new Map<string, Promise<void>>();
  const connections = new Set<Connection>();
  let nextConnectionId = 1;
  const counters = { authFailures: 0, rejectedUpdates: 0 };

  const roomOptions = {
    persistFlushIntervalMs: config.persistFlushIntervalMs,
    presenceTimeoutMs: config.presenceTimeoutMs,
    presenceSweepIntervalMs: config.presenceSweepIntervalMs,
    maxDocumentBytes: config.maxDocumentBytes,
    maxAwarenessClientsPerConnection:
      ROOM_DEFAULTS.maxAwarenessClientsPerConnection,
  };

  async function getRoom(docId: string): Promise<Room> {
    // A room that is mid-close still owes the store a flush. Opening a new one
    // before that lands would read a stale log, so wait it out.
    const closing = closingRooms.get(docId);
    if (closing) await closing;
    let room = rooms.get(docId);
    if (!room) {
      room = Room.open(docId, store, roomOptions);
      rooms.set(docId, room);
      room.then(
        (opened) => readyRooms.set(docId, opened),
        () => rooms.delete(docId),
      );
    }
    return room;
  }

  function releaseRoom(docId: string, room: Room): void {
    if (room.peerCount > 0) return;
    rooms.delete(docId);
    readyRooms.delete(docId);
    const closed = room
      .close()
      .catch((err: unknown) =>
        logger.error('room close failed', { docId, err: String(err) }),
      )
      .finally(() => {
        closingRooms.delete(docId);
      });
    closingRooms.set(docId, closed);
  }

  const http = createServer((req, res) => {
    void handleHttp(req, res);
  });

  async function handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      return json(res, 200, { status: 'ok', rooms: rooms.size, connections: connections.size });
    }
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(renderMetrics(snapshot()));
      return;
    }
    if (url.pathname === '/api/token') {
      return handleTokenRequest(url, res);
    }
    if (config.staticDir && req.method === 'GET') {
      if (await serveStatic(config.staticDir, req, res)) return;
    }
    json(res, 404, { error: 'not found' });
  }

  function handleTokenRequest(url: URL, res: ServerResponse): void {
    if (!config.allowTokenEndpoint) {
      // Minting write tokens for anyone who asks is only acceptable in the
      // demo. In production the surrounding application issues them.
      return json(res, 403, {
        error: 'token endpoint disabled; set COLLAB_ALLOW_TOKEN_ENDPOINT=1 to enable',
      });
    }
    const docId = url.searchParams.get('doc') ?? '';
    const userId = url.searchParams.get('user') ?? '';
    const role = (url.searchParams.get('role') ?? 'write') as Role;
    if (!isValidDocId(docId)) {
      return json(res, 400, { error: 'doc must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}' });
    }
    if (userId.length === 0 || userId.length > 64) {
      return json(res, 400, { error: 'user must be 1-64 characters' });
    }
    if (role !== 'read' && role !== 'write') {
      return json(res, 400, { error: 'role must be "read" or "write"' });
    }
    const exp = Math.floor(Date.now() / 1000) + 3600;
    json(res, 200, { token: signToken(config.authSecret, { doc: docId, sub: userId, role, exp }), exp });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    handleConnection(ws);
  });

  function handleConnection(ws: WebSocket): void {
    const transport: Transport = {
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      send: (data) => ws.send(data, { binary: true }),
      close: (code, reason) => ws.close(code, reason),
    };
    const conn = new Connection(nextConnectionId++, transport, {
      inboundFramesPerSecond: config.inboundFramesPerSecond,
      inboundBurst: config.inboundBurst,
      awarenessHighWaterMark: config.awarenessHighWaterMark,
      maxBufferedBytes: config.maxBufferedBytes,
    });
    connections.add(conn);
    let room: Room | null = null;

    const authTimer = setTimeout(() => {
      if (conn.session === null) {
        counters.authFailures += 1;
        conn.fail(ErrorCode.Unauthorized, 'no auth frame within 10s');
      }
    }, AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      void (async () => {
        if (!isBinary) {
          return conn.fail(ErrorCode.BadRequest, 'only binary frames are accepted');
        }
        if (!conn.allowInbound()) {
          return conn.fail(
            ErrorCode.RateLimited,
            `more than ${config.inboundFramesPerSecond} frames/s`,
          );
        }
        const bytes = toUint8Array(data);
        let message;
        try {
          message = decodeMessage(bytes);
        } catch (err) {
          const pe = err as ProtocolError;
          return conn.fail(pe.code ?? ErrorCode.BadRequest, pe.message);
        }

        if (conn.session === null) {
          if (message.type !== MessageType.Auth) {
            counters.authFailures += 1;
            return conn.fail(ErrorCode.Unauthorized, 'first frame must be AUTH');
          }
          const result = verifyToken(config.authSecret, message.token);
          if (!result.ok) {
            counters.authFailures += 1;
            logger.warn('auth rejected', { conn: conn.id, reason: result.reason });
            return conn.fail(ErrorCode.Unauthorized, result.reason);
          }
          clearTimeout(authTimer);
          const { claims } = result;
          conn.session = { docId: claims.doc, userId: claims.sub, role: claims.role };
          room = await getRoom(claims.doc);
          if (conn.isClosed) {
            releaseRoom(claims.doc, room);
            return;
          }
          room.addPeer(conn);
          conn.send(
            encodeMessage({
              type: MessageType.AuthOk,
              session: { docId: claims.doc, userId: claims.sub, role: claims.role },
            }),
          );
          // Start the sync handshake from our side, but only for writers: our
          // SYNC_STEP1 is a request for the peer's updates, and asking a
          // read-only peer for updates we are then obliged to refuse would be
          // incoherent. A reader drives its own half of the handshake instead.
          if (claims.role === 'write') {
            conn.send(encodeSyncStep1(room.stateVector()));
          }
          const presence = room.awarenessSnapshot();
          if (presence) conn.send(encodeAwareness(presence), { droppable: true });
          logger.info('peer joined', {
            conn: conn.id,
            doc: claims.doc,
            user: claims.sub,
            role: claims.role,
            peers: room.peerCount,
          });
          return;
        }

        const active = room;
        if (active === null) return;

        switch (message.type) {
          case MessageType.SyncStep1:
            conn.send(encodeSyncStep2(active.diffSince(message.stateVector)));
            return;
          case MessageType.SyncStep2:
          case MessageType.Update: {
            if (conn.session.role !== 'write') {
              counters.rejectedUpdates += 1;
              return conn.fail(
                ErrorCode.Forbidden,
                'this token grants read access only',
              );
            }
            const applied = active.applyDocumentUpdate(message.update, conn);
            if (!applied.ok) {
              counters.rejectedUpdates += 1;
              return conn.fail(applied.code, applied.message);
            }
            return;
          }
          case MessageType.Awareness: {
            const applied = active.applyAwarenessUpdate(message.update, conn);
            if (!applied.ok) return conn.fail(applied.code, applied.message);
            return;
          }
          case MessageType.Auth:
            return conn.fail(ErrorCode.BadRequest, 'already authenticated');
          default:
            return conn.fail(
              ErrorCode.BadRequest,
              `unexpected message type ${message.type} from client`,
            );
        }
      })();
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      conn.markClosed();
      connections.delete(conn);
      if (room) {
        room.removePeer(conn);
        logger.info('peer left', { conn: conn.id, doc: conn.session?.docId, peers: room.peerCount });
        releaseRoom(room.docId, room);
      }
    });

    ws.on('error', (err: Error) => {
      logger.warn('socket error', { conn: conn.id, err: err.message });
    });
  }

  function snapshot(): ServerSnapshot {
    let awarenessDropped = 0;
    let rateLimited = 0;
    for (const conn of connections) {
      awarenessDropped += conn.stats.awarenessDropped;
      rateLimited += conn.stats.rateLimited;
    }
    const roomRows: ServerSnapshot['rooms'] = [];
    for (const [docId, room] of readyRooms) {
      roomRows.push({
        docId,
        peers: room.peerCount,
        documentBytes: room.documentBytes,
      });
    }
    return {
      connections: connections.size,
      rooms: roomRows,
      awarenessDropped,
      rateLimited,
      authFailures: counters.authFailures,
      rejectedUpdates: counters.rejectedUpdates,
    };
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    http.once('error', rejectListen);
    http.listen(config.port, config.host, () => {
      http.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = http.address() as AddressInfo;
  const port = address.port;
  const hostForUrl = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;

  logger.info('listening', {
    url: `http://${hostForUrl}:${port}`,
    dataDir: config.dataDir ?? '(memory)',
    tokenEndpoint: config.allowTokenEndpoint,
  });

  return {
    config,
    store,
    port,
    url: `http://${hostForUrl}:${port}`,
    wsUrl: `ws://${hostForUrl}:${port}${WS_PATH}`,
    mintToken: (claims) =>
      signToken(config.authSecret, {
        ...claims,
        exp: claims.exp ?? Math.floor(Date.now() / 1000) + 3600,
      }),
    room: (docId) => readyRooms.get(docId),
    flushAll: async () => {
      const all = await Promise.all([...rooms.values()]);
      await Promise.all(all.map((room) => room.flush()));
      await Promise.all([...closingRooms.values()]);
    },
    snapshot,
    close: async () => {
      for (const conn of connections) conn.close(1001, 'server shutting down');
      wss.close();
      const all = await Promise.allSettled([...rooms.values()]);
      rooms.clear();
      readyRooms.clear();
      await Promise.all(
        all.map((r) => (r.status === 'fulfilled' ? r.value.close() : undefined)),
      );
      await Promise.all([...closingRooms.values()]);
      await store.close();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

function toUint8Array(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function renderMetrics(snap: ServerSnapshot): string {
  const lines = [
    '# HELP collab_connections Current authenticated and pending WebSocket connections.',
    '# TYPE collab_connections gauge',
    `collab_connections ${snap.connections}`,
    '# HELP collab_rooms Currently open documents.',
    '# TYPE collab_rooms gauge',
    `collab_rooms ${snap.rooms.length}`,
    '# HELP collab_awareness_dropped_total Awareness frames dropped because a socket was behind.',
    '# TYPE collab_awareness_dropped_total counter',
    `collab_awareness_dropped_total ${snap.awarenessDropped}`,
    '# HELP collab_rate_limited_total Inbound frames refused by the token bucket.',
    '# TYPE collab_rate_limited_total counter',
    `collab_rate_limited_total ${snap.rateLimited}`,
    '# HELP collab_auth_failures_total Rejected authentication attempts.',
    '# TYPE collab_auth_failures_total counter',
    `collab_auth_failures_total ${snap.authFailures}`,
    '# HELP collab_rejected_updates_total Document updates refused by policy or validation.',
    '# TYPE collab_rejected_updates_total counter',
    `collab_rejected_updates_total ${snap.rejectedUpdates}`,
    '# HELP collab_room_peers Peers per open document.',
    '# TYPE collab_room_peers gauge',
  ];
  for (const room of snap.rooms) {
    lines.push(`collab_room_peers{doc="${room.docId}"} ${room.peers}`);
  }
  lines.push(
    '# HELP collab_room_document_bytes Accepted update bytes per open document.',
    '# TYPE collab_room_document_bytes gauge',
  );
  for (const room of snap.rooms) {
    lines.push(`collab_room_document_bytes{doc="${room.docId}"} ${room.documentBytes}`);
  }
  return `${lines.join('\n')}\n`;
}
