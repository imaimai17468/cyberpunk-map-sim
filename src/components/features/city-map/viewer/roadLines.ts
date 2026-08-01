import * as THREE from "three/webgpu";
import {
  type CityModel,
  ROAD_CLASSES,
  type RoadClass,
  type RoadEdge,
} from "@/entities/city";

/**
 * Roads as one `LineSegments` per class, drawn from the polyline pool.
 *
 * Lines are lifted slightly above the terrain because the ground mesh is a
 * displaced plane sampled at a coarser resolution than the road geometry — at
 * equal height the two z-fight along every slope.
 */

const ROAD_LIFT_M = 1.5;

const CLASS_COLOR: Readonly<Record<RoadClass, number>> = {
  highway: 0xe0b978,
  avenue: 0xb58f5a,
  street: 0x6d6a63,
  alley: 0x4a4744,
};

/** Bridges are drawn distinctly: they are the visible proof terrain shaped the roads. */
const BRIDGE_COLOR = 0x63c2d6;

const CLASS_OPACITY: Readonly<Record<RoadClass, number>> = {
  highway: 1,
  avenue: 0.9,
  street: 0.65,
  alley: 0.4,
};

/** Flatten one polyline into consecutive segment endpoints. */
const segmentsOf = (
  model: CityModel,
  edge: RoadEdge,
  elevationAt: (x: number, y: number) => number
): readonly number[] => {
  const { coords, starts } = model.roads.polylines;
  const from = starts[edge.polylineIndex];
  const to = starts[edge.polylineIndex + 1];
  const pointCount = to - from;
  if (pointCount < 2) return [];

  return Array.from({ length: pointCount - 1 }).flatMap((_unused, i) => {
    const a = (from + i) * 2;
    const b = (from + i + 1) * 2;
    const ax = coords[a];
    const ay = coords[a + 1];
    const bx = coords[b];
    const by = coords[b + 1];
    return [
      ax,
      elevationAt(ax, ay) + ROAD_LIFT_M,
      ay,
      bx,
      elevationAt(bx, by) + ROAD_LIFT_M,
      by,
    ];
  });
};

export interface RoadLinesResult {
  readonly group: THREE.Group;
  readonly dispose: () => void;
}

export const createRoadLines = (model: CityModel): RoadLinesResult => {
  const group = new THREE.Group();
  group.name = "roads";

  const { elevation } = model.terrain;
  const elevationAt = (x: number, y: number): number => {
    const u = x / model.params.sizeM;
    const v = y / model.params.sizeM;
    const cx = Math.min(
      elevation.cells - 1,
      Math.max(0, Math.floor(u * elevation.cells))
    );
    const cy = Math.min(
      elevation.cells - 1,
      Math.max(0, Math.floor(v * elevation.cells))
    );
    return elevation.data[cy * elevation.cells + cx];
  };

  // Bridges form their own bucket so they can be coloured independently of class.
  const buckets: readonly {
    readonly key: string;
    readonly color: number;
    readonly opacity: number;
    readonly edges: readonly RoadEdge[];
  }[] = [
    ...ROAD_CLASSES.map((cls) => ({
      key: cls,
      color: CLASS_COLOR[cls],
      opacity: CLASS_OPACITY[cls],
      edges: model.roads.edges.filter(
        (e) => e.cls === cls && e.crossing !== "bridge"
      ),
    })),
    {
      key: "bridge",
      color: BRIDGE_COLOR,
      opacity: 1,
      edges: model.roads.edges.filter((e) => e.crossing === "bridge"),
    },
  ];

  const disposables = buckets.flatMap((bucket) => {
    const points = bucket.edges.flatMap((edge) =>
      segmentsOf(model, edge, elevationAt)
    );
    if (points.length === 0) return [];

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(Float32Array.from(points), 3)
    );
    const material = new THREE.LineBasicNodeMaterial({
      color: bucket.color,
      transparent: bucket.opacity < 1,
      opacity: bucket.opacity,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = `roads:${bucket.key}`;
    group.add(lines);
    return [{ geometry, material }];
  });

  return {
    group,
    dispose: () => {
      disposables.forEach(({ geometry, material }) => {
        geometry.dispose();
        material.dispose();
      });
    },
  };
};
