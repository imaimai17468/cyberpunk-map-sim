import * as THREE from "three/webgpu";
import {
  type CityModel,
  ROAD_CLASSES,
  type RoadClass,
  type Vec2,
} from "@/entities/city";
import { polylinePoints } from "@/lib/citygen/stages/roadGeometry";
import type { CityViewMode } from "../cityModelMachine";
import { PLAN_ROAD, PLAN_ROAD_BRIDGE, ROAD_BRIDGE } from "./palette";
import { ribbonOf } from "./roadRibbons";
import { renderCellSizeM } from "./terrainMesh";

/**
 * Roads as surfaces of their real width, one mesh per class.
 *
 * They used to be `LineSegments`, which draws one device pixel however far you
 * zoom: a 30 m highway and a 4 m alley came out the same hairline. `linewidth`
 * does not help — three's WebGPU backend, the one this app renders through,
 * never reads the property at all (checked in 0.185.1: it appears nowhere under
 * `renderers/webgpu/` or `renderers/common/`, only on the material that stores
 * it). Once the generator began reserving the carriageway — blocks are inset by
 * half of `ROAD_WIDTH_M` wherever a road bounds them — the hairline became a
 * visible lie, because the space was there in the model and nothing filled it.
 * `roadRibbons` builds the surface from the same widths the inset uses.
 *
 * Grouped by class rather than by edge so a class is one draw call and one
 * material, which is also what lets the two views swap colour without touching
 * geometry.
 */

/**
 * How far the road surface floats above the ground under it.
 *
 * Only a residual now. The ribbon's corners are placed by `groundHeightAt`, so
 * they land on the drawn terrain rather than on the elevation field the terrain
 * was subsampled from — that difference alone was up to 8.54 m — and each quad
 * is cut to one render cell so it cannot plank across the relief between them.
 * What is left is the dip inside a single quad, where the flat quad passes
 * under the piecewise-linear ground it spans.
 *
 * Measuring that needs its method stated, because the answer moves with it.
 * Sample a grid across each quad, take the worst gap per quad, and pool those
 * over the three golden seeds at both extents: the worst quad on the map dips
 * around 8 m, and well under 1% of quads dip past 4 m. Pooling every sample
 * point instead of taking each quad's worst moves the middle of the
 * distribution by several times, which is why no median is quoted here — it
 * would be a number about the sampling, not about the roads.
 *
 * So 4 m, which is also a metre less float than the 6 m this needed while the
 * road was still reading the raw field. The offset below handles the coplanar
 * case; this handles the rough one.
 */
const ROAD_LIFT_M = 4;

/**
 * Which road wins where two of them cover the same ground.
 *
 * Every junction is such a place: a street ending on an avenue puts its last
 * quad inside the avenue's carriageway, at the same height, and with one shared
 * offset the two coplanar surfaces would trade pixels — the tie broken by
 * whatever order the buckets happen to be built in. Ranking the bias by class
 * decides it instead, and decides it the way a real junction reads: the bigger
 * road runs through, the smaller one meets it.
 */
const depthBiasOf = (cls: RoadClass): number =>
  -4 - (ROAD_CLASSES.length - ROAD_CLASSES.indexOf(cls));

/**
 * Night: asphalt catching lamplight, not lamplight itself.
 *
 * These were `ROAD_LAMP` — a bright amber — back when a road was a one-pixel
 * line, where a lamp colour is exactly right: a thin bright thread reads as a
 * lit street. Painting a *surface* that colour turned every road into a glowing
 * floor and the network into a web of white ribbons laid over the city, which
 * is the opposite of what a road does at night. A road at night is dark, with
 * light pooled along it.
 *
 * So the tone is near the terrain's, lifted just enough to separate, and the
 * ordering by class comes from how much lamplight the class would carry.
 */
const NIGHT_COLOR: Readonly<Record<RoadClass, number>> = {
  highway: 0x4a3a28,
  avenue: 0x3d3021,
  street: 0x2b231a,
  alley: 0x201a14,
};

/**
 * Roads are opaque in both views.
 *
 * Worth saying because they were not: the old hairlines faded the smaller
 * classes out so they would not clutter the map. A surface cannot use that
 * trick — at 0.5 the terrain ramp shows through and mixes into the road's own
 * tone, so the four classes stop reading as an ordered set and a street over
 * dark ground looks like a different class from the same street over light
 * ground. Nothing sets `opacity` now; the material default is already 1.
 */

/**
 * A bridge is coloured apart in both views, but not with the same colour.
 *
 * At night the cool cyan is the point: it is the terrain showing through where
 * the city had to span it, and the one cool note in a sodium image. Carried
 * unchanged into the plan it stopped reading as a road — see `PLAN_ROAD_BRIDGE`
 * for the measurement, which is about the road family's own near-neutral tones
 * rather than about the map's loudest colours.
 */
const BRIDGE_COLOR: Readonly<Record<CityViewMode, number>> = {
  "3d": ROAD_BRIDGE,
  "2d": PLAN_ROAD_BRIDGE,
};

export interface RoadLinesResult {
  readonly group: THREE.Group;
  readonly setViewMode: (mode: CityViewMode) => void;
  readonly dispose: () => void;
}

