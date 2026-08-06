import type { Building } from "@/entities/city";
import { describe, expect, it } from "vitest";
import { assemblyFor, expandKit, type KitMetrics } from "./expandKit";

/** The authored corpoTower kit, as measured off its GLB. */
const PART_HEIGHTS = { base: 8, floor: 3.6, crown: 6 } as const;

const METRICS: KitMetrics = {
  partHeights: PART_HEIGHTS,
  footprint: { x: 32, z: 32 },
};

const building = (overrides: Partial<Building> = {}): Building => ({
  id: 0,
  archetype: "corpoTower",
  obb: { cx: 100, cy: 200, facing: { x: 1, y: 0 }, w: 32, d: 32 },
  heightM: 100,
  baseZM: 10,
  tiers: [{ heightFrac: 1, insetFrac: 0 }],
  lotId: 0,
  blockId: 0,
  ...overrides,
});

/** The height the assembly actually reaches, from its own parts and scales. */
const assembledHeight = (heightM: number): number => {
  const a = assemblyFor(heightM, PART_HEIGHTS);
  return (
    PART_HEIGHTS.base * a.baseScale +
    PART_HEIGHTS.floor * a.floorScale * a.floors +
    PART_HEIGHTS.crown * a.crownScale
  );
};

describe("assemblyFor", () => {
  it("should round the shaft to a whole number of floors when the height allows one", () => {
    // 100 - 8 - 6 = 86 m of shaft, 86 / 3.6 = 23.9.
    expect(assemblyFor(100, PART_HEIGHTS).floors).toBe(24);
  });

  /**
   * The property the whole design rests on: `heightM` keeps one authority, so a
   * kit-built tower is exactly as tall as the model says however the floors
   * round. Asserted across the corpoTower height range measured on akiba-01
   * (p10 104 m to p90 218 m) plus both ends of the degenerate case.
   */
  it.each([4, 13.9, 14, 14.1, 20, 104, 136.6, 217.7, 400])(
    "should reach exactly the model's height when it is %s m",
    (heightM) => {
      expect(assembledHeight(heightM)).toBeCloseTo(heightM, 6);
    }
  );

  it("should keep every part at its authored height when the shaft divides evenly", () => {
    // 8 + 3.6 * 10 + 6 = 50 m needs no correction anywhere.
    expect(assemblyFor(50, PART_HEIGHTS)).toEqual({
      floors: 10,
      baseScale: 1,
      floorScale: 1,
      crownScale: 1,
    });
  });

  /**
   * Too short to hold a base, a floor and a crown at their authored heights. The
   * whole assembly shrinks together rather than the crown being driven down
   * through the base, which is what any per-part correction would do here.
   */
  it("should scale every part together when the building is shorter than one storey of kit", () => {
    const a = assemblyFor(8.8, PART_HEIGHTS);
    expect(a).toEqual({
      floors: 1,
      baseScale: 0.5,
      floorScale: 0.5,
      crownScale: 0.5,
    });
  });

  /**
   * The invariant that lets the second branch round without a clamp: just past
   * the point where the parts fit at their authored heights, the shaft is still
   * a whole floor, so the rounding cannot land on zero. 17.7 m is the smallest
   * height these part sizes admit to that branch.
   */
  it("should still yield a floor when the height only just clears one storey of kit", () => {
    expect(assemblyFor(17.7, PART_HEIGHTS).floors).toBe(1);
  });
});

describe("expandKit", () => {
  it("should emit one base, one crown and one instance per floor when a building is expanded", () => {
    const result = expandKit([building()], METRICS);
    expect({
      base: result.base.count,
      floor: result.floor.count,
      crown: result.crown.count,
    }).toEqual({ base: 1, floor: 24, crown: 1 });
  });

  it("should stand the base on the model's own base height when a building is expanded", () => {
    const result = expandKit([building({ baseZM: 10 })], METRICS);
    // Column-major: index 13 is the Y translation.
    expect(result.base.matrices[13]).toBeCloseTo(10, 6);
  });

  it("should put the crown on top of the floor stack when the parts are placed", () => {
    const result = expandKit([building({ heightM: 100, baseZM: 10 })], METRICS);
    const a = assemblyFor(100, PART_HEIGHTS);
    const expected =
      10 +
      PART_HEIGHTS.base * a.baseScale +
      PART_HEIGHTS.floor * a.floorScale * a.floors;
    expect(result.crown.matrices[13]).toBeCloseTo(expected, 6);
  });

  /**
   * The horizontal normalisation is one factor for the whole kit, taken from its
   * widest part, so the assembly fits inside the OBB that `fitWithin` already
   * shrank to clear the roads — and the plinth keeps oversailing the shaft by the
   * proportion it was authored with.
   */
  it("should scale every part by the same factor when the footprint is normalised", () => {
    const result = expandKit(
      [
        building({
          obb: { cx: 0, cy: 0, facing: { x: 1, y: 0 }, w: 16, d: 64 },
        }),
      ],
      METRICS
    );
    expect({
      baseX: result.base.matrices[0],
      floorX: result.floor.matrices[0],
      crownZ: result.crown.matrices[10],
    }).toEqual({ baseX: 0.5, floorX: 0.5, crownZ: 2 });
  });

  it("should turn every part with the building when it faces along another axis", () => {
    const result = expandKit(
      [
        building({
          obb: { cx: 0, cy: 0, facing: { x: 0, y: 1 }, w: 32, d: 32 },
        }),
      ],
      METRICS
    );
    // facing (0,1): local +X maps to world +Y, so column 0 is (0, 0, 1).
    expect([result.base.matrices[0], result.base.matrices[2]]).toEqual([0, 1]);
  });

  it("should record contiguous instance ranges per block when several blocks are expanded", () => {
    const result = expandKit(
      [
        building({ id: 1, blockId: 7, heightM: 50 }),
        building({ id: 0, blockId: 3, heightM: 50 }),
      ],
      METRICS
    );
    // Sorted by blockId then id, so block 3's floors come first.
    expect([...result.floor.blockRanges.entries()]).toEqual([
      [3, [0, 10]],
      [7, [10, 20]],
    ]);
  });

  it("should return empty buffers when there is nothing to expand", () => {
    const result = expandKit([], METRICS);
    expect({
      count: result.floor.count,
      matrices: result.floor.matrices.length,
      ranges: result.floor.blockRanges.size,
    }).toEqual({ count: 0, matrices: 0, ranges: 0 });
  });
});
