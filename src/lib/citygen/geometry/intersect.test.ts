import { describe, expect, it } from "vitest";
import { candidateSegmentPairs, segmentIntersection } from "./intersect";

describe("segmentIntersection", () => {
  it("should return the crossing point when both segments cross within their bounds", () => {
    const result = segmentIntersection(
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 4, y: 0 }
    );
    expect(result).toEqual({ kind: "point", point: { x: 2, y: 2 } });
  });

  it("should return none when the lines would cross only outside one segment's bounds", () => {
    const result = segmentIntersection(
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
      { x: 3, y: -1 }
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("should return none when the segments are parallel but not collinear", () => {
    const result = segmentIntersection(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 }
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("should return none when the first segment is degenerate (zero length)", () => {
    const result = segmentIntersection(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("should return none when the segments are collinear but do not overlap", () => {
    const result = segmentIntersection(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 }
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("should return the overlap range when the segments are collinear and overlapping", () => {
    const result = segmentIntersection(
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 0 },
      { x: 6, y: 0 }
    );
    expect(result).toEqual({
      kind: "collinear",
      overlapStart: { x: 2, y: 0 },
      overlapEnd: { x: 4, y: 0 },
    });
  });
});

describe("candidateSegmentPairs", () => {
  it("should yield one candidate pair when two segments share a bucket", () => {
    const segments = [
      { index: 0, a: { x: 1, y: 1 }, b: { x: 2, y: 2 } },
      { index: 1, a: { x: 3, y: 3 }, b: { x: 4, y: 4 } },
    ];
    expect(candidateSegmentPairs(segments, 10)).toEqual([[0, 1]]);
  });

  it("should yield no candidate pairs when two segments occupy disjoint buckets", () => {
    const segments = [
      { index: 0, a: { x: 1, y: 1 }, b: { x: 2, y: 2 } },
      { index: 1, a: { x: 100, y: 100 }, b: { x: 101, y: 101 } },
    ];
    expect(candidateSegmentPairs(segments, 1)).toEqual([]);
  });

  it("should yield each unordered pair exactly once when two segments share multiple buckets", () => {
    const segments = [
      { index: 0, a: { x: 0, y: 0 }, b: { x: 3, y: 3 } },
      { index: 1, a: { x: 0, y: 3 }, b: { x: 3, y: 0 } },
    ];
    expect(candidateSegmentPairs(segments, 1)).toEqual([[0, 1]]);
  });
});
