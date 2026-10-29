import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import { isValidDocId } from '../../protocol/limits.js';
import type { DocumentStats, DocumentStore } from './index.js';

const HEADER_BYTES = 4;

export interface FileStoreOptions {
  dataDir: string;
  compactAfterFrames: number;
  compactAfterBytes: number;
}

/**
 * Append-only update log on disk, one file per document.
 *
 * Layout: a sequence of `[uint32be length][length bytes of Yjs update]`.
 * Length-prefixed rather than delimited because Yjs updates are arbitrary
 * binary and contain every possible byte, so there is no safe delimiter.
 *
 * Compaction rewrites the whole file as a single merged frame, via a temp file
 * and `rename`, which is atomic within a directory on POSIX: a crash mid-write
 * leaves either the old complete log or the new complete one, never a torn
 * file. A torn *append* is still possible (a partial final frame), so
 * {@link FileStore.load} stops at the first incomplete frame rather than
 * throwing — losing the last keystroke of a crashed process is acceptable,
 * refusing to open the document is not.
 */
export class FileStore implements DocumentStore {
  private readonly compactions = new Map<string, number>();
  /** Per-document promise chain, so appends and compactions never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private ready: Promise<void> | null = null;

  constructor(private readonly options: FileStoreOptions) {}

  private async init(): Promise<void> {
    this.ready ??= mkdir(this.options.dataDir, { recursive: true }).then(
      () => undefined,
    );
    return this.ready;
  }

  private path(docId: string): string {
    if (!isValidDocId(docId)) {
      // The doc id reaches us from a signed token, but a signed token is only
      // as trustworthy as whatever minted it; path traversal is cheap to rule
      // out here and expensive to discover later.
      throw new Error(`invalid doc id: ${JSON.stringify(docId)}`);
    }
    return join(this.options.dataDir, `${docId}.ylog`);
  }

  /** Serialise work per document; the chain is what makes appends safe. */
  private enqueue<T>(docId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(docId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(
      docId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async readFrames(docId: string): Promise<Uint8Array[]> {
    let buf: Buffer;
    try {
      buf = await readFile(this.path(docId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + HEADER_BYTES <= buf.byteLength) {
      const length = buf.readUInt32BE(offset);
      const start = offset + HEADER_BYTES;
      const end = start + length;
      if (length === 0 || end > buf.byteLength) {
        // Truncated tail from a crash mid-append. Stop here.
        break;
      }
      frames.push(new Uint8Array(buf.subarray(start, end)));
      offset = end;
    }
    return frames;
  }

  async load(docId: string): Promise<Uint8Array[]> {
    await this.init();
    return this.enqueue(docId, () => this.readFrames(docId));
  }

  async append(docId: string, update: Uint8Array): Promise<void> {
    await this.init();
    const needsCompaction = await this.enqueue(docId, async () => {
      const header = Buffer.alloc(HEADER_BYTES);
      header.writeUInt32BE(update.byteLength, 0);
      const handle = await open(this.path(docId), 'a');
      try {
        await handle.appendFile(Buffer.concat([header, Buffer.from(update)]));
        // Durability is a real trade-off and worth naming: we do not fsync on
        // every keystroke. A host crash can lose the last flush interval. The
        // alternative costs a disk round-trip per edit; see README "Durability".
      } finally {
        await handle.close();
      }
      const frames = await this.rawStats(docId);
      return (
        frames.frames >= this.options.compactAfterFrames ||
        frames.bytes >= this.options.compactAfterBytes
      );
    });
    if (needsCompaction) await this.compact(docId);
  }

  async compact(docId: string): Promise<DocumentStats> {
    await this.init();
    return this.enqueue(docId, async () => {
      const frames = await this.readFrames(docId);
      if (frames.length > 1) {
        const merged = Y.mergeUpdates(frames);
        const header = Buffer.alloc(HEADER_BYTES);
        header.writeUInt32BE(merged.byteLength, 0);
        const target = this.path(docId);
        const tmp = `${target}.compact-${process.pid}-${Date.now()}`;
        const handle = await open(tmp, 'w');
        try {
          await handle.writeFile(Buffer.concat([header, Buffer.from(merged)]));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmp, target);
        this.compactions.set(docId, (this.compactions.get(docId) ?? 0) + 1);
      }
      return this.rawStats(docId);
    });
  }

  private async rawStats(docId: string): Promise<DocumentStats> {
    const frames = await this.readFrames(docId);
    return {
      frames: frames.length,
      bytes: frames.reduce((sum, f) => sum + f.byteLength, 0),
      compactions: this.compactions.get(docId) ?? 0,
    };
  }

  async stats(docId: string): Promise<DocumentStats> {
    await this.init();
    return this.enqueue(docId, () => this.rawStats(docId));
  }

  /** On-disk size including frame headers. */
  async fileSize(docId: string): Promise<number> {
    try {
      return (await stat(this.path(docId))).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  async destroy(docId: string): Promise<void> {
    await this.init();
    await this.enqueue(docId, async () => {
      await rm(this.path(docId), { force: true });
      this.compactions.delete(docId);
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }
}
