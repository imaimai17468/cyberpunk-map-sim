import type { CityModel, Vec2 } from "@/entities/city";
import type { CityViewMode } from "../cityModelMachine";
import { groundColorRamp, groundHeightAt } from "./terrainMesh";

/**
 * The levelled ground under each lot, drawn as its own surface (ADR-0028).
 *
 * A pad is a flat polygon at the height stage 10 cut and filled to, plus a skirt
 * from its edge down or up to the natural ground — the retaining wall or batter that
 * makes a platform read as an earthwork rather than as a slab floating over the
 * hillside. This is the same device the roads already use: a separate mesh laid over
 * the terrain with polygon offset, rather than an edit to the terrain itself.
 *
 * It has to be a mesh. The elevation field is 4 m per cell and the terrain mesh
 * subsamples it further before drawing, while a lot is 10 m to 30 m across — so a
 * pad written into the field is a jagged blob smaller than its own lot, and one
 * written into the drawn mesh is not written at all. As geometry the edge is the lot
 * polygon exactly, at any zoom.
 */

export interface PadMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Per-vertex colour per view, from the terrain's own ramp. See `groundColorAt`. */
  readonly colors: Readonly<Record<CityViewMode, Float32Array>>;
}

const EMPTY: PadMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  colors: { "2d": new Float32Array(0), "3d": new Float32Array(0) },
};

/**
 * How far a pad's own surface floats over the ground it replaced.
 *
 * The same job `ROAD_LIFT_M` does for a ribbon: the terrain mesh is drawn from the
 * same heights, so two coplanar surfaces would trade pixels. Smaller than the road's
 * lift because a pad is level by construction and cannot dip through the relief it
 * spans the way a long flat road quad can.
 */
export const PAD_LIFT_M = 0.5;

interface Ring {
  readonly ring: readonly Vec2[];
  readonly padZ: number;
}

const ringAt = (model: CityModel, ringIndex: number): readonly Vec2[] => {
  const pool = model.lotPolygons;
  const start = pool.starts[ringIndex];
  const end = pool.starts[ringIndex + 1];
  return Array.from({ length: end - start }, (_value, i) => ({
    x: pool.coords[(start + i) * 2],
    y: pool.coords[(start + i) * 2 + 1],
  }));
};

const centroidOf = (ring: readonly Vec2[]): Vec2 => ({
  x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
  y: ring.reduce((s, p) => s + p.y, 0) / ring.length,
});

/**
 * Triangles for one pad: a fan from the centroid, then a skirt quad per edge.
 *
 * A centroid fan assumes a star-shaped ring, which is the assumption
 * `samplePolygonInteriorPoints` already makes about these same lots — if a concave
 * lot ever breaks it, this fan is where it shows, as a sliver of pad outside its
 * own boundary.
 *
 * Winding follows `roadRibbons`: clockwise in the generator's axes faces upward once
 * `y` becomes three's `z`. The skirt is a wall rather than a horizontal face, so it
 * is wound to face outward from the pad and drawn double-sided by its material —
 * a retaining wall is seen from whichever side the camera happens to be on.
 */
const padFaces = (
  model: CityModel,
  { ring, padZ }: Ring
): readonly (readonly [Vec2, number])[][] => {
  const centre = centroidOf(ring);
  const top = padZ + PAD_LIFT_M;
  const fan = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return [[centre, top] as const, [b, top] as const, [a, top] as const];
  });
  const skirt = ring.flatMap((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const groundA = groundHeightAt(model, a);
    const groundB = groundHeightAt(model, b);
    // Nothing to hide where the pad already meets the ground.
    if (Math.abs(groundA - top) < 0.05 && Math.abs(groundB - top) < 0.05) {
      return [];
    }
    return [
      [[a, top] as const, [b, top] as const, [a, groundA] as const],
      [[b, top] as const, [b, groundB] as const, [a, groundA] as const],
    ];
  });
  return [...fan, ...skirt];
};

/** Every graded lot's platform and skirt, as one mesh. */
export const padMeshOf = (model: CityModel): PadMesh => {
  const rings: readonly Ring[] = model.lots.flatMap((lot, i) =>
    model.grading.padded[i] === 1
      ? [{ ring: ringAt(model, lot.ringIndex), padZ: model.grading.padZ[i] }]
      : []
  );
  const faces = rings.flatMap((r) => padFaces(model, r));
  if (faces.length === 0) return EMPTY;

  const positions = new Float32Array(faces.length * 9);
  const indices = new Uint32Array(faces.length * 3);
  const plan = new Float32Array(faces.length * 9);
  const night = new Float32Array(faces.length * 9);
  const planRamp = groundColorRamp(model, "2d");
  const nightRamp = groundColorRamp(model, "3d");
  faces.forEach((face, f) => {
    face.forEach(([p, z], c) => {
      const o = (f * 3 + c) * 3;
      positions[o] = p.x;
      positions[o + 1] = z;
      positions[o + 2] = p.y;
      indices[f * 3 + c] = f * 3 + c;
      // Coloured by its own height on the terrain's ramp, so a pad reads as the
      // ground it is rather than as a tile laid on it. A skirt therefore shades
      // from the platform's tone at the top to the natural ground's at the foot,
      // which is what makes the cut visible without drawing a line on it.
      const day = planRamp(z);
      const dark = nightRamp(z);
      plan[o] = day[0];
      plan[o + 1] = day[1];
      plan[o + 2] = day[2];
      night[o] = dark[0];
      night[o + 1] = dark[1];
      night[o + 2] = dark[2];
    });
  });
  return { positions, indices, colors: { "2d": plan, "3d": night } };
};
