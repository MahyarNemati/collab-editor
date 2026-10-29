import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ErrorCode, MessageType, encodeUpdate } from '../../src/protocol/index.js';
import { FileStore } from '../../src/server/store/file.js';
import type { CollabServer } from '../../src/server/server.js';
import {
  connectClient,
  rawClient,
  startTestServer,
  waitFor,
  waitForText,
} from '../support/live.js';

let server: CollabServer;
let dataDir: string | null = null;

afterEach(async () => {
  await server.close();
  if (dataDir !== null) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

describe('two live clients over a real WebSocket', () => {
  beforeEach(async () => {
    server = await startTestServer();
  });

  it('converge on text typed in both', async () => {
    const alice = connectClient(server, { docId: 'live', userId: 'alice' });
    await alice.waitForSync();
    alice.type('from alice. ');

    const bob = connectClient(server, { docId: 'live', userId: 'bob' });
    await bob.waitForSync();
    await waitForText(bob, 'from alice. ');

    bob.type('from bob.');
    await waitForText(alice, 'from alice. from bob.');
    await waitForText(bob, 'from alice. from bob.');

    // Byte-identical, not merely equal-looking.
    expect(Buffer.from(Y.encodeStateAsUpdate(alice.doc)).toString('hex')).toBe(
      Buffer.from(Y.encodeStateAsUpdate(bob.doc)).toString('hex'),
    );

    alice.destroy();
    bob.destroy();
  });

  it('serves a late joiner the full history, not just what happens next', async () => {
    const alice = connectClient(server, { docId: 'late', userId: 'alice' });
    await alice.waitForSync();
    for (let i = 0; i < 20; i += 1) alice.type(`line ${i}\n`);
    const expected = alice.text.toString();
    expect(expected.split('\n')).toHaveLength(21);

    const carol = connectClient(server, { docId: 'late', userId: 'carol' });
    await carol.waitForSync();
    await waitForText(carol, expected);

    alice.destroy();
    carol.destroy();
  });

  it('keeps documents isolated from one another', async () => {
    const one = connectClient(server, { docId: 'docone', userId: 'u1' });
    const two = connectClient(server, { docId: 'doctwo', userId: 'u2' });
    await one.waitForSync();
    await two.waitForSync();

    one.type('only in doc one');
    await waitFor(
      () => server.room('docone')?.doc.getText('body').toString() === 'only in doc one',
      'server-side doc one to hold the text',
    );
    expect(two.text.toString()).toBe('');

    one.destroy();
    two.destroy();
  });
});

describe('document persistence', () => {
  beforeEach(async () => {
    server = await startTestServer({ dataDir: null });
  });

  it('survives every client disconnecting', async () => {
    const alice = connectClient(server, { docId: 'durable', userId: 'alice' });
    await alice.waitForSync();
    alice.type('this text outlives its author');
    await waitFor(
      () => server.room('durable')?.doc.getText('body').toString() === 'this text outlives its author',
      'the server to hold the text',
    );

    alice.destroy();

    // The room is gone: whatever the next client receives came from the store.
    await waitFor(() => server.room('durable') === undefined, 'the room to close');
    expect(server.snapshot().connections).toBe(0);

    const bob = connectClient(server, { docId: 'durable', userId: 'bob' });
    await bob.waitForSync();
    await waitForText(bob, 'this text outlives its author');
    expect(bob.text.toString()).toBe('this text outlives its author');

    bob.destroy();
  });
});

describe('persistence on disk', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'collab-ws-'));
    server = await startTestServer({ dataDir, compactAfterFrames: 4 });
  });

  it('recovers the document after the whole server process restarts', async () => {
    const alice = connectClient(server, { docId: 'restart', userId: 'alice' });
    await alice.waitForSync();
    alice.type('written before the restart');
    await waitFor(
      () => server.room('restart')?.doc.getText('body').toString() === 'written before the restart',
      'the server to hold the text',
    );
    alice.destroy();

    // Full shutdown, including the store.
    await server.close();

    const restarted = await startTestServer({
      dataDir: dataDir as string,
      compactAfterFrames: 4,
    });
    server = restarted;

    const bob = connectClient(restarted, { docId: 'restart', userId: 'bob' });
    await bob.waitForSync();
    await waitForText(bob, 'written before the restart');

    bob.destroy();
  });

  it('compacts the log while clients are connected and still recovers', async () => {
    const alice = connectClient(server, { docId: 'compacted', userId: 'alice' });
    await alice.waitForSync();

    // Each insert is its own transaction, so each is its own flushed frame —
    // enough of them to cross the compaction threshold several times over.
    for (let i = 0; i < 40; i += 1) alice.type(`${i},`);
    const expected = alice.text.toString();
    await waitFor(
      () => server.room('compacted')?.doc.getText('body').toString() === expected,
      'the server to receive every keystroke',
    );
    await server.flushAll();

    const store = new FileStore({
      dataDir: dataDir as string,
      compactAfterFrames: 1_000_000,
      compactAfterBytes: 1024 * 1024 * 1024,
    });
    const stats = await store.stats('compacted');
    expect(stats.frames).toBeGreaterThan(0);
    expect(stats.frames).toBeLessThanOrEqual(4);
    expect(await store.fileSize('compacted')).toBeGreaterThan(0);
    await store.close();

    alice.destroy();
    await waitFor(() => server.room('compacted') === undefined, 'the room to close');

    const bob = connectClient(server, { docId: 'compacted', userId: 'bob' });
    await bob.waitForSync();
    await waitForText(bob, expected);
    expect(bob.text.toString()).toBe(expected);

    bob.destroy();
  });
});

