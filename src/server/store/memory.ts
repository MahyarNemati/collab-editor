import * as Y from 'yjs';
import { isValidDocId } from '../../protocol/limits.js';
import type { DocumentStats, DocumentStore } from './index.js';

/** In-memory store. Used by tests and by `COLLAB_DATA_DIR=` (empty). */
export class MemoryStore implements DocumentStore {
  private readonly logs = new Map<string, Uint8Array[]>();
  private readonly compactions = new Map<string, number>();

  constructor(
    private readonly options: {
      compactAfterFrames: number;
      compactAfterBytes: number;
    },
  ) {}

  private log(docId: string): Uint8Array[] {
    if (!isValidDocId(docId)) throw new Error(`invalid doc id: ${docId}`);
    let log = this.logs.get(docId);
    if (!log) {
      log = [];
      this.logs.set(docId, log);
    }
    return log;
  }

  async load(docId: string): Promise<Uint8Array[]> {
    return [...this.log(docId)];
  }

  async append(docId: string, update: Uint8Array): Promise<void> {
    const log = this.log(docId);
    log.push(update);
    const bytes = log.reduce((sum, u) => sum + u.byteLength, 0);
    if (
      log.length >= this.options.compactAfterFrames ||
      bytes >= this.options.compactAfterBytes
    ) {
      await this.compact(docId);
    }
  }

  async compact(docId: string): Promise<DocumentStats> {
    const log = this.log(docId);
    if (log.length > 1) {
      const merged = Y.mergeUpdates(log);
      this.logs.set(docId, [merged]);
      this.compactions.set(docId, (this.compactions.get(docId) ?? 0) + 1);
    }
    return this.stats(docId);
  }

  async stats(docId: string): Promise<DocumentStats> {
    const log = this.log(docId);
    return {
      frames: log.length,
      bytes: log.reduce((sum, u) => sum + u.byteLength, 0),
      compactions: this.compactions.get(docId) ?? 0,
    };
  }

  async destroy(docId: string): Promise<void> {
    this.logs.delete(docId);
    this.compactions.delete(docId);
  }

  async close(): Promise<void> {
    this.logs.clear();
  }
}
