import * as THREE from "three/webgpu";
import {
  type CityModel,
  ROAD_CLASSES,
  type RoadClass,
  type RoadEdge,
} from "@/entities/city";
import { ROAD_BRIDGE, ROAD_LAMP } from "./palette";

/**
 * Roads as one `LineSegments` per class, drawn from the polyline pool.
 *
 * Lines are lifted slightly above the terrain because the ground mesh is a
 * displaced plane sampled at a coarser resolution than the road geometry — at
 * equal height the two z-fight along every slope.
 */

const ROAD_LIFT_M = 1.5;

const CLASS_COLOR: Readonly<Record<RoadClass, number>> = {
  highway: ROAD_LAMP,
  avenue: ROAD_LAMP,
  street: 0xb08a5c,
  alley: 0x5c4a38,
};

/** Bridges stay the one cool note: they are the terrain showing through. */
const BRIDGE_COLOR = ROAD_BRIDGE;

const CLASS_OPACITY: Readonly<Record<RoadClass, number>> = {
  highway: 1,
  avenue: 0.85,
  street: 0.5,
  alley: 0.28,
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
