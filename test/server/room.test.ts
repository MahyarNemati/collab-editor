import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import { Room } from '../../src/server/room.js';
import { MemoryStore } from '../../src/server/store/memory.js';
import { ErrorCode, MessageType } from '../../src/protocol/index.js';
import { fakePeer } from '../support/fake-peer.js';

const storeOptions = { compactAfterFrames: 64, compactAfterBytes: 1024 * 1024 };

const roomOptions = (overrides: Partial<Parameters<typeof Room.open>[2]> = {}) => ({
  persistFlushIntervalMs: 0,
  presenceTimeoutMs: 1_000,
  presenceSweepIntervalMs: 0,
  maxDocumentBytes: 1024 * 1024,
  maxAwarenessClientsPerConnection: 4,
  ...overrides,
});

function awarenessUpdateFor(name: string): {
  update: Uint8Array;
  clientId: number;
} {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', { name });
  const update = encodeAwarenessUpdate(awareness, [doc.clientID]);
  const clientId = doc.clientID;
  awareness.destroy();
  return { update, clientId };
}

describe('document updates', () => {
  it('applies, broadcasts to other peers and persists', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions());
    const author = fakePeer();
    const observer = fakePeer();
    room.addPeer(author.connection);
    room.addPeer(observer.connection);

    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'hello room');
    const result = room.applyDocumentUpdate(Y.encodeStateAsUpdate(doc), author.connection);

    expect(result.ok).toBe(true);
    expect(room.doc.getText('body').toString()).toBe('hello room');

    // The author does not get its own edit echoed back.
    expect(author.transport.ofType(MessageType.Update)).toHaveLength(0);
    const broadcast = observer.transport.ofType(MessageType.Update);
    expect(broadcast).toHaveLength(1);

    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, broadcast[0]!.update);
    expect(mirror.getText('body').toString()).toBe('hello room');

    await room.flush();
    const frames = await store.load('doc');
    expect(frames.length).toBeGreaterThan(0);
    const restored = new Y.Doc();
    for (const frame of frames) Y.applyUpdate(restored, frame);
    expect(restored.getText('body').toString()).toBe('hello room');

    await room.close();
    await store.close();
  });

  it('rejects bytes that are not a decodable Yjs update', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions());
    const peer = fakePeer();
    room.addPeer(peer.connection);

    const result = room.applyDocumentUpdate(
      new Uint8Array([255, 255, 255, 255, 255, 255]),
      peer.connection,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.BadRequest);
      expect(result.message).toMatch(/not a decodable Yjs update/);
    }
    // Nothing was applied and nothing will be written.
    expect(room.doc.getText('body').toString()).toBe('');
    await room.flush();
    expect(await store.load('doc')).toEqual([]);

    await room.close();
    await store.close();
  });

  it('refuses an update that would push the document past its quota', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions({ maxDocumentBytes: 200 }));
    const peer = fakePeer();
    room.addPeer(peer.connection);

    const small = new Y.Doc();
    small.getText('body').insert(0, 'ok');
    expect(room.applyDocumentUpdate(Y.encodeStateAsUpdate(small), peer.connection).ok).toBe(true);

    const big = new Y.Doc();
    big.getText('body').insert(0, 'x'.repeat(5_000));
    const result = room.applyDocumentUpdate(Y.encodeStateAsUpdate(big), peer.connection);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.DocumentFull);
    expect(room.doc.getText('body').toString()).toBe('ok');

    await room.close();
    await store.close();
  });

  it('coalesces a burst of updates into a single persisted frame', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions({ persistFlushIntervalMs: 50 }));
    const peer = fakePeer();
    room.addPeer(peer.connection);

    const doc = new Y.Doc();
    const text = doc.getText('body');
    let seen = Y.encodeStateVector(doc);
    for (const char of 'coalesced') {
      text.insert(text.length, char);
      const update = Y.encodeStateAsUpdate(doc, seen);
      seen = Y.encodeStateVector(doc);
      expect(room.applyDocumentUpdate(update, peer.connection).ok).toBe(true);
    }

    await room.flush();
    const frames = await store.load('doc');
    expect(frames).toHaveLength(1);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, frames[0]!);
    expect(restored.getText('body').toString()).toBe('coalesced');

    await room.close();
    await store.close();
  });

  it('recovers the document from the store when reopened', async () => {
    const store = new MemoryStore(storeOptions);
    const first = await Room.open('doc', store, roomOptions());
    const peer = fakePeer();
    first.addPeer(peer.connection);
    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'survives a reopen');
    first.applyDocumentUpdate(Y.encodeStateAsUpdate(doc), peer.connection);
    await first.close();

    const second = await Room.open('doc', store, roomOptions());
    expect(second.doc.getText('body').toString()).toBe('survives a reopen');
    expect(second.documentBytes).toBeGreaterThan(0);

    await second.close();
    await store.close();
  });
});

