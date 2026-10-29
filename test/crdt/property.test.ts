import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { createReplicas, deliver, report } from '../support/crdt.js';

/**
 * Property-based convergence.
 *
 * The CRDT guarantee is not "these four scenarios work", it is: for *any*
 * sequence of operations, delivered in *any* order, any number of times, every
 * replica that has seen every operation holds identical state. That is a
 * statement with a quantifier in it, so it gets a quantified test.
 *
 * `fast-check` generates the operations and the delivery schedule; a failure
 * shrinks to a minimal counterexample with a printable seed.
 */

type Op =
  | { kind: 'insert'; replica: number; position: number; text: string }
  | { kind: 'delete'; replica: number; position: number; length: number };

const opArbitrary = (replicaCount: number): fc.Arbitrary<Op> =>
  fc.oneof(
    fc.record({
      kind: fc.constant('insert' as const),
      replica: fc.integer({ min: 0, max: replicaCount - 1 }),
      position: fc.nat({ max: 200 }),
      text: fc.string({ minLength: 1, maxLength: 6 }),
    }),
    fc.record({
      kind: fc.constant('delete' as const),
      replica: fc.integer({ min: 0, max: replicaCount - 1 }),
      position: fc.nat({ max: 200 }),
      length: fc.integer({ min: 1, max: 5 }),
    }),
  );

interface Frame {
  from: number;
  update: Uint8Array;
}

/**
 * Run the operations locally, collecting what each replica emitted, then hand
 * the frames to the caller to deliver however it wants.
 */
function applyLocally(
  replicas: ReturnType<typeof createReplicas>,
  ops: Op[],
): Frame[] {
  const frames: Frame[] = [];
  const seen = replicas.map(() => 0);
  for (const op of ops) {
    const replica = replicas[op.replica];
    if (replica === undefined) continue;
    const length = replica.text.length;
    if (op.kind === 'insert') {
      replica.text.insert(Math.min(op.position, length), op.text);
    } else {
      if (length === 0) continue;
      const start = Math.min(op.position, length - 1);
      replica.text.delete(start, Math.min(op.length, length - start));
    }
  }
  // Collect in production order per replica; the delivery schedule is free to
  // reorder them afterwards.
  for (const [index, replica] of replicas.entries()) {
    for (let i = seen[index] ?? 0; i < replica.produced.length; i += 1) {
      frames.push({ from: index, update: replica.produced[i] as Uint8Array });
    }
  }
  return frames;
}

/**
 * Evidence that the property runs are not vacuous.
 *
 * `new Set(texts).size === 1` is satisfied by three empty documents, so every
 * property below also records what it actually exercised and asserts
 * afterwards that the generator produced real documents and real divergence.
 */
interface Coverage {
  runs: number;
  diverged: number;
  longestText: number;
  framesDelivered: number;
}

function newCoverage(): Coverage {
  return { runs: 0, diverged: 0, longestText: 0, framesDelivered: 0 };
}

function expectMeaningfulCoverage(coverage: Coverage, minRuns: number): void {
  expect(coverage.runs).toBeGreaterThanOrEqual(minRuns);
  expect(
    coverage.diverged,
    'no generated run ever produced divergent replicas, so convergence was never tested',
  ).toBeGreaterThan(0);
  expect(
    coverage.longestText,
    'the generator never built a document of any size',
  ).toBeGreaterThan(20);
  expect(coverage.framesDelivered).toBeGreaterThan(coverage.runs);
}