describe('offline editing and reconnect', () => {
  beforeEach(async () => {
    server = await startTestServer();
  });

  it('syncs edits made while disconnected, in both directions', async () => {
    const alice = connectClient(server, { docId: 'offline', userId: 'alice' });
    const bob = connectClient(server, { docId: 'offline', userId: 'bob' });
    await alice.waitForSync();
    await bob.waitForSync();
    alice.type('shared start. ');
    await waitForText(bob, 'shared start. ');

    alice.provider.setOffline(true);
    await waitFor(
      () => server.room('offline')?.peerCount === 1,
      'the server to see alice leave',
    );

    alice.type('[alice offline] ');
    bob.type('[bob online] ');
    expect(alice.text.toString()).not.toBe(bob.text.toString());

    alice.provider.setOffline(false);
    await alice.waitForSync();

    const converged = 'shared start. ';
    await waitFor(
      () =>
        alice.text.toString() === bob.text.toString() &&
        alice.text.toString().includes('[alice offline]') &&
        alice.text.toString().includes('[bob online]'),
      'both clients to converge after reconnect',
    );
    expect(alice.text.toString().startsWith(converged)).toBe(true);
    expect(Buffer.from(Y.encodeStateAsUpdate(alice.doc)).toString('hex')).toBe(
      Buffer.from(Y.encodeStateAsUpdate(bob.doc)).toString('hex'),
    );

    alice.destroy();
    bob.destroy();
  });

  it('merges a three-way partition where two clients edited the same region', async () => {
    const alice = connectClient(server, { docId: 'threeway', userId: 'alice' });
    const bob = connectClient(server, { docId: 'threeway', userId: 'bob' });
    const carol = connectClient(server, { docId: 'threeway', userId: 'carol' });
    await alice.waitForSync();
    await bob.waitForSync();
    await carol.waitForSync();

    alice.type('The quick brown fox.');
    await waitForText(bob, 'The quick brown fox.');
    await waitForText(carol, 'The quick brown fox.');

    alice.provider.setOffline(true);
    bob.provider.setOffline(true);
    await waitFor(
      () => server.room('threeway')?.peerCount === 1,
      'the server to be left with carol only',
    );

    // Both offline clients rewrite "quick" (offsets 4..9).
    alice.text.delete(4, 5);
    alice.text.insert(4, 'SLOW');
    bob.text.delete(4, 5);
    bob.text.insert(4, 'lazy');
    carol.text.insert(carol.text.length, ' Carol kept typing.');

    alice.provider.setOffline(false);
    bob.provider.setOffline(false);
    await alice.waitForSync();
    await bob.waitForSync();

    await waitFor(() => {
      const texts = [alice, bob, carol].map((c) => c.text.toString());
      return new Set(texts).size === 1 && texts[0]!.includes('SLOW');
    }, 'all three clients to converge');

    const text = alice.text.toString();
    expect(text).toContain('SLOW');
    expect(text).toContain('lazy');
    expect(text).toContain('Carol kept typing.');
    expect(text).not.toContain('quick');

    const states = [alice, bob, carol].map((c) =>
      Buffer.from(Y.encodeStateAsUpdate(c.doc)).toString('hex'),
    );
    expect(new Set(states).size).toBe(1);

    // And the server holds the same merged document, not one client's version.
    expect(server.room('threeway')?.doc.getText('body').toString()).toBe(text);

    alice.destroy();
    bob.destroy();
    carol.destroy();
  });
});

