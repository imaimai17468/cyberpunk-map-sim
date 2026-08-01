import type { Field2D, TerrainLayer } from "@/entities/city";
import { WATER_CLASSES } from "@/entities/city";
import { combineFields, fieldAt } from "../field/field2d";
import { euclideanDistanceTransform } from "../field/edt";
import { boxBlur3Pass } from "../field/blur";
import { DERIVED } from "../constants";
import type { DerivedFields, Stage } from "./types";

/**
 * Stage 3 — derived fields (design doc §3 stage 3): slope, distance-to-water
 * and distance-to-land (the exact EDT primitive already gives us both,
 * seeded from opposite masks), local eminence (elevation above its own
 * blurred average), and flood risk.
 *
 * Loop-free per §12: every field here is a `Field2D` built via
 * `Float32Array.from`/`combineFields`, on top of the already loop-free EDT
 * and box-blur primitives. No recursion, no `for`/`while` in this file.
 */

const NONE_ORDINAL = WATER_CLASSES.indexOf("none");

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The standard clamped Hermite smoothstep, `t*t*(3-2t)` with
 * `t = clamp01((x - edge0) / (edge1 - edge0))`. Callers may pass
 * `edge0 > edge1` to get a *decreasing* ramp (1 at/below edge0, 0 at/beyond
 * edge1) — exactly how design §3's flood-risk falloffs are written. Built
 * entirely from `+ - * /` and `Math.min/max`, per the determinism rules.
 */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Central-difference gradient magnitude at one cell, clamped to the field's edge. */
const gradientMagnitudeAt = (
  elevation: Field2D,
  cx: number,
  cy: number
): number => {
  const step = 2 * elevation.cellSizeM;
  const dzdx =
    (fieldAt(elevation, cx + 1, cy) - fieldAt(elevation, cx - 1, cy)) / step;
  const dzdy =
    (fieldAt(elevation, cx, cy + 1) - fieldAt(elevation, cx, cy - 1)) / step;
  return Math.sqrt(dzdx * dzdx + dzdy * dzdy);
};

/** Central-difference gradient magnitude over the whole elevation field. */
export const computeSlope = (elevation: Field2D): Field2D => ({
  cells: elevation.cells,
  cellSizeM: elevation.cellSizeM,
  data: Float32Array.from({ length: elevation.data.length }, (_value, index) =>
    gradientMagnitudeAt(
      elevation,
      index % elevation.cells,
      Math.floor(index / elevation.cells)
    )
  ),
});

/**
 * How far each cell sits above its own locally blurred average
 * (`DERIVED.eminenceBlurRadiusCells`, 3-pass box blur) — positive on
 * crests, negative in hollows, zero on a perfectly flat field.
 */
export const computeLocalEminence = (elevation: Field2D): Field2D => {
  const blurred = boxBlur3Pass(elevation, DERIVED.eminenceBlurRadiusCells);
  return combineFields(
    [elevation, blurred],
    ([elevationValue, blurredValue]) => elevationValue - blurredValue
  );
};

/**
 * `smoothstep(floodHeightM, 0, elev - sea) * smoothstep(floodDistanceM, 0,
 * distWater)`: risk is highest at/below sea level and right at the
 * waterline, fading to zero by `floodHeightM` above sea or
 * `floodDistanceM` from water — whichever fades first.
 */
export const computeFloodRisk = (
  elevation: Field2D,
  seaLevelM: number,
  distWater: Field2D
): Field2D =>
  combineFields(
    [elevation, distWater],
    ([elevationValue, distWaterValue]) =>
      smoothstep(DERIVED.floodHeightM, 0, elevationValue - seaLevelM) *
      smoothstep(DERIVED.floodDistanceM, 0, distWaterValue)
  );

export type DerivedStage = Stage<TerrainLayer, DerivedFields>;

/** Stage 3: `TerrainLayer` in, the derived scalar field stack out. */
export const derivedStage: DerivedStage = (terrain, _stream) => {
  const { elevation, waterMask, seaLevelM } = terrain;
  const slope = computeSlope(elevation);
  const distWater = euclideanDistanceTransform(
    (index) => waterMask[index] !== NONE_ORDINAL,
    elevation.cells,
    elevation.cellSizeM
  );
  const distLand = euclideanDistanceTransform(
    (index) => waterMask[index] === NONE_ORDINAL,
    elevation.cells,
    elevation.cellSizeM
  );
  const localEminence = computeLocalEminence(elevation);
  const floodRisk = computeFloodRisk(elevation, seaLevelM, distWater);
  return { slope, distWater, distLand, localEminence, floodRisk };
};
