import { describe, expect, it } from "vitest";
import { cutToGrade } from "./profile";

/** Steepest run between consecutive stations, as a percentage. */
const steepest = (z: readonly number[], spacing: readonly number[]): number =>
  Math.max(
    ...z.slice(0, -1).map((v, i) => (Math.abs(z[i + 1] - v) / spacing[i]) * 100)
  );

/** Even 10 m stations, the spacing most cases below use. */
const evenly = (n: number): number[] => Array.from({ length: n - 1 }, () => 10);

describe("cutToGrade", () => {
  it("should return the profile unchanged when it has fewer than two stations", () => {
    const z = [12];
    expect(cutToGrade(z, [], 0.06)).toBe(z);
  });

  it("should leave the profile alone when it is already within the grade", () => {
    // 0.5 m over 10 m is 5%, inside a 6% cap.
    const z = [0, 0.5, 1, 1.5];
    expect(cutToGrade(z, evenly(4), 0.06)).toEqual(z);
  });

  /**
   * The defining property: whatever comes out is within the cap everywhere. A
   * 3 m step over 10 m is 30%, and the cap is 6%.
   */
  it.each([0.02, 0.06, 0.12])(
    "should bring every run inside the cap when the cap is %d",
    (cap) => {
      const z = [0, 3, 6, 6, 0, 9, 2];
      const out = cutToGrade(z, evenly(z.length), cap);
      expect(steepest(out, evenly(z.length))).toBeLessThanOrEqual(
        cap * 100 + 1e-9
      );
    }
  );

  /**
   * Cut, never fill. Filling would need a retaining structure this engine does
   * not model, so the graded road is always at or below natural ground — which
   * is also what keeps a road from being left hanging in the air.
   */
  it("should never raise a station above the natural ground when cutting", () => {
    const z = [0, 3, 6, 6, 0, 9, 2];
    const out = cutToGrade(z, evenly(z.length), 0.06);
    expect(out.every((v, i) => v <= z[i] + 1e-9)).toBe(true);
  });

  /**
   * Cutting only ever removes ground, so the lowest station cannot move: there
   * is nothing under it to cut down to. This is what stops the whole profile
   * from sinking on a long climb.
   */
  it("should hold the lowest station where it was when cutting a climb", () => {
    const z = [0, 3, 6, 9, 12];
    const out = cutToGrade(z, evenly(5), 0.06);
    expect(out[0]).toBeCloseTo(0, 9);
  });

  it("should shave a peak from both sides when it stands between two flats", () => {
    // A 9 m spike at station 2, 10 m from each neighbour, capped at 10%: the
    // peak can stand no more than 1 m above either side.
    const out = cutToGrade([0, 0, 9, 0, 0], evenly(5), 0.1);
    expect(out).toEqual([0, 0, 1, 0, 0]);
  });

  it("should take the spacing into account when stations are unevenly placed", () => {
    // The same 9 m spike, but now 100 m from its neighbours, so a 10% cap
    // allows the full 9 m and nothing is cut.
    const z = [0, 0, 9, 0, 0];
    expect(cutToGrade(z, [10, 100, 100, 10], 0.1)).toEqual(z);
  });

  it("should leave a dip alone when cutting cannot reach it", () => {
    // Filling is out of scope, so the valley floor stays and its shoulders come
    // down to meet it.
    const out = cutToGrade([10, 10, 0, 10, 10], evenly(5), 0.1);
    expect(out[2]).toBe(0);
  });

  it("should treat a zero-length run as no constraint when stations coincide", () => {
    const out = cutToGrade([0, 5, 5], [0, 10], 0.1);
    // Nothing separates the first two, so neither can be cut toward the other;
    // the 5 m step to the third is what the cap has to work on.
    expect(steepest(out.slice(1), [10])).toBeLessThanOrEqual(10 + 1e-9);
  });

  it("should be idempotent when applied twice", () => {
    const z = [0, 3, 6, 6, 0, 9, 2];
    const once = cutToGrade(z, evenly(z.length), 0.06);
    expect(cutToGrade(once, evenly(z.length), 0.06)).toEqual(once);
  });
});
