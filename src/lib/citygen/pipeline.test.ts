import { describe, expect, it } from "vitest";
import { DISTRICT_KINDS, type GenerationParams } from "@/entities/city";
import { generateCity } from "./pipeline";
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
