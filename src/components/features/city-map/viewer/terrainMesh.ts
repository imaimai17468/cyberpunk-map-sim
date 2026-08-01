import * as THREE from "three/webgpu";
import type { CityModel, Field2D } from "@/entities/city";

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

/** Wairo-derived terrain palette, kept in sync with the map legend. */
const LAND_LOW: readonly [number, number, number] = [0.16, 0.17, 0.19];
const LAND_HIGH: readonly [number, number, number] = [0.42, 0.4, 0.36];
const OCEAN: readonly [number, number, number] = [0.04, 0.07, 0.12];
const RIVER: readonly [number, number, number] = [0.06, 0.12, 0.18];

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
  waterClass: number,
  heightFraction: number
): readonly [number, number, number] => {
  if (waterClass === 1) return OCEAN;
  if (waterClass === 2) return RIVER;
  return mix(LAND_LOW, LAND_HIGH, heightFraction);
};

export interface TerrainMeshResult {
  readonly mesh: THREE.Mesh;
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

  const colors = Float32Array.from({ length: vertexCount * 3 }, (_, i) => {
    const vertex = Math.floor(i / 3);
    const gx = vertex % side;
    const gy = Math.floor(vertex / side);
    const u = gx / RENDER_RESOLUTION;
    const v = gy / RENDER_RESOLUTION;
    const rgb = vertexColor(
      sampleMask(waterMask, elevation.cells, u, v),
      sampleNearest(elevation, u, v) / maxHeight
    );
    return rgb[i % 3];
  });

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
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.05,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";

  return {
    mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
};
