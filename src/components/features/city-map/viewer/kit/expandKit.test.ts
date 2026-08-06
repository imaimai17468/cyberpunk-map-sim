import type { Building } from "@/entities/city";
import { describe, expect, it } from "vitest";
import { expandKit, type KitMetrics, profileFor, stackOf } from "./expandKit";

/** The authored corpoTower kit, as measured off its GLB. */
const PART_HEIGHTS = {
  podium: 12,
  floor: 3.6,
  mech: 3.6,
  belt: 3.6,
  setback: 2.4,
  crown: 9,
  mast: 14,
} as const;

const METRICS: KitMetrics = {
  partHeights: PART_HEIGHTS,
  footprint: { x: 34.2, z: 34.2 },
};

const building = (overrides: Partial<Building> = {}): Building => ({
  id: 0,
  archetype: "corpoTower",
  obb: { cx: 100, cy: 200, facing: { x: 1, y: 0 }, w: 34.2, d: 34.2 },
  heightM: 137,
  baseZM: 10,
  tiers: [{ heightFrac: 1, insetFrac: 0 }],
  lotId: 0,
  blockId: 0,
  ...overrides,
});

/** What the stack actually adds up to, from its own entries. */
const stackedHeight = (buildingId: number, heightM: number): number =>
  stackOf(profileFor(buildingId, heightM, PART_HEIGHTS), PART_HEIGHTS).reduce(
    (sum, entry) => sum + entry.height,
    0
  );

describe("profileFor", () => {
  /**
   * The property the whole design rests on: `heightM` keeps one authority, so a
   * kit-built tower is exactly as tall as the model says however the storeys
   * round and whichever parts the draws gave it. Swept across the corpoTower
   * height range measured on akiba-01 (p10 104 m to p90 218 m), well past both
   * ends, and over ids that take different branches of the grammar.
   */
  it.each([
    [0, 30],
    [1, 104],
    [2, 136.6],
    [3, 217.7],
    [7, 60],
    [11, 400],
    [12, 26],
    [40, 24.6],
    [41, 24.5],
    [99, 150],
  ])(
    "should stack to exactly the model's height when building %s is %s m",
    (id, heightM) => {
      expect(stackedHeight(id, heightM)).toBeCloseTo(heightM, 6);
    }
  );

  it("should give the same profile twice when the same building is expanded again", () => {
    expect(profileFor(17, 150, PART_HEIGHTS)).toEqual(
      profileFor(17, 150, PART_HEIGHTS)
    );
  });

  /**
   * The point of seeding from the id: 398 towers must not share one silhouette.
   * Asserted as a spread rather than as specific values, so retuning the
   * grammar's odds does not rewrite the test.
   */
  it("should vary the stacking across buildings when many are profiled", () => {
    const profiles = Array.from({ length: 200 }, (_value, id) =>
      profileFor(id, 150, PART_HEIGHTS)
    );
    const shapes = new Set(
      profiles.map(
        (p) => `${p.sections.length}/${p.belt}/${p.mast}/${p.mechEvery}`
      )
    );
    expect({
      distinctShapes: shapes.size > 8,
      sectionCounts: [
        ...new Set(profiles.map((p) => p.sections.length)),
      ].toSorted((a, b) => a - b),
    }).toEqual({ distinctShapes: true, sectionCounts: [1, 2, 3] });
  });

  it("should put the remainder in the lower sections when the storeys do not divide evenly", () => {
    const profile = profileFor(2, 136.6, PART_HEIGHTS);
    const descending = profile.sections.every(
      (count, i) => i === 0 || count <= profile.sections[i - 1]
    );
    expect({ descending, total: profile.sections.length > 0 }).toEqual({
      descending: true,
      total: true,
    });
  });

  /**
   * The ladder. A tower too short for the drawn profile loses the mast, then the
   * sky lobby, then its steps — rather than the storeys being squeezed to
   * nothing. Building 3 draws all of them at a comfortable height.
   */
  it("should keep the mast when the height can afford it", () => {
    expect(profileFor(3, 400, PART_HEIGHTS).mast).toBe(true);
  });

  it("should drop the optional parts when the height cannot afford them", () => {
    // 24 m: a podium, one storey and a crown come to 24.6, so nothing optional
    // fits and even the steps have to go.
    const profile = profileFor(3, 30, PART_HEIGHTS);
    expect({
      mast: profile.mast,
      belt: profile.belt,
      sections: profile.sections.length,
    }).toEqual({ mast: false, belt: false, sections: 1 });
  });

  /**
   * Below a podium, one storey and a crown at their authored heights, nothing
   * can be dropped any further, so the whole kit shrinks together — a squat
   * tower rather than a crown driven down through its own podium.
   */
  it("should scale the whole kit together when even the minimum does not fit", () => {
    const profile = profileFor(3, 12.3, PART_HEIGHTS);
    expect({
      fixedScale: profile.fixedScale,
      storeyScale: profile.storeyScale,
      sections: profile.sections,
    }).toEqual({ fixedScale: 0.5, storeyScale: 1, sections: [1] });
  });
});

