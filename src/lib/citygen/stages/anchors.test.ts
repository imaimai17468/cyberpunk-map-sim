import { describe, expect, it } from "vitest";
import type { Field2D } from "@/entities/city";
import { ANCHORS } from "../constants";
import { createField2D } from "../field/field2d";
import type { RngStream } from "../rng/types";
import {
  anchors,
  argmaxIndex,
  band,
  clamp,
  clamp01,
  fieldMaxAbs,
  normalizeSlope,
  smoothstep,
} from "./anchors";
import type { DerivedFields, Grid } from "./types";

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

/**
 * Stage 4 is fully deterministic and never calls its stream (see the module
 * doc); this stub only exists to satisfy the fixed `Stage` call signature.
 */
const unusedStream: RngStream = {
  next: () => 0,
  nextInt: () => 0,
  fork: () => unusedStream,
};

const CELL_SIZE_M = 10;

const gridOfCells = (cells: number): Grid => ({
  cells,
  sizeM: cells * CELL_SIZE_M,
  cellSizeM: CELL_SIZE_M,
});

/** A field of `cells x cells`, `base` everywhere except the given per-index overrides. */
const buildField = (
  cells: number,
  base: number,
  overrides: ReadonlyMap<number, number> = new Map()
): Field2D =>
  createField2D(cells, CELL_SIZE_M, (index) => overrides.get(index) ?? base);

/**
 * `DerivedFields` where every cell starts at a "worst case" baseline
 * (steep, no water nearby, flooded) so a test can win a candidate purely by
 * overriding that candidate's own fine cell.
 */
const buildDerived = (
  cells: number,
  overrides: {
    readonly slope?: ReadonlyMap<number, number>;
    readonly distWater?: ReadonlyMap<number, number>;
    readonly floodRisk?: ReadonlyMap<number, number>;
  } = {}
): DerivedFields => ({
  slope: buildField(cells, 1, overrides.slope),
  distWater: buildField(cells, 0, overrides.distWater),
  distLand: buildField(cells, 0),
  localEminence: buildField(cells, 0),
  floodRisk: buildField(cells, 0, overrides.floodRisk),
});

/** Row-major fine index of the representative cell for downsampled coordinate (cx, cy). */
const fineIndexOf = (cells: number, cx: number, cy: number): number => {
  const factor = ANCHORS.downsample;
  const centreOffset = Math.floor(factor / 2);
  const fineX = Math.min(cells - 1, cx * factor + centreOffset);
  const fineY = Math.min(cells - 1, cy * factor + centreOffset);
  return fineY * cells + fineX;
};

const posOf = (
  cells: number,
  cx: number,
  cy: number
): { x: number; y: number } => {
  const factor = ANCHORS.downsample;
  const centreOffset = Math.floor(factor / 2);
  const fineX = Math.min(cells - 1, cx * factor + centreOffset);
  const fineY = Math.min(cells - 1, cy * factor + centreOffset);
  return { x: (fineX + 0.5) * CELL_SIZE_M, y: (fineY + 0.5) * CELL_SIZE_M };
};

// ---------------------------------------------------------------------------
// Numeric primitives.
// ---------------------------------------------------------------------------

describe("clamp01", () => {
  it("should clamp a negative value up to zero when below range", () => {
    expect(clamp01(-3)).toBe(0);
  });

  it("should clamp a value above one down to one when above range", () => {
    expect(clamp01(2)).toBe(1);
  });

  it("should return the value unchanged when already inside range", () => {
    expect(clamp01(0.4)).toBe(0.4);
  });
});

describe("clamp", () => {
  it("should clamp to the lower bound when below range", () => {
    expect(clamp(-5, -1, 1)).toBe(-1);
  });

  it("should clamp to the upper bound when above range", () => {
    expect(clamp(5, -1, 1)).toBe(1);
  });
});

