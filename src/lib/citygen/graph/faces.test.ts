import { describe, expect, it } from "vitest";
import { comparePseudoAngle, traverseFaces } from "./faces";
import type { FaceGraphEdge, FaceGraphNode } from "./faces";

// A(0,0) - B(4,0) - C(0,4), one triangle: exactly one bounded face (CCW,
// signed area +8) and one outer face (reversed orientation, signed area -8).
const triangleNodes: readonly FaceGraphNode[] = [
  { id: 0, pos: { x: 0, y: 0 } },
  { id: 1, pos: { x: 4, y: 0 } },
  { id: 2, pos: { x: 0, y: 4 } },
];

const triangleEdges: readonly FaceGraphEdge[] = [
  { id: 0, a: 0, b: 1 },
  { id: 1, a: 1, b: 2 },
  { id: 2, a: 2, b: 0 },
];

// A(0,0) - B(4,0) - C(4,4) - D(0,4) square with diagonal A-C: two bounded
// triangles plus one outer face.
const squareNodes: readonly FaceGraphNode[] = [
  { id: 0, pos: { x: 0, y: 0 } },
  { id: 1, pos: { x: 4, y: 0 } },
  { id: 2, pos: { x: 4, y: 4 } },
  { id: 3, pos: { x: 0, y: 4 } },
];

const squareEdges: readonly FaceGraphEdge[] = [
  { id: 0, a: 0, b: 1 },
  { id: 1, a: 1, b: 2 },
  { id: 2, a: 2, b: 3 },
  { id: 3, a: 3, b: 0 },
  { id: 4, a: 0, b: 2 },
];

describe("traverseFaces", () => {
  it("should find exactly two faces when walking a triangle", () => {
    const result = traverseFaces(triangleNodes, triangleEdges);
    expect(result.faces).toHaveLength(2);
  });

  it("should trace the inner triangle face with positive signed area when walking a triangle", () => {
    const result = traverseFaces(triangleNodes, triangleEdges);
    const inner = result.faces.find((face) => !face.isOuter);
    expect(inner).toEqual({
      nodeIds: [0, 1, 2],
      edgeIds: [0, 1, 2],
      signedArea: 8,
      isOuter: false,
    });
  });

  it("should identify the outer face by its negative signed area when walking a triangle", () => {
    const result = traverseFaces(triangleNodes, triangleEdges);
    const outer = result.faces[result.outerFaceIndex];
    expect(outer).toEqual({
      nodeIds: [1, 0, 2],
      edgeIds: [0, 2, 1],
      signedArea: -8,
      isOuter: true,
    });
  });

  it("should find exactly three faces when a diagonal splits a square into two triangles", () => {
    const result = traverseFaces(squareNodes, squareEdges);
    expect(result.faces).toHaveLength(3);
  });

  it("should identify exactly one outer face when several bounded faces exist", () => {
    const result = traverseFaces(squareNodes, squareEdges);
    expect(result.faces.filter((face) => face.isOuter)).toHaveLength(1);
  });

  it("should sum every face's signed area to zero when the outer face balances the bounded faces", () => {
    const result = traverseFaces(squareNodes, squareEdges);
    const total = result.faces.reduce((sum, face) => sum + face.signedArea, 0);
    expect(total).toBeCloseTo(0);
  });

  it("should throw when an edge references a node id absent from the node list", () => {
    const badEdges: readonly FaceGraphEdge[] = [{ id: 0, a: 0, b: 999 }];
    expect(() => traverseFaces(triangleNodes, badEdges)).toThrow(
      "faces: node position not found for key 999"
    );
  });
});

describe("comparePseudoAngle", () => {
  it("should order the first vector before the second when its cross product is positive", () => {
    expect(comparePseudoAngle(4, 0, 0, 4)).toBeLessThan(0);
  });

  it("should order the other way when the cross product sign is reversed", () => {
    expect(comparePseudoAngle(0, 4, 4, 0)).toBeGreaterThan(0);
  });

  it("should order a lower half-plane vector after an upper half-plane vector when the halves differ", () => {
    expect(comparePseudoAngle(-4, 0, -4, 4)).toBeGreaterThan(0);
  });

  it("should return zero when two vectors are collinear and equal", () => {
    expect(comparePseudoAngle(3, 3, 3, 3)).toBe(0);
  });
});

/**
 * `Array.prototype.sort` is only deterministic for a comparator that is a strict
 * weak ordering; hand it an inconsistent one and the permutation it returns is
 * implementation-defined. That is not theoretical here — until 2026-08-04 a
 * self-loop arterial put a zero vector in one node's rotation, and the same seed
 * produced a different city under vitest and under bun as a result.
 *
 * So the axioms are asserted directly, over a fixture that includes the zero
 * vector and two pairs sharing a bearing. Brute force over triples is affordable
 * at this size and does not depend on guessing which triple breaks.
 */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 0],
  [4, 0],
  [8, 0],
  [4, 4],
  [2, 2],
  [0, 4],
  [-4, 4],
  [-4, 0],
  [-4, -4],
  [0, -4],
  [4, -4],
];

