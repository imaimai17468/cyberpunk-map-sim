import * as THREE from "three/webgpu";
import type { CityModel, Field2D, Vec2 } from "@/entities/city";
import type { CityViewMode } from "../cityModelMachine";
import {
  PLAN_LAND_HIGH,
  PLAN_LAND_LOW,
  PLAN_OCEAN,
  PLAN_RIVER,
  TERRAIN_LIT,
  TERRAIN_SHADOW,
  WATER_DEEP,
  WATER_RIVER,
  linearRgb,
} from "./palette";

/**
 * The ground plane, displaced by the elevation field.
 *
 * Rendered at a lower resolution than the generation grid: the field is up to
 * 1024 cells per axis, which would be a million vertices for detail no one can
 * see at map zoom. Sampling is nearest-cell rather than bilinear because the
 * water mask is categorical and interpolating it would produce a fringe of
 * half-water vertices along every shoreline.
 */

const RENDER_RESOLUTION = 256;

/**
 * The two readings of the same ground.
 *
 * `night` is lit ground: a narrow ramp, because at this hour the terrain is
 * barely visible and the buildings carry the image. `plan` is a topographic
 * ramp, wide enough that relief reads without any shading at all.
 */
const RAMPS = {
  night: {
    low: linearRgb(TERRAIN_SHADOW),
    high: linearRgb(TERRAIN_LIT),
    ocean: linearRgb(WATER_DEEP),
    river: linearRgb(WATER_RIVER),
  },
  plan: {
    low: linearRgb(PLAN_LAND_LOW),
    high: linearRgb(PLAN_LAND_HIGH),
    ocean: linearRgb(PLAN_OCEAN),
    river: linearRgb(PLAN_RIVER),
  },
} as const;

type Ramp = (typeof RAMPS)[keyof typeof RAMPS];

const sampleNearest = (field: Field2D, u: number, v: number): number => {
  const cx = Math.min(field.cells - 1, Math.floor(u * field.cells));
  const cy = Math.min(field.cells - 1, Math.floor(v * field.cells));
  return field.data[cy * field.cells + cx];
};

/**
 * How much ground one triangle of the drawn mesh covers.
 *
 * Callers that lay geometry over the terrain need this to know how finely to
 * cut it: a piece wider than a cell spans triangles it cannot follow.
 */
export const renderCellSizeM = (model: CityModel): number =>
  model.params.sizeM / RENDER_RESOLUTION;

/**
 * The height of the ground *as drawn*, anywhere on it.
 *
 * A different question from "what does the elevation field say here", and the
 * gap between the two is large. The mesh samples the field nearest-cell at its
 * own 257x257 vertices and the GPU runs a plane through each triangle, so the
 * drawn ground is an interpolation of a subsample: at the largest extent one
 * render cell spans 16 m of a field that carries detail every 4 m. Anything
 * that has to sit *on* the ground must ask this rather than the field.
 *
 * Roads are what forced it to exist. Reading the field directly put ribbon
 * corners as much as 8.54 m beneath the terrain drawn over them (measured at
 * `sizeM` 4096 across the three golden seeds); asked this, they start level.
 *
 * `terrainMesh.test.ts` pins this against the geometry actually emitted below,
 * because the two agreeing is the whole point and nothing else would notice
 * them drifting apart.
 */
export const groundHeightAt = (model: CityModel, p: Vec2): number => {
  const { elevation } = model.terrain;
  const size = model.params.sizeM;
  const clamp = (w: number) =>
    Math.min(
      RENDER_RESOLUTION - 1e-9,
      Math.max(0, (w / size) * RENDER_RESOLUTION)
    );
  const fx = clamp(p.x);
  const fy = clamp(p.y);
  const gx = Math.floor(fx);
  const gy = Math.floor(fy);
  const s = fx - gx;
  const t = fy - gy;
  const corner = (dx: number, dy: number) =>
    sampleNearest(
      elevation,
      (gx + dx) / RENDER_RESOLUTION,
      (gy + dy) / RENDER_RESOLUTION
    );
  // The index builder below splits every quad on the diagonal from its
  // (gx+1, gy) corner to its (gx, gy+1) one, so `s + t < 1` is the half that
  // keeps the quad's own top-left corner.
  return s + t < 1
    ? corner(0, 0) * (1 - s - t) + corner(1, 0) * s + corner(0, 1) * t
    : corner(1, 1) * (s + t - 1) +
        corner(1, 0) * (1 - t) +
        corner(0, 1) * (1 - s);
};

const sampleMask = (
  mask: Uint8Array,
  cells: number,
  u: number,
  v: number
): number => {
  const cx = Math.min(cells - 1, Math.floor(u * cells));
  const cy = Math.min(cells - 1, Math.floor(v * cells));
  return mask[cy * cells + cx];
};

