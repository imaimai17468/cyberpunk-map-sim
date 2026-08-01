import { describe, expect, it } from "vitest";
import { streamFromSeedWord } from "../rng/xoshiro";
import { TERRAIN } from "../constants";
import { terrainStage } from "./terrain";
import type { Grid } from "./types";

const grid = (cells: number, sizeM: number): Grid => ({
  cells,
  sizeM,
  cellSizeM: sizeM / cells,
});

describe("terrainStage", () => {
  it("should return zero elevation when the grid has a single cell", () => {
    const field = terrainStage(grid(1, 4), streamFromSeedWord(1));
    expect(Array.from(field.data)).toEqual([0]);
  });

  it("should normalize elevation so the minimum and maximum reach the configured range when the grid has genuine relief", () => {
    const field = terrainStage(grid(64, 2048), streamFromSeedWord(42));
    const min = field.data.reduce((acc, v) => Math.min(acc, v), Infinity);
    const max = field.data.reduce((acc, v) => Math.max(acc, v), -Infinity);
    expect([
      min <= 1e-3,
      Math.abs(max - TERRAIN.maxElevationM) <= 1e-3,
    ]).toEqual([true, true]);
  });

  it("should produce identical elevation fields when the same seed is used twice", () => {
    const a = terrainStage(grid(32, 2048), streamFromSeedWord(7));
    const b = terrainStage(grid(32, 2048), streamFromSeedWord(7));
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("should produce a different elevation field when a different seed word is used", () => {
    const a = terrainStage(grid(32, 2048), streamFromSeedWord(7));
    const b = terrainStage(grid(32, 2048), streamFromSeedWord(8));
    expect(Array.from(a.data)).not.toEqual(Array.from(b.data));
  });

  it("should keep every elevation cell within the configured output range when the grid has genuine relief", () => {
    const field = terrainStage(grid(48, 2048), streamFromSeedWord(99));
    const withinRange = field.data.every(
      (v) => v >= -1e-3 && v <= TERRAIN.maxElevationM + 1e-3
    );
    expect(withinRange).toBe(true);
  });
});
