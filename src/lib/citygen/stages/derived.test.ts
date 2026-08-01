import { describe, expect, it } from "vitest";
import type { Field2D } from "@/entities/city";
import { WATER_CLASSES } from "@/entities/city";
import { streamFromSeedWord } from "../rng/xoshiro";
import {
  computeFloodRisk,
  computeLocalEminence,
  computeSlope,
  derivedStage,
  smoothstep,
} from "./derived";
import { hydrologyStage } from "./hydrology";
import { terrainStage } from "./terrain";
import type { Grid } from "./types";

const NONE_ORDINAL = WATER_CLASSES.indexOf("none");

const fieldFrom = (
  cells: number,
  values: readonly number[],
  cellSizeM = 1
): Field2D => ({ cells, cellSizeM, data: Float32Array.from(values) });

describe("smoothstep", () => {
  it.each([
    [-5, 1],
    [8, 0],
    [4, 0.5],
  ])(
    "should evaluate the decreasing ramp to %d when x is %d",
    (x, expected) => {
      expect(smoothstep(8, 0, x)).toBeCloseTo(expected, 6);
    }
  );
});

describe("computeSlope", () => {
  it("should match the hand-computed gradient magnitude when elevation is a linear plane", () => {
    // elevation(x, y) = 2x + 3y over a 3x3 grid, cellSizeM = 1: the true
    // gradient is (2, 3) everywhere, so the interior cell's central
    // difference should recover it exactly.
    const cells = 3;
    const values = Array.from({ length: cells * cells }, (_v, index) => {
      const x = index % cells;
      const y = Math.floor(index / cells);
      return 2 * x + 3 * y;
    });
    const slope = computeSlope(fieldFrom(cells, values));
    expect(slope.data[1 * cells + 1]).toBeCloseTo(Math.sqrt(2 * 2 + 3 * 3), 5);
  });
});

describe("computeLocalEminence", () => {
  it("should return zero everywhere when elevation is perfectly flat", () => {
    const cells = 3;
    const values = Array.from({ length: cells * cells }, () => 42);
    const eminence = computeLocalEminence(fieldFrom(cells, values));
    expect(Array.from(eminence.data)).toEqual(
      Array.from({ length: cells * cells }, () => 0)
    );
  });

  it("should subtract the grand mean from every cell when the blur radius exceeds the grid", () => {
    // DERIVED.eminenceBlurRadiusCells (64) covers this whole 3x3 grid, so
    // each separable pass reduces to the plain average — the composed
    // 3-pass blur is exactly the grand mean everywhere, making the
    // expected eminence `value - grandMean` for every cell.
    const cells = 3;
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const grandMean = 5;
    const eminence = computeLocalEminence(fieldFrom(cells, values));
    const expected = values.map((v) => v - grandMean);
    const closeEnough = eminence.data.every(
      (v, i) => Math.abs(v - expected[i]) < 1e-4
    );
    expect(closeEnough).toBe(true);
  });
});

describe("computeFloodRisk", () => {
  it("should multiply both smoothstep falloffs when height and distance sit at their midpoints", () => {
    const elevation = fieldFrom(1, [4]); // 4m above sea, midpoint of [0, 8]
    const distWater = fieldFrom(1, [60]); // midpoint of [0, 120]
    const risk = computeFloodRisk(elevation, 0, distWater);
    expect(risk.data[0]).toBeCloseTo(0.25, 5);
  });
});

const grid = (cells: number, sizeM: number): Grid => ({
  cells,
  sizeM,
  cellSizeM: sizeM / cells,
});

describe("derivedStage", () => {
  const elevation = terrainStage(grid(32, 2048), streamFromSeedWord(21));
  const terrain = hydrologyStage(elevation, streamFromSeedWord(22));
  const derived = derivedStage(terrain, streamFromSeedWord(23));

  it("should report zero distance to water when the cell is itself water", () => {
    const waterIndex = terrain.waterMask.findIndex(
      (value) => value !== NONE_ORDINAL
    );
    expect(derived.distWater.data[waterIndex]).toBeCloseTo(0, 4);
  });

  it("should report zero distance to land when the cell is itself land", () => {
    const landIndex = terrain.waterMask.findIndex(
      (value) => value === NONE_ORDINAL
    );
    expect(derived.distLand.data[landIndex]).toBeCloseTo(0, 4);
  });

  it("should produce no NaN values when every derived field is sampled", () => {
    const fields = [
      derived.slope,
      derived.distWater,
      derived.distLand,
      derived.localEminence,
      derived.floodRisk,
    ];
    const allFinite = fields.every((field) =>
      field.data.every((value) => Number.isFinite(value))
    );
    expect(allFinite).toBe(true);
  });
});