const mix = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): readonly [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const vertexColor = (
  ramp: Ramp,
  waterClass: number,
  heightFraction: number
): readonly [number, number, number] => {
  if (waterClass === 1) return ramp.ocean;
  if (waterClass === 2) return ramp.river;
  return mix(ramp.low, ramp.high, heightFraction);
};

/**
 * The ground's own colour at a height, for a surface that is ground but is not this
 * mesh.
 *
 * A graded pad is ground, and painting it a colour of its own turned every levelled
 * lot into a bright tile against darker terrain — the ramp is what makes relief read
 * at all in the plan view, so a flat colour is not a neutral choice but the brightest
 * or dullest land on the map. Exported so `padMeshes` can ask the same question the
 * terrain answers for itself, against the same ramp and the same height scale.
 */
export const groundColorRamp = (
  model: CityModel,
  mode: CityViewMode
): ((heightM: number) => readonly [number, number, number]) => {
  // Hoisted deliberately. The obvious shape for this is a plain
  // `groundColorAt(model, mode, height)`, and it cost a hung browser: the scan for
  // the maximum runs over every cell in the field — 262,144 of them at the app's
  // own resolution — and a caller colouring 180,000 pad vertices called it once per
  // vertex. Handing back a closure makes the scan once per surface.
  const maxHeight = model.terrain.elevation.data.reduce(
    (m, v) => Math.max(m, v),
    1
  );
  const ramp = mode === "2d" ? RAMPS.plan : RAMPS.night;
  return (heightM: number) => vertexColor(ramp, 0, heightM / maxHeight);
};

export interface TerrainMeshResult {
  readonly mesh: THREE.Mesh;
  readonly setViewMode: (mode: CityViewMode) => void;
  readonly dispose: () => void;
}

export const createTerrainMesh = (model: CityModel): TerrainMeshResult => {
  const { elevation, waterMask } = model.terrain;
  const size = model.params.sizeM;
  const side = RENDER_RESOLUTION + 1;
  const vertexCount = side * side;
  const maxHeight = model.terrain.elevation.data.reduce(
    (m, v) => Math.max(m, v),
    1
  );

  const positions = Float32Array.from({ length: vertexCount * 3 }, (_, i) => {
    const vertex = Math.floor(i / 3);
    const gx = vertex % side;
    const gy = Math.floor(vertex / side);
    const u = gx / RENDER_RESOLUTION;
    const v = gy / RENDER_RESOLUTION;
    const axis = i % 3;
    if (axis === 0) return u * size;
    if (axis === 2) return v * size;
    return sampleNearest(elevation, u, v);
  });

  const colorsFor = (ramp: Ramp) =>
    new THREE.BufferAttribute(
      Float32Array.from({ length: vertexCount * 3 }, (_, i) => {
        const vertex = Math.floor(i / 3);
        const gx = vertex % side;
        const gy = Math.floor(vertex / side);
        const u = gx / RENDER_RESOLUTION;
        const v = gy / RENDER_RESOLUTION;
        const rgb = vertexColor(
          ramp,
          sampleMask(waterMask, elevation.cells, u, v),
          sampleNearest(elevation, u, v) / maxHeight
        );
        return rgb[i % 3];
      }),
      3
    );

  const colors = {
    "2d": colorsFor(RAMPS.plan),
    "3d": colorsFor(RAMPS.night),
  } as const;

  // Two triangles per quad, wound counter-clockwise when seen from above.
  const quads = RENDER_RESOLUTION * RENDER_RESOLUTION;
  const indices = Uint32Array.from({ length: quads * 6 }, (_, i) => {
    const quad = Math.floor(i / 6);
    const qx = quad % RENDER_RESOLUTION;
    const qy = Math.floor(quad / RENDER_RESOLUTION);
    const topLeft = qy * side + qx;
    const corners = [
      topLeft,
      topLeft + side,
      topLeft + 1,
      topLeft + 1,
      topLeft + side,
      topLeft + side + 1,
    ];
    return corners[i % 6];
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  // Bound up front so the geometry is never briefly a vertexColors material
  // with no colour attribute, whatever order the caller drives it in.
  geometry.setAttribute("color", colors["3d"]);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // Widened to `Material` so the mesh's material slot accepts either reading.
  const materials: Readonly<Record<CityViewMode, THREE.Material>> = {
    // Unlit: see PLAN_LAND_* in palette.ts for why the plan is not shaded.
    "2d": new THREE.MeshBasicNodeMaterial({ vertexColors: true }),
    "3d": new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.05,
    }),
  };

  const mesh = new THREE.Mesh(geometry, materials["3d"]);
  mesh.name = "terrain";

  return {
    mesh,
    setViewMode: (mode: CityViewMode) => {
      geometry.setAttribute("color", colors[mode]);
      mesh.material = materials[mode];
    },
    dispose: () => {
      geometry.dispose();
      materials["2d"].dispose();
      materials["3d"].dispose();
    },
  };
};
