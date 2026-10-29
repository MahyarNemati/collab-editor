import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FileStore } from '../../src/server/store/file.js';
import { MemoryStore } from '../../src/server/store/memory.js';
import type { DocumentStore } from '../../src/server/store/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'collab-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function keystrokes(sentence: string): { updates: Uint8Array[]; text: string } {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  const text = doc.getText('body');
  for (const [index, char] of [...sentence].entries()) {
    text.insert(index, char);
  }
  return { updates, text: text.toString() };
}

function restore(frames: Uint8Array[]): string {
  const doc = new Y.Doc();
  for (const frame of frames) Y.applyUpdate(doc, frame);
  return doc.getText('body').toString();
}

describe.each<[string, (d: string) => DocumentStore]>([
  [
    'FileStore',
    (d) =>
      new FileStore({
        dataDir: d,
        compactAfterFrames: 8,
        compactAfterBytes: 1024 * 1024,
      }),
  ],
  [
    'MemoryStore',
    () => new MemoryStore({ compactAfterFrames: 8, compactAfterBytes: 1024 * 1024 }),
  ],
])('%s', (_name, make) => {
  it('returns an empty log for a document it has never seen', async () => {
    const store = make(dir);
    expect(await store.load('never-written')).toEqual([]);
    await store.close();
  });

  it('round-trips an update log into the same document text', async () => {
    const store = make(dir);
    const { updates, text } = keystrokes('persisted');
    for (const update of updates) await store.append('doc1', update);

    expect(restore(await store.load('doc1'))).toBe(text);
    await store.close();
  });

  it('compacts the log once it passes the frame threshold, losing nothing', async () => {
    const store = make(dir);
    const { updates, text } = keystrokes('compaction is lossless');
    expect(updates.length).toBeGreaterThan(8);

    for (const update of updates) await store.append('doc2', update);

    const stats = await store.stats('doc2');
    // The whole point: a 22-keystroke log is not 22 frames on disk.
    expect(stats.frames).toBeLessThan(updates.length);
    expect(stats.frames).toBeLessThanOrEqual(8);
    expect(stats.compactions).toBeGreaterThan(0);
    expect(restore(await store.load('doc2'))).toBe(text);
    await store.close();
  });

  it('keeps the log bounded under a long stream of edits', async () => {
    const store = make(dir);
    const { updates, text } = keystrokes(
      'a reasonably long sentence typed one character at a time to grow the log',
    );
    for (const update of updates) await store.append('doc3', update);
    const stats = await store.stats('doc3');

    expect(updates.length).toBeGreaterThan(60);
    expect(stats.frames).toBeLessThanOrEqual(8);
    expect(stats.compactions).toBeGreaterThanOrEqual(
      Math.floor(updates.length / 8) - 1,
    );
    expect(restore(await store.load('doc3'))).toBe(text);
    await store.close();
  });

  it('refuses a document id that is not a safe filename', async () => {
    const store = make(dir);
    await expect(store.load('../escape')).rejects.toThrow(/invalid doc id/);
    await expect(store.append('a/b', new Uint8Array([1]))).rejects.toThrow(
      /invalid doc id/,
    );
    await store.close();
  });

  it('destroy removes the document entirely', async () => {
    const store = make(dir);
    const { updates } = keystrokes('temporary');
    for (const update of updates) await store.append('doc4', update);
    expect((await store.load('doc4')).length).toBeGreaterThan(0);

    await store.destroy('doc4');
    expect(await store.load('doc4')).toEqual([]);
    await store.close();
  });
});

describe('FileStore on-disk behaviour', () => {
  it('shrinks the file on disk when it compacts', async () => {
    const store = new FileStore({
      dataDir: dir,
      compactAfterFrames: 1_000_000,
      compactAfterBytes: 1024 * 1024 * 1024,
    });
    const { updates, text } = keystrokes('measure the file, not the intention');
    for (const update of updates) await store.append('sized', update);

    const before = await store.fileSize('sized');
    expect(before).toBeGreaterThan(0);
    expect((await store.stats('sized')).frames).toBe(updates.length);

    await store.compact('sized');

    const after = await store.fileSize('sized');
    expect(after).toBeLessThan(before);
    expect((await store.stats('sized')).frames).toBe(1);
    expect(restore(await store.load('sized'))).toBe(text);
    await store.close();
  });

  it('survives a torn final frame from a crashed append', async () => {
    const store = new FileStore({
      dataDir: dir,
      compactAfterFrames: 1_000_000,
      compactAfterBytes: 1024 * 1024 * 1024,
    });
    const { updates } = keystrokes('crash safety');
    for (const update of updates) await store.append('torn', update);
    const full = restore(await store.load('torn'));

    // Simulate a process killed mid-write: a length header promising more
    // bytes than the file contains.
    const path = join(dir, 'torn.ylog');
    const bytes = await readFile(path);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(9_999, 0);
    await writeFile(path, Buffer.concat([bytes, header, Buffer.from([1, 2, 3])]));

    const frames = await store.load('torn');
    expect(frames.length).toBe(updates.length);
    // The complete prefix is still readable: the document opens, and only the
    // interrupted write is lost.
    expect(restore(frames)).toBe(full);
    await store.close();
  });

  it('is durable across store instances, which is what a restart looks like', async () => {
    const options = {
      dataDir: dir,
      compactAfterFrames: 4,
      compactAfterBytes: 1024 * 1024,
    };
    const first = new FileStore(options);
    const { updates, text } = keystrokes('restart me');
    for (const update of updates) await first.append('restarted', update);
    await first.close();

    const second = new FileStore(options);
    expect(restore(await second.load('restarted'))).toBe(text);
    await second.close();
  });

  it('serialises concurrent appends without interleaving frames', async () => {
    const store = new FileStore({
      dataDir: dir,
      compactAfterFrames: 3,
      compactAfterBytes: 1024 * 1024,
    });
    const { updates, text } = keystrokes('concurrent appends');

    // Fire every append at once; the per-document promise chain has to keep
    // the file readable even though compaction runs in the middle.
    await Promise.all(updates.map((u) => store.append('racy', u)));

    expect(restore(await store.load('racy'))).toBe(text);
    await store.close();
  });
});
