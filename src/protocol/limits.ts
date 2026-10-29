/**
 * Protocol and resource limits.
 *
 * These are deliberately in the shared module: the client needs to know the
 * ceiling so it can split or refuse a payload *before* sending it, and the
 * server needs to enforce it because the client is not trusted.
 */
export const LIMITS = {
  /** Largest accepted single wire frame, including the one-byte type tag. */
  maxFrameBytes: 512 * 1024,
  /** Largest accepted Yjs document update inside SYNC_STEP2 / UPDATE. */
  maxUpdateBytes: 256 * 1024,
  /** Largest accepted awareness payload. Cursor state is tiny; this is slack. */
  maxAwarenessBytes: 16 * 1024,
  /** Largest accepted auth token. */
  maxTokenBytes: 4 * 1024,
  /** Largest document id, which also bounds the on-disk filename. */
  maxDocIdLength: 64,
} as const;

/** Document ids become filenames, so the character set is closed, not escaped. */
const DOC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidDocId(docId: string): boolean {
  return (
    docId.length > 0 &&
    docId.length <= LIMITS.maxDocIdLength &&
    DOC_ID_PATTERN.test(docId)
  );
}
