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
