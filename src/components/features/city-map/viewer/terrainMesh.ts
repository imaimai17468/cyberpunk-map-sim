import * as THREE from "three/webgpu";
import type { CityModel, Field2D } from "@/entities/city";
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