describe('presence over the wire', () => {
  beforeEach(async () => {
    server = await startTestServer({ presenceTimeoutMs: 150, presenceSweepIntervalMs: 25 });
  });

  it('shows peers to each other and forgets them when they leave', async () => {
    const alice = connectClient(server, { docId: 'presence', userId: 'alice' });
    await alice.waitForSync();
    alice.awareness.setLocalStateField('user', { name: 'alice' });

    const bob = connectClient(server, { docId: 'presence', userId: 'bob' });
    await bob.waitForSync();
    bob.awareness.setLocalStateField('user', { name: 'bob' });

    await waitFor(
      () => namesSeenBy(bob).includes('alice'),
      "bob to see alice's cursor",
    );
    await waitFor(
      () => namesSeenBy(alice).includes('bob'),
      "alice to see bob's cursor",
    );

    alice.destroy();
    await waitFor(
      () => namesSeenBy(bob).length === 0,
      "alice's presence to disappear from bob",
    );

    bob.destroy();
  });

  it('expires a peer that stops reporting without closing its socket', async () => {
    const alice = connectClient(server, { docId: 'stale', userId: 'alice' });
    await alice.waitForSync();
    alice.awareness.setLocalStateField('user', { name: 'alice' });
    const bob = connectClient(server, { docId: 'stale', userId: 'bob' });
    await bob.waitForSync();
    bob.awareness.setLocalStateField('user', { name: 'bob' });

    await waitFor(() => namesSeenBy(bob).includes('alice'), 'bob to see alice');

    // Alice's socket stays open; she simply stops sending awareness. The
    // heartbeat is 60s in tests, so the 150ms server timeout wins.
    await waitFor(
      () => !namesSeenBy(bob).includes('alice'),
      "the server to expire alice's presence",
      5_000,
    );
    // The document connection is untouched by presence expiry.
    expect(server.room('stale')?.peerCount).toBe(2);
    alice.type('still connected');
    await waitForText(bob, 'still connected');

    alice.destroy();
    bob.destroy();
  });
});

function namesSeenBy(client: {
  awareness: { getStates(): Map<number, unknown> };
  doc: Y.Doc;
}): string[] {
  return [...client.awareness.getStates().entries()]
    .filter(([id]) => id !== client.doc.clientID)
    .map(([, state]) => (state as { user?: { name?: string } }).user?.name)
    .filter((name): name is string => typeof name === 'string');
}

