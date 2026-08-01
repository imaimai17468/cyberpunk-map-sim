import { describe, expect, it } from "vitest";
import type { Field2D } from "@/entities/city";
import { WATER_CLASSES } from "@/entities/city";
import { streamFromSeedWord } from "../rng/xoshiro";
import { HYDROLOGY } from "../constants";
import {
  classifyInitialRiverMask,
  computeFlowAccumulation,
  computeSeaLevel,
  dilateMask,
  hydrologyStage,
  priorityFloodFill,
} from "./hydrology";
import { terrainStage } from "./terrain";
import type { Grid } from "./types";

const OCEAN_ORDINAL = WATER_CLASSES.indexOf("ocean");
const RIVER_ORDINAL = WATER_CLASSES.indexOf("river");
const NONE_ORDINAL = WATER_CLASSES.indexOf("none");

const fieldFrom = (
  cells: number,
  values: readonly number[],
  cellSizeM = 1
): Field2D => ({ cells, cellSizeM, data: Float32Array.from(values) });

describe("computeSeaLevel", () => {
  it("should select the nearest-rank value when sorting the field ascending", () => {
    const field = fieldFrom(1, [5, 1, 4, 2, 3]);
    expect(computeSeaLevel(field, 0.4)).toBe(3);
  });
});

describe("priorityFloodFill", () => {
  it("should raise the pit cell to spill elevation when priority-flood fills a depression", () => {
    // 8x8 grid: row y=0 is the sea (elevation 0); a single corridor of
    // elevation 3 runs down column x=7 (rows 1-3), connecting the sea to a
    // pit at (7,4) whose own elevation (1) is far lower than the corridor.
    // Every other cell is a high (999) wall the fill must not prefer.
    const cells = 8;
    const values = Array.from({ length: cells * cells }, (_v, index) => {
      const x = index % cells;
      const y = Math.floor(index / cells);
      if (y === 0) return 0;
      if (x === 7 && y >= 1 && y <= 3) return 3;
      if (x === 7 && y === 4) return 1;
      return 999;
    });
    const filled = priorityFloodFill(fieldFrom(cells, values), 0);
    expect(filled.data[4 * cells + 7]).toBeCloseTo(3, 6);
  });

  it("should leave elevation unchanged when the grid is already monotone toward the sea", () => {
    const cells = 4;
    const values = Array.from({ length: cells * cells }, (_v, index) => {
      const x = index % cells;
      const y = Math.floor(index / cells);
      return x + y;
    });
    const input = fieldFrom(cells, values);
    const filled = priorityFloodFill(input, 0);
    expect(Array.from(filled.data)).toEqual(Array.from(input.data));
  });
});

describe("computeFlowAccumulation", () => {
  it("should accumulate flow toward the global minimum when elevation increases monotonically away from it", () => {
    // 3x3 grid, elevation(x, y) = x + y: every cell's unique steepest D8
    // descent eventually reaches (0, 0), which itself has no lower
    // neighbour (the accumulation DAG's root).
    const cells = 3;
    const values = Array.from({ length: cells * cells }, (_v, index) => {
      const x = index % cells;
      const y = Math.floor(index / cells);
      return x + y;
    });
    const accumulation = computeFlowAccumulation(fieldFrom(cells, values));
    expect(Array.from(accumulation)).toEqual([9, 3, 1, 3, 2, 1, 1, 1, 1]);
  });
});

describe("classifyInitialRiverMask", () => {
  const seaLevelM = 0;
  const landCellCount = 100; // threshold = 0.015 * 100 = 1.5

  it.each([
    [10, 2, 1],
    [10, 1, 0],
    [0, 1000, 0],
  ])(
    "should classify accumulation %d at elevation-flag %d as river-bit %d when checked against the land threshold",
    (elevation, accumulationValue, expected) => {
      const filled = fieldFrom(1, [elevation]);
      const accumulation = Float64Array.from([accumulationValue]);
      const mask = classifyInitialRiverMask(
        filled,
        seaLevelM,
        accumulation,
        landCellCount
      );
      expect(mask[0]).toBe(expected);
    }
  );
});

describe("dilateMask", () => {
  it("should mark the D8 neighbours of a seeded cell as river when dilating one pass", () => {
    const cells = 5;
    const mask = new Uint8Array(cells * cells);
    mask[0] = 1; // corner (0, 0)
    const dilated = dilateMask(mask, cells, 1);
    const expected = new Uint8Array(cells * cells);
    expected[0] = 1;
    expected[1] = 1; // (1, 0)
    expected[5] = 1; // (0, 1)
    expected[6] = 1; // (1, 1)
    expect(Array.from(dilated)).toEqual(Array.from(expected));
  });
});

const grid = (cells: number, sizeM: number): Grid => ({
  cells,
  sizeM,
  cellSizeM: sizeM / cells,
});

describe("hydrologyStage", () => {
  const elevation = terrainStage(grid(48, 2048), streamFromSeedWord(11));
  const terrain = hydrologyStage(elevation, streamFromSeedWord(12));

  it("should match an independent percentile computation when reporting sea level", () => {
    expect(terrain.seaLevelM).toBe(
      computeSeaLevel(elevation, HYDROLOGY.seaLevelPercentile)
    );
  });

  it("should satisfy the per-class water depth formula when every cell is checked", () => {
    const FLOAT32_EPSILON = 1e-3;
    const holds = terrain.waterDepth.data.every((depth, index) => {
      const mask = terrain.waterMask[index];
      const corrected = terrain.elevation.data[index];
      if (mask === OCEAN_ORDINAL) {
        const expected = Math.max(0, terrain.seaLevelM - corrected);
        return Math.abs(depth - expected) < FLOAT32_EPSILON;
      }
      if (mask === RIVER_ORDINAL) {
        return depth === HYDROLOGY.riverCarveM;
      }
      return mask === NONE_ORDINAL && depth === 0;
    });
    expect(holds).toBe(true);
  });

  it("should keep corrected elevation at or below sea level when the cell is ocean", () => {
    const holds = terrain.elevation.data.every(
      (value, index) =>
        terrain.waterMask[index] !== OCEAN_ORDINAL || value <= terrain.seaLevelM
    );
    expect(holds).toBe(true);
  });
});
