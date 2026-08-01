import { describe, expect, it } from "vitest";
import {
  DISTRICT_KINDS,
  type DistrictKind,
  type GenerationParams,
} from "@/entities/city";
import { generateCity, zoningStageBytes } from "./pipeline";
import { expectedLotCount, unclampedAreaScale } from "./stages/lots";
import { gridOf } from "./stages/types";
import { totalInstanceCount } from "./stages/assemble";

/**
 * End-to-end pipeline invariants.
 *
 * Runs at a reduced grid so the suite stays fast; the properties asserted are
 * scale-independent. Golden content hashes are deliberately NOT committed yet —
 * they would lock in tuning that has not been looked at on screen, and a golden
 * that nobody has validated visually is a test that only asserts "unchanged".
 */

const params = (
  overrides: Partial<GenerationParams> = {}
): GenerationParams => ({
  seed: "akiba-01",
  sizeM: 2048,
  cells: 128,
  ...overrides,
});

const city = generateCity(params());

describe("generateCity", () => {
  it("should produce buildings when run on a fixture seed", () => {
    expect(city.buildings.length).toBeGreaterThan(0);
  });

  it("should produce blocks when run on a fixture seed", () => {
    expect(city.blocks.length).toBeGreaterThan(0);
  });

  it("should produce roads when run on a fixture seed", () => {
    expect(city.roads.edges.length).toBeGreaterThan(0);
  });

  it("should produce lots when run on a fixture seed", () => {
    expect(city.lots.length).toBeGreaterThan(0);
  });

  it("should pack an instance for every building tier when assembling", () => {
    const tierTotal = city.buildings.reduce((n, b) => n + b.tiers.length, 0);
    expect(totalInstanceCount(city.instances)).toBe(tierTotal);
  });

  it("should carve a coastline when the sea level percentile is applied", () => {
    const wet = city.terrain.waterMask.reduce((n, v) => (v > 0 ? n + 1 : n), 0);
    expect(wet).toBeGreaterThan(0);
  });

  it("should produce real relief when terrain is generated", () => {
    const data = city.terrain.elevation.data;
    const spread =
      data.reduce((m, v) => Math.max(m, v), -Infinity) -
      data.reduce((m, v) => Math.min(m, v), Infinity);
    expect(spread).toBeGreaterThan(50);
  });

  it("should contain no NaN in the instance buffers when assembling", () => {
    const bad = Object.values(city.instances).some((buffer) =>
      buffer.matrices.some((v) => Number.isNaN(v))
    );
    expect(bad).toBe(false);
  });
});

describe("determinism", () => {
  it("should produce an identical content hash when run twice with one seed", () => {
    expect(generateCity(params()).contentHash).toBe(city.contentHash);
  });

  it("should produce a different content hash when the seed differs", () => {
    expect(generateCity(params({ seed: "akiba-02" })).contentHash).not.toBe(
      city.contentHash
    );
  });

  it("should produce an identical per-stage hash set when run twice", () => {
    expect(generateCity(params()).stageHashes).toEqual(city.stageHashes);
  });

  it("should reject params when the grid is out of range", () => {
    expect(() => generateCity(params({ cells: 4 }))).toThrow(/cells/i);
  });
});

describe("district composition", () => {
  it("should assign every block a known district when zoning runs", () => {
    const unknown = city.blocks.filter(
      (b) => !DISTRICT_KINDS.includes(b.district)
    );
    expect(unknown).toEqual([]);
  });

  it("should place more than one kind of district when the map is generated", () => {
    expect(new Set(city.blocks.map((b) => b.district)).size).toBeGreaterThan(1);
  });
});

const bytesOf = (districts: readonly DistrictKind[]): string =>
  [...zoningStageBytes(districts.map((district) => ({ district })))].join(",");

/**
 * Regression for the zoning stage hash.
 *
 * The encoder previously used the district *name length*, which made the
 * three six-character districts indistinguishable. The whole point of a
 * per-stage hash is that a golden failure names the stage that diverged, so a
 * collision here silently costs that diagnostic.
 */
