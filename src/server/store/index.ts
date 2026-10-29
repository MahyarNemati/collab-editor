export interface DocumentStats {
  /** Number of frames currently in the log. */
  frames: number;
  /** Total bytes of update payload held in the log. */
  bytes: number;
  /** How many times this document's log has been compacted. */
  compactions: number;
}

/**
 * Persistence for a document's Yjs update stream.
 *
 * Deliberately an *update log* rather than a snapshot store. A snapshot-only
 * store has to serialise the whole document on every change, and loses the
 * ability to answer "what changed since state vector X" without recomputing
 * it. The log is append-only, which is cheap — and which is exactly why it
 * needs {@link DocumentStore.compact}: an append-only log of keystrokes grows
 * without bound, and `Y.mergeUpdates` collapses it losslessly.
 */
export interface DocumentStore {
  /** Every persisted update frame for the document, oldest first. */
  load(docId: string): Promise<Uint8Array[]>;
  /** Append one update. May trigger compaction as a side effect. */
  append(docId: string, update: Uint8Array): Promise<void>;
  /** Collapse the log into a single merged frame. */
  compact(docId: string): Promise<DocumentStats>;
  stats(docId: string): Promise<DocumentStats>;
  /** Remove all persisted state for a document. */
  destroy(docId: string): Promise<void>;
  close(): Promise<void>;
}