const sgn = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

const cmp = (
  a: readonly [number, number],
  b: readonly [number, number]
): number => comparePseudoAngle(a[0], a[1], b[0], b[1]);

const pairs = DIRECTIONS.flatMap((a) => DIRECTIONS.map((b) => [a, b] as const));

const triples = DIRECTIONS.flatMap((a) =>
  DIRECTIONS.flatMap((b) => DIRECTIONS.map((c) => [a, b, c] as const))
);

const label = (v: readonly [number, number]): string => `(${v[0]},${v[1]})`;

describe("comparePseudoAngle as a strict weak ordering", () => {
  it("should reverse its sign when the two arguments swap for every pair", () => {
    const violations = pairs
      .filter(([a, b]) => sgn(cmp(a, b)) !== -sgn(cmp(b, a)))
      .map(([a, b]) => `${label(a)}/${label(b)}`);
    expect(violations).toEqual([]);
  });

  it("should stay transitive when every triple of directions is compared", () => {
    const violations = triples
      .filter(
        ([a, b, c]) =>
          sgn(cmp(a, b)) < 0 && sgn(cmp(b, c)) < 0 && sgn(cmp(a, c)) >= 0
      )
      .map(([a, b, c]) => `${label(a)}<${label(b)}<${label(c)}`);
    expect(violations).toEqual([]);
  });

  it("should keep equivalence transitive when every triple is compared", () => {
    const violations = triples
      .filter(
        ([a, b, c]) =>
          cmp(a, b) === 0 && cmp(b, c) === 0 && sgn(cmp(a, c)) !== 0
      )
      .map(([a, b, c]) => `${label(a)}~${label(b)}~${label(c)}`);
    expect(violations).toEqual([]);
  });
});

/**
 * Embedding invariance: the faces are a property of the graph, not of the order
 * its edges were listed in.
 *
 * Worth pinning in its own right, and it is *not* the regression guard for the
 * zero-vector defect above — measured, because the first version of this test
 * claimed to be. Reverting `half`'s zero class leaves this test green on this
 * fixture: node 5's group has only four half-edges, and every one of the 24
 * orderings still lands on the same canonical faces even with the comparator
 * cycling. The axiom tests above are what fail. A fixture large enough to
 * discriminate would need a wider rotation, and the real one that did — node 28 on
 * `akiba-02` — is not reducible to a readable fixture.
 *
 * Node ids are still chosen adversarially: at node 5 the real targets are 9
 * (bearing 0) and 1 (bearing 90) and the self-loop's own id sits between them, so
 * the tie-break contradicts the angular order and the comparator cycled
 * 1 < 5 < 9 < 1 before the fix.
 */
const loopNodes: readonly FaceGraphNode[] = [
  { id: 5, pos: { x: 0, y: 0 } },
  { id: 9, pos: { x: 4, y: 0 } },
  { id: 1, pos: { x: 0, y: 4 } },
];

const loopEdges: readonly FaceGraphEdge[] = [
  { id: 0, a: 5, b: 9 },
  { id: 1, a: 9, b: 1 },
  { id: 2, a: 1, b: 5 },
  { id: 3, a: 5, b: 5 },
];

/**
 * One cycle, written the same way whatever vertex the walk happened to start at.
 *
 * `buildHalfEdges` keys ids off each edge's index in the array it is handed and
 * `collectFaceCycles` starts each walk at the first unvisited half-edge, so
 * reordering the edge list legitimately rotates a face's `nodeIds` and reorders
 * the face array. Neither is a different embedding, and comparing the raw strings
 * would report both as one — which is what the first version of this test did.
 */
const canonicalCycle = (ids: readonly number[]): string => {
  const start = ids.indexOf(Math.min(...ids));
  return [...ids.slice(start), ...ids.slice(0, start)].join(",");
};

const boundedOf = (edges: readonly FaceGraphEdge[]): string =>
  traverseFaces(loopNodes, edges)
    .faces.filter((face) => !face.isOuter)
    .map((face) => canonicalCycle(face.nodeIds))
    .toSorted()
    .join(" | ");

const permutations = <T>(items: readonly T[]): readonly (readonly T[])[] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(
          (rest) => [item, ...rest] as readonly T[]
        )
      );

describe("traverseFaces with a self-loop present", () => {
  /** Every ordering, not two hand-picked ones. */
  it("should trace the same bounded faces when the edge list arrives in any order", () => {
    const results = permutations(loopEdges).map(boundedOf);
    expect(new Set(results).size).toBe(1);
  });
});
