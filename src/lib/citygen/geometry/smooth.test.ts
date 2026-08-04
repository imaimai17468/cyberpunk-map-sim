import { describe, expect, it } from "vitest";
import { length, sub } from "./vec";
import { smoothPolyline } from "./smooth";

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Every turn on a polyline, as the sine of its half-angle — `smooth.ts`'s `k`. */
const halfTurnSines = (points: readonly Point[]): number[] =>
  points.slice(1, -1).map((vertex, i) => {
    const into = sub(vertex, points[i]);
    const outOf = sub(points[i + 2], vertex);
    const d1 = { x: into.x / length(into), y: into.y / length(into) };
    const d2 = { x: outOf.x / length(outOf), y: outOf.y / length(outOf) };
    return length(sub(d2, d1)) / 2;
  });

const chordLengths = (points: readonly Point[]): number[] =>
  points.slice(0, -1).map((p, i) => length(sub(points[i + 1], p)));

const distanceToSegment = (p: Point, a: Point, b: Point): number => {
  const ab = sub(b, a);
  const raw =
    ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y);
  const u = Math.min(1, Math.max(0, raw));
  return length(sub(p, { x: a.x + ab.x * u, y: a.y + ab.y * u }));
};

/**
 * How far the smoothed line departs from the original one.
 *
 * The quantity the deviation budget is about, and not the distance to the vertex:
 * the fillet's tangent points stand `t` from the vertex while lying exactly on a
 * leg, so measuring against the vertex reports the tangent length rather than any
 * departure.
 */
const departureFrom = (
  original: readonly Point[],
  smoothed: readonly Point[]
): number =>
  Math.max(
    ...smoothed.map((p) =>
      Math.min(
        ...original
          .slice(0, -1)
          .map((a, i) => distanceToSegment(p, a, original[i + 1]))
      )
    )
  );

/** A right angle between 100 m legs: the corner the fillet works hardest on. */
const RIGHT_ANGLE: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
];