describe("stackOf", () => {
  it("should start with the podium and end with the crown when no mast is drawn", () => {
    const profile = {
      sections: [3],
      taper: 0.9,
      mechEvery: 0,
      belt: false,
      mast: false,
      storeyScale: 1,
      fixedScale: 1,
    };
    expect(stackOf(profile, PART_HEIGHTS).map((entry) => entry.part)).toEqual([
      "podium",
      "floor",
      "floor",
      "floor",
      "crown",
    ]);
  });

  it("should put a terrace between the sections and none above the last when the tower is stepped", () => {
    const profile = {
      sections: [2, 2],
      taper: 0.9,
      mechEvery: 0,
      belt: true,
      mast: true,
      storeyScale: 1,
      fixedScale: 1,
    };
    expect(stackOf(profile, PART_HEIGHTS).map((entry) => entry.part)).toEqual([
      "podium",
      "belt",
      "floor",
      "floor",
      "setback",
      "floor",
      "floor",
      "crown",
      "mast",
    ]);
  });

  /**
   * The plant floors count across the whole tower rather than restarting at each
   * step, so the rhythm carries through a setback instead of stuttering at it.
   * With `mechEvery` 2 and sections of 3 and 3, storeys 2, 4 and 6 are plant —
   * the second of which is in the upper section.
   */
  it("should count the plant floors across the sections when the tower is stepped", () => {
    const profile = {
      sections: [3, 3],
      taper: 0.9,
      mechEvery: 2,
      belt: false,
      mast: false,
      storeyScale: 1,
      fixedScale: 1,
    };
    expect(stackOf(profile, PART_HEIGHTS).map((entry) => entry.part)).toEqual([
      "podium",
      "floor",
      "mech",
      "floor",
      "setback",
      "mech",
      "floor",
      "mech",
      "crown",
    ]);
  });

  it("should narrow each section by the taper when the tower is stepped", () => {
    const profile = {
      sections: [1, 1, 1],
      taper: 0.5,
      mechEvery: 0,
      belt: false,
      mast: false,
      storeyScale: 1,
      fixedScale: 1,
    };
    const widths = stackOf(profile, PART_HEIGHTS)
      .filter((entry) => entry.part === "floor")
      .map((entry) => entry.width);
    expect(widths).toEqual([1, 0.5, 0.25]);
  });
});

describe("expandKit", () => {
  it("should stand the podium on the model's own base height when a building is expanded", () => {
    const result = expandKit([building({ baseZM: 10 })], METRICS);
    // Column-major: index 13 is the Y translation.
    expect(result.podium.matrices[13]).toBeCloseTo(10, 6);
  });

  it("should emit one podium and one crown per building when several are expanded", () => {
    const result = expandKit(
      [building({ id: 0 }), building({ id: 1 }), building({ id: 2 })],
      METRICS
    );
    expect({ podium: result.podium.count, crown: result.crown.count }).toEqual({
      podium: 3,
      crown: 3,
    });
  });

  it("should scale a part by the footprint ratio when the building is narrower than the kit", () => {
    const result = expandKit(
      [
        building({
          obb: { cx: 0, cy: 0, facing: { x: 1, y: 0 }, w: 17.1, d: 68.4 },
        }),
      ],
      METRICS
    );
    expect({
      podiumX: result.podium.matrices[0],
      podiumZ: result.podium.matrices[10],
    }).toEqual({ podiumX: 0.5, podiumZ: 2 });
  });

  it("should turn every part with the building when it faces along another axis", () => {
    const result = expandKit(
      [
        building({
          obb: { cx: 0, cy: 0, facing: { x: 0, y: 1 }, w: 34.2, d: 34.2 },
        }),
      ],
      METRICS
    );
    // facing (0,1): local +X maps to world +Y, so column 0 is (0, 0, 1).
    expect([result.podium.matrices[0], result.podium.matrices[2]]).toEqual([
      0, 1,
    ]);
  });

  it("should record contiguous instance ranges per block when several blocks are expanded", () => {
    const result = expandKit(
      [building({ id: 1, blockId: 7 }), building({ id: 0, blockId: 3 })],
      METRICS
    );
    // Sorted by blockId then id, so block 3's podium comes first.
    expect([...result.podium.blockRanges.entries()]).toEqual([
      [3, [0, 1]],
      [7, [1, 2]],
    ]);
  });

  /**
   * The part heights are measured off the GLB, not written down here, so a part
   * authored flat is a real input rather than an impossible one — and dividing
   * the height a profile asked for by an authored zero is how `NaN` gets into an
   * instance matrix, where it draws nothing and reports nothing. A zero scale is
   * the honest answer: the part is invisible, and everything above it still
   * stands where the profile put it.
   */
  it("should scale a part to nothing when the asset authored it flat", () => {
    const flatMast = { ...PART_HEIGHTS, mast: 0 };
    const result = expandKit([building({ id: 3, heightM: 400 })], {
      partHeights: flatMast,
      footprint: METRICS.footprint,
    });
    // Column-major: index 5 is the Y scale. Building 3 draws a mast.
    expect({
      count: result.mast.count,
      scaleY: result.mast.matrices[5],
      finite: Number.isFinite(result.mast.matrices[5]),
    }).toEqual({ count: 1, scaleY: 0, finite: true });
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
