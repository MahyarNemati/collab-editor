import { WebSocket as NodeWebSocket } from 'ws';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { startServer, type CollabServer } from '../../src/server/server.js';
import type { ServerConfig } from '../../src/server/config.js';
import { silentLogger } from '../../src/server/logger.js';
import { WebSocketProvider } from '../../src/client/src/provider.js';
import { decodeMessage, type Message } from '../../src/protocol/index.js';

/** `ws` implements the browser WebSocket interface closely enough to swap in. */
const WebSocketImpl = NodeWebSocket as unknown as typeof WebSocket;

export async function startTestServer(
  overrides: Partial<ServerConfig> = {},
): Promise<CollabServer> {
  return startServer(
    {
      host: '127.0.0.1',
      port: 0,
      authSecret: 'integration-test-secret',
      allowTokenEndpoint: true,
      dataDir: null,
      staticDir: null,
      persistFlushIntervalMs: 0,
      presenceTimeoutMs: 30_000,
      presenceSweepIntervalMs: 0,
      ...overrides,
    },
    { logger: silentLogger },
  );
}

export interface LiveClient {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly awareness: Awareness;
  readonly provider: WebSocketProvider;
  waitForSync(timeoutMs?: number): Promise<void>;
  type(value: string): void;
  destroy(): void;
}

/**
 * A real client: the production `WebSocketProvider`, driven over a real
 * WebSocket against a real server. Nothing about the sync path is stubbed —
 * only the WebSocket constructor differs from the browser.
 */
export function connectClient(
  server: CollabServer,
  options: {
    docId: string;
    userId: string;
    role?: 'read' | 'write';
    token?: string;
    doc?: Y.Doc;
    startOffline?: boolean;
  },
): LiveClient {
  const doc = options.doc ?? new Y.Doc();
  const text = doc.getText('body');
  const awareness = new Awareness(doc);
  const token =
    options.token ??
    server.mintToken({
      doc: options.docId,
      sub: options.userId,
      role: options.role ?? 'write',
    });

  const provider = new WebSocketProvider({
    url: server.wsUrl,
    docId: options.docId,
    token,
    doc,
    awareness,
    presenceHeartbeatMs: 60_000,
    startOffline: options.startOffline ?? false,
    WebSocketImpl,
  });

  return {
    doc,
    text,
    awareness,
    provider,
    waitForSync: (timeoutMs = 5_000) =>
      waitFor(
        () => provider.currentStatus === 'synced',
        `client ${options.userId} to reach "synced" (was "${provider.currentStatus}")`,
        timeoutMs,
      ),
    type: (value: string) => text.insert(text.length, value),
    destroy: () => {
      provider.destroy();
      awareness.destroy();
      doc.destroy();
    },
  };
}

export interface RawClient {
  readonly socket: NodeWebSocket;
  readonly received: Message[];
  send(frame: Uint8Array): void;
  waitOpen(): Promise<void>;
  waitForMessage(
    predicate: (m: Message) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Message>;
  waitClosed(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  close(): void;
}

/** A client that speaks the wire format directly, for hostile inputs. */
export function rawClient(server: CollabServer): RawClient {
  const socket = new NodeWebSocket(server.wsUrl);
  socket.binaryType = 'arraybuffer';
  const received: Message[] = [];
  let closed: { code: number; reason: string } | null = null;

  socket.on('message', (data: ArrayBuffer) => {
    try {
      received.push(decodeMessage(new Uint8Array(data)));
    } catch {
      // Hostile-input tests care about what the server sends back, and an
      // undecodable reply would itself be a failure the assertions catch.
    }
  });
  socket.on('close', (code: number, reason: Buffer) => {
    closed = { code, reason: reason.toString() };
  });
  socket.on('error', () => undefined);

  return {
    socket,
    received,
    send: (frame) => socket.send(frame, { binary: true }),
    waitOpen: () =>
      waitFor(() => socket.readyState === NodeWebSocket.OPEN, 'socket to open'),
    waitForMessage: async (predicate, label, timeoutMs = 5_000) => {
      await waitFor(() => received.some(predicate), label, timeoutMs);
      return received.find(predicate) as Message;
    },
    waitClosed: async (timeoutMs = 5_000) => {
      await waitFor(() => closed !== null, 'socket to close', timeoutMs);
      return closed as unknown as { code: number; reason: string };
    },
    close: () => socket.close(),
  };
}

export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

export async function waitForText(
  client: LiveClient,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> {
  await waitFor(
    () => client.text.toString() === expected,
    `text to become ${JSON.stringify(expected)} (was ${JSON.stringify(client.text.toString())})`,
    timeoutMs,
  );
}
