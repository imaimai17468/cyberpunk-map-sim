import { describe, expect, it } from "vitest";
import type {
  Building,
  BuildingArchetype,
  BuildingTier,
} from "@/entities/city";
import { packInstances, totalInstanceCount } from "./assemble";

const building = (
  overrides: Partial<Building> & Pick<Building, "id" | "blockId">
): Building => ({
  archetype: "corpoTower",
  obb: { cx: 10, cy: 20, facing: { x: 1, y: 0 }, w: 4, d: 6 },
  heightM: 100,
  baseZM: 5,
  tiers: [{ heightFrac: 1, insetFrac: 0 }],
  lotId: 0,
  ...overrides,
});

const tiers = (...specs: readonly BuildingTier[]): readonly BuildingTier[] =>
  specs;

const matrixOf = (
  buildings: readonly Building[],
  archetype: BuildingArchetype,
  index: number
): readonly number[] => [
  ...packInstances(buildings)[archetype].matrices.subarray(
    index * 16,
    index * 16 + 16
  ),
];

describe("packInstances", () => {
  it("should produce an empty buffer for every archetype when there are no buildings", () => {
    expect(totalInstanceCount(packInstances([]))).toBe(0);
  });

  it("should produce one instance when a building has a single tier", () => {
    expect(
      packInstances([building({ id: 0, blockId: 0 })]).corpoTower.count
    ).toBe(1);
  });

  it("should produce one instance per tier when a building is tiered", () => {
    const tiered = building({
      id: 0,
      blockId: 0,
      archetype: "megabuilding",
      tiers: tiers(
        { heightFrac: 0.5, insetFrac: 0 },
        { heightFrac: 0.3, insetFrac: 0.2 },
        { heightFrac: 0.2, insetFrac: 0.4 }
      ),
    });
    expect(packInstances([tiered]).megabuilding.count).toBe(3);
  });

  it("should route each building to its own archetype buffer when archetypes differ", () => {
    const mixed = [
      building({ id: 0, blockId: 0, archetype: "casino" }),
      building({ id: 1, blockId: 0, archetype: "slumShack" }),
    ];
    const packed = packInstances(mixed);
    expect([packed.casino.count, packed.slumShack.count]).toEqual([1, 1]);
  });

  it("should write sixteen floats per instance when packing", () => {
    expect(
      packInstances([building({ id: 0, blockId: 0 })]).corpoTower.matrices
        .length
    ).toBe(16);
  });
});

describe("instance matrix", () => {
  it("should place the translation at the lot centre and base when packing", () => {
    const m = matrixOf([building({ id: 0, blockId: 0 })], "corpoTower", 0);
    expect([m[12], m[13], m[14], m[15]]).toEqual([10, 5, 20, 1]);
  });

  it("should scale the vertical axis by the tier height when packing", () => {
    const m = matrixOf([building({ id: 0, blockId: 0 })], "corpoTower", 0);
    expect(m[5]).toBe(100);
  });

  it("should map local X onto the facing vector when the building is rotated", () => {
    const rotated = building({
      id: 0,
      blockId: 0,
      obb: { cx: 0, cy: 0, facing: { x: 0, y: 1 }, w: 2, d: 3 },
    });
    const m = matrixOf([rotated], "corpoTower", 0);
    // Column 0 is facing * width; column 2 is the perpendicular * depth.
    expect([m[0], m[2], m[8], m[10]]).toEqual([0, 2, -3, 0]);
  });

  it("should shrink the footprint by the tier inset when a tier is inset", () => {
    const inset = building({
      id: 0,
      blockId: 0,
      tiers: tiers({ heightFrac: 1, insetFrac: 0.25 }),
    });
    const m = matrixOf([inset], "corpoTower", 0);
    expect(m[0]).toBe(3);
  });

  it("should stack the second tier on top of the first when a building is tiered", () => {
    const tiered = building({
      id: 0,
      blockId: 0,
      archetype: "megabuilding",
      heightM: 100,
      baseZM: 7,
      tiers: tiers(
        { heightFrac: 0.4, insetFrac: 0 },
        { heightFrac: 0.6, insetFrac: 0 }
      ),
    });
    // First tier is 40 m tall starting at 7, so the second begins at 47.
    expect(matrixOf([tiered], "megabuilding", 1)[13]).toBeCloseTo(47, 6);
  });
});

describe("block ranges", () => {
  it("should order instances by block when buildings span several blocks", () => {
    const spread = [
      building({ id: 0, blockId: 5 }),
      building({ id: 1, blockId: 1 }),
      building({ id: 2, blockId: 3 }),
    ];
    const ranges = packInstances(spread).corpoTower.blockRanges;
    expect([ranges.get(1), ranges.get(3), ranges.get(5)]).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("should give a block a contiguous range when it holds several buildings", () => {
    const sameBlock = [
      building({ id: 0, blockId: 2 }),
      building({ id: 1, blockId: 2 }),
    ];
    expect(packInstances(sameBlock).corpoTower.blockRanges.get(2)).toEqual([
      0, 2,
    ]);
  });

  it("should pack a tiered building's instances into one block range when tiered", () => {
    const tiered = building({
      id: 0,
      blockId: 9,
      archetype: "megabuilding",
      tiers: tiers(
        { heightFrac: 0.5, insetFrac: 0 },
        { heightFrac: 0.5, insetFrac: 0.1 }
      ),
    });
    expect(packInstances([tiered]).megabuilding.blockRanges.get(9)).toEqual([
      0, 2,
    ]);
  });

  it("should order equal-block buildings by id when ids differ", () => {
    const unsorted = [
      building({
        id: 7,
        blockId: 1,
        obb: { cx: 7, cy: 0, facing: { x: 1, y: 0 }, w: 1, d: 1 },
      }),
      building({
        id: 2,
        blockId: 1,
        obb: { cx: 2, cy: 0, facing: { x: 1, y: 0 }, w: 1, d: 1 },
      }),
    ];
    expect(matrixOf(unsorted, "corpoTower", 0)[12]).toBe(2);
  });
});

describe("totalInstanceCount", () => {
  it("should sum across archetypes when several are populated", () => {
    const mixed = [
      building({ id: 0, blockId: 0, archetype: "casino" }),
      building({ id: 1, blockId: 0, archetype: "detachedHouse" }),
      building({ id: 2, blockId: 0, archetype: "luxuryResidence" }),
    ];
    expect(totalInstanceCount(packInstances(mixed))).toBe(3);
  });
});