describe("zoningStageBytes", () => {
  it("should differ when two same-length districts are swapped", () => {
    expect(bytesOf(["casino", "luxury"])).not.toBe(
      bytesOf(["luxury", "casino"])
    );
  });

  it("should differ when a block moves between two nine-character districts", () => {
    expect(bytesOf(["corporate"])).not.toBe(bytesOf(["megablock"]));
  });

  it.each([
    ["casino", "luxury"],
    ["luxury", "suburb"],
    ["casino", "suburb"],
  ] as const)(
    "should encode %s and %s differently when both are six characters",
    (a, b) => {
      expect(bytesOf([a])).not.toBe(bytesOf([b]));
    }
  );

  it("should produce identical bytes when the district sequence is unchanged", () => {
    expect(bytesOf(["slum", "corporate"])).toBe(bytesOf(["slum", "corporate"]));
  });
});

/**
 * The design's own district-coverage invariant.
 *
 * Zoning is a relative argmax, so nothing structurally guarantees all six
 * districts appear — the guarantee is empirical, over the fixture seeds. It
 * failed before the affinity weights were calibrated (slum took 57-61% of
 * blocks and luxury and suburb were 0-3%), which is exactly the regression
 * this pins.
 */
describe("district coverage on fixture seeds", () => {
  it.each(["akiba-01", "akiba-02", "akiba-03"])(
    "should place every district and land in the count band when generating seed %s",
    (seed) => {
      const generated = generateCity(params({ seed, cells: 256 }));
      const present = new Set(generated.blocks.map((b) => b.district));
      const count = generated.buildings.length;
      // Asserted as one object so both invariants share a single pipeline run
      // and a single expect (arch-rules/single-expect).
      expect({
        missing: DISTRICT_KINDS.filter((k) => !present.has(k)),
        inBand: count >= 3000 && count <= 8000,
      }).toEqual({ missing: [], inBand: true });
    }
  );

  /**
   * The count control targets a density, so the invariant that generalises is
   * buildings per km2 — not an absolute total, which is only meaningful at the
   * design's ~4 km2 extent. Before the target became a density this failed:
   * the upper clamp saturated above the default size, so 4096 m produced about
   * 20,000 buildings whether or not the overshoot correction was applied.
   */
  it.each([1024, 2048, 4096])(
    "should hold the building density when the extent is %s m",
    (sizeM) => {
      // cells:128 — the property under test is invariance with respect to
      // *area*, not field resolution, and 128 exercises it at a third of the
      // cost (the suite went 7.3s -> 11.3s when this ran at 256).
      const generated = generateCity(params({ sizeM, cells: 128 }));
      const perKm2 = generated.buildings.length / ((sizeM * sizeM) / 1_000_000);
      expect(perKm2 > 1000 && perKm2 < 1800).toBe(true);
    }
  );
});

/**
 * Clamp-saturation guard.
 *
 * The count control's clamp still saturates for some (seed, extent, cells)
 * combinations, and where it does the closed-form control stops governing and
 * the residual is absorbed silently. The density band above cannot see that —
 * it only sees the outcome, which stays in band on the margin, which is how
 * this hid through two earlier fixes. This asserts the pre-clamp ratio
 * directly, so the accepted bound is pinned and any worsening fails.
 *
 * Measured maximum at the time of writing: 1.9055 (akiba-01, 4096 m, 128
 * cells). The ceiling below is that plus headroom, not an aspiration.
 */
describe("count-control clamp saturation", () => {
  const MAX_ACCEPTED_UNCLAMPED = 2;

  it.each([
    ["akiba-01", 1024],
    ["akiba-01", 4096],
    ["akiba-02", 4096],
    ["akiba-03", 4096],
  ])(
    "should keep the pre-clamp scale under the accepted bound for %s at %s m",
    (seed, sizeM) => {
      const generated = generateCity(params({ seed, sizeM, cells: 128 }));
      const ratio = unclampedAreaScale(
        expectedLotCount({
          blocks: generated.blocks,
          blockPolygons: generated.blockPolygons,
          grid: gridOf(generated.params),
        }),
        (sizeM * sizeM) / 1_000_000
      );
      expect(ratio < MAX_ACCEPTED_UNCLAMPED).toBe(true);
    }
  );
});