describe("smoothPolyline", () => {
  it("should return the polyline unchanged when it has fewer than three points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(smoothPolyline(points, { maxDeviationM: 8, maxChordM: 6 })).toBe(
      points
    );
  });

  it("should smooth nothing when dropping duplicates leaves fewer than three points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(smoothPolyline(points, { maxDeviationM: 8, maxChordM: 6 })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it("should pin both endpoints when a corner between them is rounded", () => {
    const result = smoothPolyline(RIGHT_ANGLE, {
      maxDeviationM: 8,
      maxChordM: 6,
    });
    expect([result[0], result[result.length - 1]]).toEqual([
      RIGHT_ANGLE[0],
      RIGHT_ANGLE[2],
    ]);
  });

  it("should leave the vertex exactly where it is when the run through it is straight", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(smoothPolyline(points, { maxDeviationM: 8, maxChordM: 6 })).toEqual(
      points
    );
  });

  /**
   * With opposite directions the fillet's two tangent points coincide on one ray,
   * so the curve would run out from the vertex and fold back along itself — a
   * self-intersecting road where there was a hairpin. The generator has never
   * produced one (`roadRibbons.ts` records the same case and the same
   * measurement), so this pins a decision rather than describing live geometry.
   */
  it("should leave the vertex unsmoothed when the two directions are an exact reversal", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
    ];
    expect(smoothPolyline(points, { maxDeviationM: 8, maxChordM: 6 })).toEqual(
      points
    );
  });

  it.each([1, 4, 8, 20])(
    "should hold the curve within the budget when the deviation cap is %d m",
    (maxDeviationM) => {
      const result = smoothPolyline(RIGHT_ANGLE, {
        maxDeviationM,
        maxChordM: 1,
      });
      expect(departureFrom(RIGHT_ANGLE, result)).toBeLessThanOrEqual(
        maxDeviationM + 1e-9
      );
    }
  );

  it("should reach the full tangent length when the budget is not the binding cap", () => {
    const result = smoothPolyline(RIGHT_ANGLE, {
      maxDeviationM: 1000,
      maxChordM: 0.25,
    });
    // Clamped by the 100 m legs to 50 m of tangent. Measured over the fillet's own
    // samples, not the pinned endpoints, which stand 100 m off.
    expect(
      Math.max(
        ...result.slice(1, -1).map((p) => length(sub(p, RIGHT_ANGLE[1])))
      )
    ).toBeCloseTo(50, 9);
  });

  /**
   * The budget is spent against the vertex, and this pins the gap between that and
   * the real movement. Here the segments bind, not the budget: 100 m legs give 50 m
   * of tangent, so `t·k/2` puts the curve's midpoint 17.68 m from the vertex while
   * `t·k·√(1-k²)/2` puts it 12.5 m from the legs. The case below pins the other
   * pair, where the budget is what binds.
   */
  it("should depart from the legs by less than its distance from the vertex when the segments are the binding cap", () => {
    const result = smoothPolyline(RIGHT_ANGLE, {
      maxDeviationM: 1000,
      maxChordM: 0.25,
    });
    const k = Math.SQRT1_2;
    expect(departureFrom(RIGHT_ANGLE, result)).toBeCloseTo(
      (50 * k * Math.sqrt(1 - k * k)) / 2,
      2
    );
  });

  /**
   * `smooth.ts`'s own worked example, pinned: budget 12.5 m at a right angle takes
   * `t = 2·12.5/k` ≈ 35.36 m, which is inside the 50 m the legs would allow, so the
   * budget binds and the road moves 8.84 m rather than the 12.5 m asked for.
   *
   * The chord is 0.5 m so that `steps = ceil(2t/chord)` comes out even (142) and
   * `u = 0.5` is one of the samples. That matters more than it looks: departure from
   * the legs goes as `min(u², (1-u)²)`, which has a corner at `u = 0.5` rather than a
   * smooth maximum, so a sampling that straddles it misses the peak to first order —
   * at 0.25 m, `steps` is 283, the nearest sample sits at `u = 0.49823`, and the
   * polyline reads 8.78 m. That is the honest departure of the line as emitted, and
   * it is not the analytic figure this case is here to pin.
   */
  it("should spend only √(1-k²) of the budget when the budget is the binding cap", () => {
    const result = smoothPolyline(RIGHT_ANGLE, {
      maxDeviationM: 12.5,
      maxChordM: 0.5,
    });
    expect(departureFrom(RIGHT_ANGLE, result)).toBeCloseTo(8.84, 2);
  });

  it("should clamp the tangent length to half the shorter segment when the budget would allow more", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 1000 },
    ];
    const result = smoothPolyline(points, {
      maxDeviationM: 1000,
      maxChordM: 1,
    });
    // Half of the 10 m segment is 5 m, so the curve starts there rather than at
    // the 500 m the long segment on the other side would allow.
    expect(result[1]).toEqual({ x: 5, y: 0 });
  });

  it("should produce no zero-length segment when two fillets each consume half of the segment they share", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 120, y: 20 },
      { x: 120, y: 200 },
    ];
    const result = smoothPolyline(points, {
      maxDeviationM: 1000,
      maxChordM: 4,
    });
    expect(Math.min(...chordLengths(result))).toBeGreaterThan(0);
  });

  it.each([1, 4, 6])(
    "should sample the curve into chords no longer than the cap when it is %d m",
    (maxChordM) => {
      const result = smoothPolyline(RIGHT_ANGLE, {
        maxDeviationM: 40,
        maxChordM,
      });
      // The two straight legs are excluded deliberately — see the next case.
      expect(
        Math.max(...chordLengths(result).slice(1, -1))
      ).toBeLessThanOrEqual(maxChordM + 1e-9);
    }
  );

  /**
   * Chord sampling exists to stop the curve reading as a chain of facets. A
   * straight run has nothing to face, and cutting it up would add vertices every
   * downstream stage pays for — `blocks.ts` makes a face-graph node of each — to
   * represent no detail. On this fixture the fillet takes half of each 100 m leg,
   * so the first and last chord are the 50 m that stayed straight.
   */
  it("should leave the straight legs uncut when the curve between them is sampled finely", () => {
    const legs = chordLengths(
      smoothPolyline(RIGHT_ANGLE, { maxDeviationM: 40, maxChordM: 1 })
    );
    expect([legs[0], legs[legs.length - 1]]).toEqual([50, 50]);
  });

  /**
   * The point of the whole exercise. Stated as a bound on the sharpest turn rather
   * than on their sum, which cannot change — the road still gets from one bearing
   * to the other. `Math.SQRT1_2` is the fixture's own single 90-degree turn.
   */
  it("should replace a sharp corner with turns a quarter its size when the chord cap allows the samples", () => {
    const result = smoothPolyline(RIGHT_ANGLE, {
      maxDeviationM: 8,
      maxChordM: 6,
    });
    expect(Math.max(...halfTurnSines(result))).toBeLessThan(Math.SQRT1_2 / 4);
  });

  it("should leave the polyline where it is when the deviation budget is zero", () => {
    expect(
      smoothPolyline(RIGHT_ANGLE, { maxDeviationM: 0, maxChordM: 6 })
    ).toEqual([...RIGHT_ANGLE]);
  });
});