describe('authorisation', () => {
  beforeEach(async () => {
    server = await startTestServer();
  });

  it('rejects a forged token and applies nothing', async () => {
    const victim = connectClient(server, { docId: 'guarded', userId: 'alice' });
    await victim.waitForSync();
    victim.type('legitimate content');

    const attacker = connectClient(server, {
      docId: 'guarded',
      userId: 'attacker',
      token: 'ZXZpbA.ZmFrZS1zaWduYXR1cmU',
    });
    await waitFor(
      () => attacker.provider.currentStatus === 'error',
      'the attacker to be rejected',
    );
    attacker.text.insert(0, 'INJECTED');

    // The forged client never joined, so the server document is untouched.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.room('guarded')?.doc.getText('body').toString()).toBe(
      'legitimate content',
    );
    expect(server.snapshot().authFailures).toBeGreaterThan(0);

    attacker.destroy();
    victim.destroy();
  });

  it('rejects an expired token', async () => {
    const expired = server.mintToken({
      doc: 'guarded',
      sub: 'alice',
      role: 'write',
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const client = rawClient(server);
    await client.waitOpen();
    client.send(
      (await import('../../src/protocol/index.js')).encodeMessage({
        type: MessageType.Auth,
        token: expired,
      }),
    );
    const error = await client.waitForMessage(
      (m) => m.type === MessageType.Error,
      'an auth error',
    );
    expect(error.type === MessageType.Error && error.code).toBe(
      ErrorCode.Unauthorized,
    );
    expect(error.type === MessageType.Error && error.message).toMatch(/expired/);
    await client.waitClosed();
  });

  it('lets a read-only client observe, and keeps its local edits local', async () => {
    const writer = connectClient(server, { docId: 'readonly', userId: 'writer' });
    await writer.waitForSync();
    writer.type('visible to readers');

    const reader = connectClient(server, {
      docId: 'readonly',
      userId: 'reader',
      role: 'read',
    });
    await reader.waitForSync();
    await waitForText(reader, 'visible to readers');
    expect(reader.provider.canWrite).toBe(false);

    // A `Y.Doc` cannot refuse an edit, so a read-only client edits locally and
    // declines to send. The edit is real for the reader and invisible to
    // everyone else.
    reader.text.insert(0, 'READER EDIT ');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(reader.text.toString()).toBe('READER EDIT visible to readers');
    expect(server.room('readonly')?.doc.getText('body').toString()).toBe(
      'visible to readers',
    );
    expect(writer.text.toString()).toBe('visible to readers');
    // Still connected: declining to write is not an error condition.
    expect(reader.provider.currentStatus).toBe('synced');

    // And the reader keeps receiving: a later write by the writer still lands.
    writer.type(' plus more');
    await waitFor(
      () => reader.text.toString().includes('plus more'),
      'the reader to keep receiving updates',
    );

    reader.destroy();
    writer.destroy();
  });

  it('refuses a document update from a read-only token at the server', async () => {
    const writer = connectClient(server, { docId: 'enforced', userId: 'writer' });
    await writer.waitForSync();
    writer.type('server-side guard');

    // A hostile client that ignores its own role: the server is the thing that
    // has to say no, and this asserts that it does.
    const { encodeMessage } = await import('../../src/protocol/index.js');
    const client = rawClient(server);
    await client.waitOpen();
    client.send(
      encodeMessage({
        type: MessageType.Auth,
        token: server.mintToken({ doc: 'enforced', sub: 'sneak', role: 'read' }),
      }),
    );
    await client.waitForMessage((m) => m.type === MessageType.AuthOk, 'auth');

    const forged = new Y.Doc();
    forged.getText('body').insert(0, 'INJECTED ');
    client.send(encodeUpdate(Y.encodeStateAsUpdate(forged)));

    const error = await client.waitForMessage(
      (m) => m.type === MessageType.Error,
      'a forbidden error',
    );
    expect(error.type === MessageType.Error && error.code).toBe(
      ErrorCode.Forbidden,
    );
    expect(error.type === MessageType.Error && error.message).toMatch(
      /read access only/,
    );
    const closed = await client.waitClosed();
    expect(closed.code).toBe(ErrorCode.Forbidden);

    expect(server.room('enforced')?.doc.getText('body').toString()).toBe(
      'server-side guard',
    );
    expect(writer.text.toString()).toBe('server-side guard');
    expect(server.snapshot().rejectedUpdates).toBeGreaterThan(0);

    writer.destroy();
  });

  it('requires an auth frame first', async () => {
    const client = rawClient(server);
    await client.waitOpen();
    client.send(encodeUpdate(new Uint8Array([0, 0])));

    const error = await client.waitForMessage(
      (m) => m.type === MessageType.Error,
      'an unauthorized error',
    );
    expect(error.type === MessageType.Error && error.code).toBe(
      ErrorCode.Unauthorized,
    );
    await client.waitClosed();
  });
});

describe('resource limits', () => {
  it('refuses an oversized update and disconnects the sender', async () => {
    server = await startTestServer();
    const client = rawClient(server);
    await client.waitOpen();
    const { encodeMessage } = await import('../../src/protocol/index.js');
    client.send(
      encodeMessage({
        type: MessageType.Auth,
        token: server.mintToken({ doc: 'limits', sub: 'flooder', role: 'write' }),
      }),
    );
    await client.waitForMessage(
      (m) => m.type === MessageType.AuthOk,
      'auth to succeed',
    );

    // 300 KiB is past the 256 KiB per-update limit but inside the frame limit,
    // so it is the limit under test that rejects it.
    client.send(encodeUpdate(new Uint8Array(300 * 1024)));

    const error = await client.waitForMessage(
      (m) => m.type === MessageType.Error && m.code === ErrorCode.PayloadTooLarge,
      'a payload-too-large error',
    );
    expect(error.type === MessageType.Error && error.message).toMatch(
      /exceeds limit/,
    );
    const closed = await client.waitClosed();
    expect(closed.code).toBe(ErrorCode.PayloadTooLarge);
  });

  it('rate-limits a client that floods frames', async () => {
    server = await startTestServer({
      inboundFramesPerSecond: 5,
      inboundBurst: 5,
    });
    const client = rawClient(server);
    await client.waitOpen();
    const { encodeMessage } = await import('../../src/protocol/index.js');
    const token = server.mintToken({ doc: 'flood', sub: 'flooder', role: 'write' });

    // The auth frame itself consumes a token, so 20 frames is well past the
    // burst of 5 even allowing for refill.
    client.send(encodeMessage({ type: MessageType.Auth, token }));
    for (let i = 0; i < 20; i += 1) {
      client.send(
        encodeMessage({
          type: MessageType.SyncStep1,
          stateVector: new Uint8Array([0]),
        }),
      );
    }

    const error = await client.waitForMessage(
      (m) => m.type === MessageType.Error && m.code === ErrorCode.RateLimited,
      'a rate-limit error',
    );
    expect(error.type === MessageType.Error && error.message).toMatch(
      /frames\/s/,
    );
    await client.waitClosed();
    expect(server.snapshot().rateLimited).toBeGreaterThanOrEqual(0);
  });

  it('rejects an undecodable update that is within the size limit', async () => {
    server = await startTestServer();
    const client = rawClient(server);
    await client.waitOpen();
    const { encodeMessage } = await import('../../src/protocol/index.js');
    client.send(
      encodeMessage({
        type: MessageType.Auth,
        token: server.mintToken({ doc: 'garbage', sub: 'u', role: 'write' }),
      }),
    );
    await client.waitForMessage((m) => m.type === MessageType.AuthOk, 'auth');

    client.send(encodeUpdate(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff])));

    const error = await client.waitForMessage(
      (m) => m.type === MessageType.Error,
      'a validation error',
    );
    expect(error.type === MessageType.Error && error.code).toBe(
      ErrorCode.BadRequest,
    );
    expect(error.type === MessageType.Error && error.message).toMatch(
      /not a decodable Yjs update/,
    );
  });
});