describe('property: any operation sequence in any delivery order converges', () => {
  it('holds for 2 replicas with duplicated, reordered delivery', () => {
    const coverage = newCoverage();
    fc.assert(
      fc.property(
        fc.array(opArbitrary(2), { minLength: 1, maxLength: 25 }),
        fc.array(fc.nat({ max: 200 }), { minLength: 1, maxLength: 60 }),
        fc.array(fc.boolean(), { maxLength: 60 }),
        (ops, order, duplicates) => {
          const replicas = createReplicas(2);
          const frames = applyLocally(replicas, ops);
          recordPreDelivery(coverage, replicas, frames);
          deliverScrambled(replicas, frames, order, duplicates);

          const { texts, stateHex } = report(replicas);
          coverage.longestText = Math.max(
            coverage.longestText,
            texts[0]?.length ?? 0,
          );
          expect(new Set(texts).size).toBe(1);
          expect(new Set(stateHex).size).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
    expectMeaningfulCoverage(coverage, 200);
  });

  it('holds for 4 replicas, which is where naive merge strategies break', () => {
    const coverage = newCoverage();
    fc.assert(
      fc.property(
        fc.array(opArbitrary(4), { minLength: 2, maxLength: 40 }),
        fc.array(fc.nat({ max: 400 }), { minLength: 1, maxLength: 120 }),
        fc.array(fc.boolean(), { maxLength: 120 }),
        (ops, order, duplicates) => {
          const replicas = createReplicas(4);
          const frames = applyLocally(replicas, ops);
          recordPreDelivery(coverage, replicas, frames);
          deliverScrambled(replicas, frames, order, duplicates);

          const { texts, stateHex } = report(replicas);
          coverage.longestText = Math.max(
            coverage.longestText,
            texts[0]?.length ?? 0,
          );
          expect(new Set(texts).size).toBe(1);
          expect(new Set(stateHex).size).toBe(1);
        },
      ),
      { numRuns: 120 },
    );
    expectMeaningfulCoverage(coverage, 120);
  });

  it('holds when every replica is also force-synced by state vector at the end', () => {
    const coverage = newCoverage();
    fc.assert(
      fc.property(
        fc.array(opArbitrary(3), { minLength: 1, maxLength: 30 }),
        (ops) => {
          const replicas = createReplicas(3);
          recordPreDelivery(coverage, replicas, applyLocally(replicas, ops));
          // Only the state-vector handshake, no raw frames at all: the
          // reconnect path on its own must be sufficient.
          for (let pass = 0; pass < 2; pass += 1) {
            for (const a of replicas) {
              for (const b of replicas) {
                if (a === b) continue;
                deliver(
                  b,
                  Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
                );
              }
            }
          }
          const { texts, stateHex } = report(replicas);
          coverage.longestText = Math.max(
            coverage.longestText,
            texts[0]?.length ?? 0,
          );
          expect(new Set(texts).size).toBe(1);
          expect(new Set(stateHex).size).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
    expectMeaningfulCoverage(coverage, 200);
  });
});

function recordPreDelivery(
  coverage: Coverage,
  replicas: ReturnType<typeof createReplicas>,
  frames: Frame[],
): void {
  coverage.runs += 1;
  coverage.framesDelivered += frames.length;
  if (new Set(report(replicas).stateHex).size > 1) coverage.diverged += 1;
}

/**
 * Deliver every frame to every replica that did not produce it, in an order
 * driven by the generated schedule, duplicating some frames.
 *
 * Crucially *all* frames are delivered — the property is about eventual
 * consistency, and a replica that never receives an operation is entitled to
 * differ.
 */
function deliverScrambled(
  replicas: ReturnType<typeof createReplicas>,
  frames: Frame[],
  order: number[],
  duplicates: boolean[],
): void {
  const schedule: Frame[] = [];
  const remaining = [...frames];
  let cursor = 0;
  while (remaining.length > 0) {
    const pick = (order[cursor % order.length] ?? 0) % remaining.length;
    const [frame] = remaining.splice(pick, 1);
    if (frame === undefined) break;
    schedule.push(frame);
    if (duplicates[cursor % Math.max(1, duplicates.length)] === true) {
      schedule.push(frame);
    }
    cursor += 1;
  }
  for (const frame of schedule) {
    for (const [index, replica] of replicas.entries()) {
      if (index === frame.from) continue;
      deliver(replica, frame.update);
    }
  }
}