describe('presence', () => {
  it('broadcasts awareness to other peers but never writes it to the store', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('ghosts', store, roomOptions());
    const alice = fakePeer();
    const bob = fakePeer();
    room.addPeer(alice.connection);
    room.addPeer(bob.connection);

    const { update } = awarenessUpdateFor('alice');
    expect(room.applyAwarenessUpdate(update, alice.connection).ok).toBe(true);

    expect(bob.transport.ofType(MessageType.Awareness)).toHaveLength(1);
    expect(alice.transport.ofType(MessageType.Awareness)).toHaveLength(0);

    // The assertion that matters: presence left no trace on disk, so reopening
    // the document cannot resurrect a cursor belonging to someone who left.
    await room.flush();
    expect(await store.load('ghosts')).toEqual([]);
    await room.close();

    const reopened = await Room.open('ghosts', store, roomOptions());
    expect(reopened.awareness.getStates().size).toBe(0);
    expect(reopened.doc.getText('body').toString()).toBe('');
    await reopened.close();
    await store.close();
  });

  it('expires a peer that has stopped reporting', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions({ presenceTimeoutMs: 1_000 }));
    const alice = fakePeer();
    const bob = fakePeer();
    room.addPeer(alice.connection);
    room.addPeer(bob.connection);

    const { update, clientId } = awarenessUpdateFor('alice');
    room.applyAwarenessUpdate(update, alice.connection);
    expect(room.awareness.getStates().has(clientId)).toBe(true);

    // Not yet stale.
    expect(room.sweepPresence(Date.now() + 500)).toEqual([]);
    expect(room.awareness.getStates().has(clientId)).toBe(true);

    const expired = room.sweepPresence(Date.now() + 5_000);
    expect(expired).toEqual([clientId]);
    expect(room.awareness.getStates().has(clientId)).toBe(false);

    // The removal is broadcast, so other peers erase the caret too.
    const bobAwareness = bob.transport.ofType(MessageType.Awareness);
    expect(bobAwareness.length).toBeGreaterThanOrEqual(2);
    expect(alice.connection.awarenessClients.has(clientId)).toBe(false);

    await room.close();
    await store.close();
  });

  it('drops a peer’s presence when it disconnects', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions());
    const alice = fakePeer();
    const bob = fakePeer();
    room.addPeer(alice.connection);
    room.addPeer(bob.connection);

    const { update, clientId } = awarenessUpdateFor('alice');
    room.applyAwarenessUpdate(update, alice.connection);
    expect(room.awareness.getStates().has(clientId)).toBe(true);

    room.removePeer(alice.connection);

    expect(room.awareness.getStates().has(clientId)).toBe(false);
    expect(room.peerCount).toBe(1);
    expect(bob.transport.ofType(MessageType.Awareness).length).toBeGreaterThanOrEqual(2);

    await room.close();
    await store.close();
  });

  it('refuses to let one connection move another connection’s cursor', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions());
    const alice = fakePeer();
    const impostor = fakePeer();
    room.addPeer(alice.connection);
    room.addPeer(impostor.connection);

    const alicePresence = awarenessUpdateFor('alice');
    room.applyAwarenessUpdate(alicePresence.update, alice.connection);

    // The impostor replays Alice's client id as if it were its own.
    const result = room.applyAwarenessUpdate(
      alicePresence.update,
      impostor.connection,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.Forbidden);
      expect(result.message).toMatch(/belongs to another connection/);
    }
    expect(impostor.connection.awarenessClients.size).toBe(0);
    // Alice's state is untouched, not overwritten by the impostor's payload.
    expect(room.awareness.getStates().size).toBe(1);
    expect(alice.connection.awarenessClients.has(alicePresence.clientId)).toBe(true);

    await room.close();
    await store.close();
  });

  it('caps how many awareness identities one connection may claim', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions({
      maxAwarenessClientsPerConnection: 2,
    }));
    const flooder = fakePeer();
    room.addPeer(flooder.connection);

    expect(room.applyAwarenessUpdate(awarenessUpdateFor('a').update, flooder.connection).ok).toBe(true);
    expect(room.applyAwarenessUpdate(awarenessUpdateFor('b').update, flooder.connection).ok).toBe(true);

    const third = room.applyAwarenessUpdate(
      awarenessUpdateFor('c').update,
      flooder.connection,
    );
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.code).toBe(ErrorCode.Forbidden);
      expect(third.message).toMatch(/at most 2 awareness client ids/);
    }
    expect(room.awareness.getStates().size).toBe(2);

    await room.close();
    await store.close();
  });

  it('rejects a malformed awareness payload', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions());
    const peer = fakePeer();
    room.addPeer(peer.connection);

    const result = room.applyAwarenessUpdate(
      new Uint8Array([5, 1, 1]),
      peer.connection,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.BadRequest);

    await room.close();
    await store.close();
  });

  it('does not list the server itself as a peer', async () => {
    const store = new MemoryStore(storeOptions);
    const room = await Room.open('doc', store, roomOptions());
    expect(room.awareness.getLocalState()).toBeNull();
    expect(room.awareness.getStates().size).toBe(0);
    expect(room.awarenessSnapshot()).toBeNull();
    await room.close();
    await store.close();
  });
});