describe("smoothstep", () => {
  it("should return zero when x is at or below edge0", () => {
    expect(smoothstep(0, 10, 0)).toBe(0);
  });

  it("should return one when x is at or above edge1", () => {
    expect(smoothstep(0, 10, 10)).toBe(1);
  });

  it("should ease smoothly at the midpoint when x is halfway between edges", () => {
    expect(smoothstep(0, 10, 5)).toBeCloseTo(0.5);
  });

  it("should support a descending ramp when edge0 is greater than edge1", () => {
    expect(smoothstep(8, 0, 4)).toBeCloseTo(0.5);
  });
});

describe("band", () => {
  it("should return zero when the distance is at the near edge's origin", () => {
    expect(band(0, 60, 400)).toBe(0);
  });

  it("should return one when the distance sits inside the plateau", () => {
    expect(band(200, 60, 400)).toBe(1);
  });

  it("should fade back to zero when the distance is past the far taper", () => {
    expect(band(460, 60, 400)).toBe(0);
  });
});

describe("fieldMaxAbs", () => {
  it("should return the largest magnitude when values are both negative and positive", () => {
    const field = buildField(
      2,
      0,
      new Map([
        [0, -7],
        [3, 5],
      ])
    );
    expect(fieldMaxAbs(field)).toBe(7);
  });
});

describe("normalizeSlope", () => {
  it("should scale every cell into [0, 1] when normalized against the field's own maximum", () => {
    const field = buildField(2, 4, new Map([[0, 2]]));
    expect(Array.from(normalizeSlope(field).data)).toEqual([0.5, 1, 1, 1]);
  });
});

