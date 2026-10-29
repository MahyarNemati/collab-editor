import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createReplica,
  createReplicas,
  deliver,
  expectConverged,
  makeRandom,
  report,
  shuffle,
  syncAll,
  syncPair,
} from '../support/crdt.js';

/**
 * Headless convergence. No browser, no WebSocket, no server — several `Y.Doc`s
 * in one process, with the network replaced by an array of update frames that
 * the test delivers in whatever order it likes.
 *
 * This is where the CRDT claim is actually checked. A screenshot of two cursors
 * proves that two sockets are open; byte-identical encoded state proves that
 * the replicas cannot diverge.
 */
describe('concurrent editing converges', () => {
  it('merges simultaneous inserts at the same position', () => {
    const [a, b] = createReplicas(2) as [
      ReturnType<typeof createReplica>,
      ReturnType<typeof createReplica>,
    ];
    a.text.insert(0, 'shared base. ');
    syncPair(a, b);
    expect(b.text.toString()).toBe('shared base. ');

    // Both type at offset 13 without having seen the other.
    a.text.insert(13, 'alpha');
    b.text.insert(13, 'bravo');
    expect(a.text.toString()).not.toBe(b.text.toString());

    syncPair(a, b);
    const merged = expectConverged([a, b]);
    expect(merged).toContain('alpha');
    expect(merged).toContain('bravo');
    expect(merged.startsWith('shared base. ')).toBe(true);
    // Both insertions survive in full; neither is truncated or interleaved.
    expect(merged).toHaveLength('shared base. '.length + 10);
  });

  it('survives updates delivered out of order, duplicated and delayed', () => {
    const [a, b] = createReplicas(2) as [
      ReturnType<typeof createReplica>,
      ReturnType<typeof createReplica>,
    ];
    a.text.insert(0, 'one ');
    a.text.insert(4, 'two ');
    a.text.insert(8, 'three ');
    a.text.delete(0, 4);
    b.text.insert(0, 'B! ');

    const fromA = a.produced;
    const fromB = b.produced;
    expect(fromA.length).toBe(4);
    expect(fromB.length).toBe(1);

    // Reverse order, every frame duplicated: the worst realistic delivery a
    // reconnecting or retrying transport can produce.
    const scrambled = [...fromA].reverse().flatMap((u) => [u, u]);
    for (const update of scrambled) deliver(b, update);
    for (const update of [...fromB, ...fromB]) deliver(a, update);

    const text = expectConverged([a, b]);
    expect(text).toContain('two three');
    expect(text).toContain('B!');
    expect(text).not.toContain('one');
  });

  it('still converges when one replica receives nothing until the very end', () => {
    const [a, b, c] = createReplicas(3) as [
      ReturnType<typeof createReplica>,
      ReturnType<typeof createReplica>,
      ReturnType<typeof createReplica>,
    ];
    a.text.insert(0, 'start');
    syncPair(a, b);

    // A and B talk to each other for a while. C has been asleep the whole time.
    for (let i = 0; i < 20; i += 1) {
      const writer = i % 2 === 0 ? a : b;
      writer.text.insert(writer.text.length, `-${i}`);
      syncPair(a, b);
    }
    expect(c.text.toString()).toBe('');

    syncAll([a, b, c]);
    const text = expectConverged([a, b, c]);
    expect(text.startsWith('start')).toBe(true);
    expect(text).toContain('-19');
  });
});

