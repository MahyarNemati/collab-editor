import { expect } from 'vitest';
import * as Y from 'yjs';

export const TEXT_KEY = 'body';

export interface Replica {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  /** Every update this replica has produced, in the order it produced them. */
  readonly produced: Uint8Array[];
}

export function createReplica(id: string): Replica {
  const doc = new Y.Doc();
  const produced: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    // Updates applied *to* this replica carry an origin; only edits made here
    // are its own output.
    if (origin === 'remote') return;
    produced.push(update);
  });
  return { id, doc, text: doc.getText(TEXT_KEY), produced };
}

export function createReplicas(count: number): Replica[] {
  return Array.from({ length: count }, (_, i) =>
    createReplica(String.fromCharCode(97 + i)),
  );
}

export function deliver(target: Replica, update: Uint8Array): void {
  Y.applyUpdate(target.doc, update, 'remote');
}

/**
 * Full bidirectional sync, the way a reconnecting client does it: exchange
 * state vectors and send only the difference.
 */
export function syncPair(a: Replica, b: Replica): void {
  const updateForB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
  const updateForA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
  deliver(b, updateForB);
  deliver(a, updateForA);
}

export function syncAll(replicas: Replica[]): void {
  // Two passes: with three or more replicas, one pass leaves the last pair
  // unaware of what the first pair learned in the same pass.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const a of replicas) {
      for (const b of replicas) {
        if (a !== b) syncPair(a, b);
      }
    }
  }
}

export interface ConvergenceReport {
  texts: string[];
  stateHex: string[];
}

export function report(replicas: Replica[]): ConvergenceReport {
  return {
    texts: replicas.map((r) => r.text.toString()),
    stateHex: replicas.map((r) =>
      Buffer.from(Y.encodeStateAsUpdate(r.doc)).toString('hex'),
    ),
  };
}

/**
 * Assert the actual CRDT guarantee.
 *
 * Equal text is necessary but not sufficient: two replicas can render the same
 * string from different internal histories and then diverge on the next edit.
 * So this also requires the encoded state — every struct and the delete set —
 * to be byte-identical, which is the property that makes further convergence
 * inevitable.
 */
export function expectConverged(replicas: Replica[]): string {
  const { texts, stateHex } = report(replicas);
  const [firstText, ...otherTexts] = texts;
  for (const [index, text] of otherTexts.entries()) {
    expect(
      text,
      `replica ${replicas[index + 1]?.id} text differs from ${replicas[0]?.id}`,
    ).toBe(firstText);
  }
  const [firstState, ...otherStates] = stateHex;
  for (const [index, state] of otherStates.entries()) {
    expect(
      state,
      `replica ${replicas[index + 1]?.id} encoded state differs from ${replicas[0]?.id}`,
    ).toBe(firstState);
  }
  // Guard against a vacuous pass: a suite that converged three empty documents
  // has proved nothing.
  expect(firstText, 'converged on an empty document').not.toBe('');
  return firstText ?? '';
}

/** Deterministic xorshift, so a failing property shrinks to a reproducible case. */
export function makeRandom(seed: number): () => number {
  let state = seed || 0x2545f491;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}