describe('http surface', () => {
  beforeEach(async () => {
    server = await startTestServer();
  });

  it('answers /healthz', async () => {
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('exposes metrics that reflect live rooms', async () => {
    const alice = connectClient(server, { docId: 'metrics', userId: 'alice' });
    await alice.waitForSync();
    alice.type('measured');
    await waitFor(
      () => server.room('metrics') !== undefined,
      'the room to be open',
    );

    const body = await (await fetch(`${server.url}/metrics`)).text();
    expect(body).toContain('collab_rooms 1');
    expect(body).toContain('collab_room_peers{doc="metrics"} 1');
    expect(body).toMatch(/collab_room_document_bytes\{doc="metrics"\} [1-9]/);

    alice.destroy();
  });

  it('mints a token for the demo and validates its inputs', async () => {
    const ok = await fetch(`${server.url}/api/token?doc=demo&user=alice&role=write`);
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { token: string }).toHaveProperty('token');

    for (const query of [
      'doc=../escape&user=alice',
      'doc=demo&user=',
      'doc=demo&user=alice&role=admin',
    ]) {
      const res = await fetch(`${server.url}/api/token?${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it('refuses to mint tokens when the endpoint is disabled', async () => {
    await server.close();
    server = await startTestServer({ allowTokenEndpoint: false });
    const res = await fetch(`${server.url}/api/token?doc=demo&user=alice`);
    expect(res.status).toBe(403);
  });

  it('rejects a WebSocket upgrade on the wrong path', async () => {
    const { WebSocket: NodeWebSocket } = await import('ws');
    const socket = new NodeWebSocket(`${server.wsUrl.replace('/ws', '/nope')}`);
    const failure = await new Promise<string>((resolve) => {
      socket.on('error', (err: Error) => resolve(err.message));
      socket.on('open', () => resolve('unexpectedly opened'));
    });
    expect(failure).toMatch(/404|Unexpected server response/);
  });
});