describe('offline then reconnect', () => {
  it('loses nothing when a replica edits while partitioned', () => {
    const [a, b] = createReplicas(2) as [
      ReturnType<typeof createReplica>,
      ReturnType<typeof createReplica>,
    ];
    a.text.insert(0, 'Draft.\n');
    syncPair(a, b);

    // The partition. A keeps typing with no connection at all; B keeps typing
    // too, so there is a real merge to do on reconnect rather than a fast-forward.
    a.text.insert(a.text.length, 'Written by A while offline.\n');
    a.text.insert(a.text.length, 'Second offline line from A.\n');
    b.text.insert(b.text.length, 'Written by B, still online.\n');

    const before = report([a, b]);
    expect(before.texts[0]).not.toBe(before.texts[1]);

    // Reconnect: exactly the handshake the provider performs — exchange state
    // vectors, send the difference. No replay queue is involved.
    syncPair(a, b);

    const text = expectConverged([a, b]);
    expect(text).toContain('Written by A while offline.');
    expect(text).toContain('Second offline line from A.');
    expect(text).toContain('Written by B, still online.');
    expect(text.startsWith('Draft.\n')).toBe(true);
  });

  it('merges a three-way partition where every replica edited the same region', () => {
    const [a, b, c] = createReplicas(3) as [
      ReturnType<typeof createReplica>,
      ReturnType<typeof createReplica>,
      ReturnType<typeof createReplica>,
    ];
    a.text.insert(0, 'The quick brown fox.');
    syncAll([a, b, c]);
    expect(c.text.toString()).toBe('The quick brown fox.');

    // All three go offline and all three rewrite the word "quick" (offsets
    // 4..9) — the case that a last-write-wins store would resolve by throwing
    // two of the three edits away.
    a.text.delete(4, 5);
    a.text.insert(4, 'SLOW');
    b.text.delete(4, 5);
    b.text.insert(4, 'lazy');
    c.text.insert(9, ' (c was here)');

    syncAll([a, b, c]);
    const text = expectConverged([a, b, c]);

    // Every replica's intent is still represented, and the deletion applied by
    // both A and B is not applied twice.
    expect(text).toContain('SLOW');
    expect(text).toContain('lazy');
    expect(text).toContain('(c was here)');
    expect(text).not.toContain('quick');
    expect(text.startsWith('The ')).toBe(true);
    expect(text.endsWith('brown fox.')).toBe(true);
  });

  it('is idempotent: re-syncing a converged set changes nothing', () => {
    const replicas = createReplicas(3);
    replicas[0]?.text.insert(0, 'alpha');
    replicas[1]?.text.insert(0, 'beta');
    replicas[2]?.text.insert(0, 'gamma');
    syncAll(replicas);
    const first = expectConverged(replicas);
    const firstState = report(replicas).stateHex[0];

    for (let round = 0; round < 5; round += 1) syncAll(replicas);

    expect(expectConverged(replicas)).toBe(first);
    expect(report(replicas).stateHex[0]).toBe(firstState);
  });
});

describe('merging the persisted update log', () => {
  it('Y.mergeUpdates of a keystroke log reconstructs the same document', () => {
    const source = createReplica('source');
    const sentence = 'Compaction must be lossless.';
    for (const [index, char] of [...sentence].entries()) {
      source.text.insert(index, char);
    }
    source.text.delete(0, 11);
    expect(source.produced.length).toBe(sentence.length + 1);

    // This is exactly what FileStore.compact does with an append-only log.
    const merged = Y.mergeUpdates(source.produced);
    expect(merged.byteLength).toBeLessThan(
      source.produced.reduce((sum, u) => sum + u.byteLength, 0),
    );

    const restored = createReplica('restored');
    deliver(restored, merged);
    expect(restored.text.toString()).toBe(source.text.toString());
    expect(
      Buffer.from(Y.encodeStateAsUpdate(restored.doc)).toString('hex'),
    ).toBe(Buffer.from(Y.encodeStateAsUpdate(source.doc)).toString('hex'));
  });

  it('a compacted log and the raw log produce byte-identical replicas', () => {
    const source = createReplica('source');
    const random = makeRandom(99);
    for (let i = 0; i < 60; i += 1) {
      const position = Math.floor(random() * (source.text.length + 1));
      source.text.insert(position, `w${i} `);
    }
    const fromRaw = createReplica('raw');
    for (const update of shuffle(source.produced, makeRandom(7))) {
      deliver(fromRaw, update);
    }
    const fromCompacted = createReplica('compacted');
    deliver(fromCompacted, Y.mergeUpdates(source.produced));

    expectConverged([source, fromRaw, fromCompacted]);
  });
});