interface Bucket {
  readonly cls: RoadClass;
  readonly bridge: boolean;
  /** Whole polylines, not loose segments: the turns are where the width shows. */
  readonly polylines: readonly (readonly Vec2[])[];
  /** Each polyline's graded profile, one height per vertex (ADR-0028). */
  readonly profiles: readonly (readonly number[])[];
}

/**
 * The road's own level at a point, read off its graded profile.
 *
 * The point is projected onto the polyline and the profile interpolated along the
 * segment it lands on, so a ribbon corner half a carriageway off the centreline
 * still gets the centreline's height — a road is level across its width. Reading
 * `groundHeightAt` per corner instead is what used to make the surface ride every
 * bump the road was cut through, and it is also why the two kerbs could sit at
 * different heights on a side slope.
 *
 * A linear scan over the polyline's own vertices. The arterials are the only lines
 * long enough for that to matter and there are a few dozen of them; streets have two
 * vertices apiece.
 */
const profileHeightAt = (
  line: readonly Vec2[],
  profile: readonly number[],
  p: Vec2
): number => {
  const best = line.slice(0, -1).reduce(
    (acc, a, i) => {
      const b = line[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby;
      const t =
        lenSq < 1e-12
          ? 0
          : Math.min(
              1,
              Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq)
            );
      const dx = p.x - (a.x + abx * t);
      const dy = p.y - (a.y + aby * t);
      const d = dx * dx + dy * dy;
      return d < acc.d
        ? { d, z: profile[i] + (profile[i + 1] - profile[i]) * t }
        : acc;
    },
    { d: Number.POSITIVE_INFINITY, z: profile[0] }
  );
  return best.z;
};

/**
 * The matcher pairs this with a 13-line barycentric helper in
 * `terrainMesh.test.ts`. They share no logic. The no-loops rule gives every
 * function in this repo the same `Array.from` / `reduce` / `flatMap` skeleton,
 * and the windowed comparison finds that shape rather than any duplication.
 */
// similarity-ignore: spurious pair with terrainMesh.test.ts's heightIn — see above
export const createRoadLines = (model: CityModel): RoadLinesResult => {
  const group = new THREE.Group();
  group.name = "roads";

  const maxSpanM = renderCellSizeM(model);

  // Bridges get their own bucket per class so they can be coloured apart
  // without losing the width their class gives them.
  const buckets: readonly Bucket[] = ROAD_CLASSES.flatMap((cls) =>
    [false, true].map((bridge) => ({
      cls,
      bridge,
      polylines: model.roads.edges
        .filter((e) => e.cls === cls && (e.crossing === "bridge") === bridge)
        .map((e) => polylinePoints(model.roads, e.polylineIndex)),
      profiles: model.roads.edges
        .filter((e) => e.cls === cls && (e.crossing === "bridge") === bridge)
        .map((e) => {
          const start = model.roads.polylines.starts[e.polylineIndex];
          const end = model.roads.polylines.starts[e.polylineIndex + 1];
          return Array.from(
            { length: end - start },
            (_v, i) => model.grading.roadZ[start + i]
          );
        }),
    }))
  );

  const built = buckets.flatMap((bucket) => {
    if (bucket.polylines.length === 0) return [];
    const { positions, indices } = ribbonOf(
      bucket.polylines,
      bucket.cls,
      (p, line) =>
        profileHeightAt(bucket.polylines[line], bucket.profiles[line], p) +
        ROAD_LIFT_M,
      maxSpanM
    );
    if (indices.length === 0) return [];

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Unlit in both views. In the plan that matches the terrain and the
    // district fills; at night an unlit surface at a lamp's colour is what
    // reads as a lit road from above, and lighting it would only darken it.
    // A road is pavement lying on the ground, so it is exactly the case polygon
    // offset exists for: bias it toward the camera in depth without moving it
    // in space, and it stops trading pixels with the terrain. Honoured on this
    // renderer — three's WebGPU backend feeds the three properties into
    // `depthBias` / `depthBiasSlopeScale` for triangle-list topology
    // (`WebGPUPipelineUtils.js`, 0.185.1).
    const bias = depthBiasOf(bucket.cls);
    const material = new THREE.MeshBasicNodeMaterial({
      color: bucket.bridge ? BRIDGE_COLOR["3d"] : NIGHT_COLOR[bucket.cls],
      polygonOffset: true,
      polygonOffsetFactor: bias,
      polygonOffsetUnits: bias,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `roads:${bucket.cls}${bucket.bridge ? ":bridge" : ""}`;
    group.add(mesh);
    return [{ bucket, geometry, material }];
  });

  return {
    group,
    setViewMode: (mode: CityViewMode) => {
      built.forEach(({ bucket, material }) => {
        const night = mode === "3d";
        material.color.setHex(
          bucket.bridge
            ? BRIDGE_COLOR[mode]
            : night
              ? NIGHT_COLOR[bucket.cls]
              : PLAN_ROAD[bucket.cls]
        );
      });
    },
    dispose: () => {
      built.forEach(({ geometry, material }) => {
        geometry.dispose();
        material.dispose();
      });
    },
  };
};