describe("argmaxIndex", () => {
  it("should return the lower index when two entries tie for the maximum score", () => {
    expect(argmaxIndex([3, 5, 5, 1])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — anchors.
// ---------------------------------------------------------------------------

describe("anchors: CBD selection", () => {
  it("should pick the lower-index downsampled cell when two candidates tie for the top CBD score", () => {
    const cells = 16;
    const grid = gridOfCells(cells);
    // Candidates 1 (12,4) and 2 (4,12) are symmetric about the map centre, so
    // giving them identical slope/distWater overrides ties their CBD score
    // exactly; candidates 0 and 3 are left at the "worst case" baseline.
    const tiedIndexA = fineIndexOf(cells, 1, 0);
    const tiedIndexB = fineIndexOf(cells, 0, 1);
    const derived = buildDerived(cells, {
      slope: new Map([
        [tiedIndexA, 0],
        [tiedIndexB, 0],
      ]),
      distWater: new Map([
        [tiedIndexA, 200],
        [tiedIndexB, 200],
      ]),
    });
    const result = anchors({ grid, derived }, unusedStream);
    expect(result.cbd).toEqual(posOf(cells, 1, 0));
  });
});

describe("anchors: megablock seeds", () => {
  it("should place the first seed at the lowest-index candidate when every cell clears the threshold", () => {
    const cells = 64;
    const grid = gridOfCells(cells);
    // Flat everywhere (slope 0, the default floodRisk 0 already passes):
    // (1 - slopeN)*(1 - floodRisk) = 1 > 0.6 on every candidate.
    const derived: DerivedFields = {
      ...buildDerived(cells),
      slope: buildField(cells, 0),
    };
    const result = anchors({ grid, derived }, unusedStream);
    expect(result.megaSeeds[0]).toEqual(posOf(cells, 0, 0));
  });

  it("should place the second seed at the farthest candidate from the first when sampling greedily", () => {
    const cells = 64;
    const grid = gridOfCells(cells);
    const derived: DerivedFields = {
      ...buildDerived(cells),
      slope: buildField(cells, 0),
    };
    const result = anchors({ grid, derived }, unusedStream);
    // The unique farthest point from the (0,0) corner of an 8x8 downsampled
    // grid is the opposite (7,7) corner.
    expect(result.megaSeeds[1]).toEqual(posOf(cells, 7, 7));
  });

  it("should fall back to sampling every cell when fewer candidates than the seed count clear the threshold", () => {
    const cells = 32;
    const grid = gridOfCells(cells);
    // Baseline slope=1 fails the threshold everywhere (megaSeedThreshold is
    // 0.6, and (1-1)*(1-0) = 0), leaving zero threshold-passing candidates
    // out of the 4x4 = 16 total, well above ANCHORS.megaSeedCount — so the
    // fallback pool still yields a full set of seeds.
    const derived = buildDerived(cells);
    const result = anchors({ grid, derived }, unusedStream);
    expect(result.megaSeeds.length).toBe(ANCHORS.megaSeedCount);
  });

  it("should stop producing further seeds when the candidate pool itself is exhausted", () => {
    const cells = 8;
    const grid = gridOfCells(cells);
    // ANCHORS.downsample (8) equals cells, so the downsampled grid has only
    // a single candidate in total — the farthest-point reduce cannot find a
    // second seed no matter how many are requested.
    const derived = buildDerived(cells);
    const result = anchors({ grid, derived }, unusedStream);
    expect(result.megaSeeds.length).toBe(1);
  });
});

describe("anchors: casino selection", () => {
  it("should exclude the CBD's downsampled cell when picking casino candidates", () => {
    const cells = 16;
    const grid = gridOfCells(cells);
    // (0,0) wins the CBD outright (best slope/water score) and would also
    // win casino outright if not excluded (best flatness/water/proximity);
    // the three remaining "worst case" baseline candidates all score exactly
    // zero on casino (their flatness term is zero), so the lowest-index
    // survivor — (12, 4) — must win instead.
    const cbdFine = fineIndexOf(cells, 0, 0);
    const derived = buildDerived(cells, {
      slope: new Map([[cbdFine, 0]]),
      distWater: new Map([[cbdFine, 200]]),
    });
    const result = anchors({ grid, derived }, unusedStream);
    expect(result.casino).toEqual(posOf(cells, 1, 0));
  });
});

describe("anchors: constructed strip axis", () => {
  it("should fall back to a default unit direction when the shore has no local gradient", () => {
    const cells = 16;
    const grid = gridOfCells(cells);
    // distWater is perfectly uniform, so the central-difference gradient at
    // the casino anchor is exactly zero on every axis: the "weak seed" case
    // the strip axis must still survive (design's flaw-#6 fix).
    const derived = buildDerived(cells);
    const result = anchors({ grid, derived }, unusedStream);
    expect(result.stripAxis.dir).toEqual({ x: 1, y: 0 });
  });

  it("should rotate the shore gradient 90 degrees when distWater has a real slope", () => {
    const cells = 16;
    const grid = gridOfCells(cells);
    const derived: DerivedFields = {
      ...buildDerived(cells),
      distWater: createField2D(cells, CELL_SIZE_M, (_index, x) => x * 10),
    };
    const result = anchors({ grid, derived }, unusedStream);
    // distWater increases only along x, so its gradient points along +x;
    // rotated 90 degrees that is the +y direction. `perp`'s `-y` produces a
    // signed zero for the x component, so compare by value (`===` treats
    // -0 and 0 as equal) rather than `toEqual` (which does not).
    expect(result.stripAxis.dir).toSatisfy(
      (dir: { x: number; y: number }) => dir.x === 0 && dir.y === 1
    );
  });
});

describe("anchors: overall shape", () => {
  it("should order the anchor list as cbd, every mega seed, then casino when the stage runs", () => {
    const cells = 16;
    const grid = gridOfCells(cells);
    const derived = buildDerived(cells);
    const result = anchors({ grid, derived }, unusedStream);
    expect(result.anchors.map((anchor) => anchor.kind)).toEqual([
      "cbd",
      ...Array.from({ length: ANCHORS.megaSeedCount }, () => "mega"),
      "casino",
    ]);
  });
});
