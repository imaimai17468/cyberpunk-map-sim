import * as THREE from "three/webgpu";
import type { CityModel } from "@/entities/city";
import type { CityViewMode } from "../cityModelMachine";
import { padMeshOf } from "./padMeshes";

/**
 * The levelled ground, as a mesh over the terrain (ADR-0028).
 *
 * `padMeshes` builds the geometry; this owns the material and the view swap. Two
 * things about how it is drawn are load-bearing.
 *
 * It is biased toward the camera in depth, like the roads, because a pad lies on the
 * ground it replaces and the two would otherwise trade pixels. A smaller bias than
 * any road class takes, so a carriageway crossing a pad still wins — the road is the
 * later earthwork in the same way it is the later mesh.
 *
 * It is drawn double-sided, which the terrain and the roads are not. A pad's skirt
 * is a wall, and a wall cut into a hillside is seen from below as often as from
 * above; a single-sided skirt disappears from exactly the angle that shows the
 * platform is a platform.
 */

export interface PadSurfacesResult {
  readonly group: THREE.Group;
  readonly setViewMode: (mode: CityViewMode) => void;
  readonly dispose: () => void;
}

const EMPTY: Omit<PadSurfacesResult, "group"> = {
  setViewMode: () => undefined,
  dispose: () => undefined,
};

export const createPadSurfaces = (model: CityModel): PadSurfacesResult => {
  const group = new THREE.Group();
  group.name = "pads";

  const { positions, indices, colors } = padMeshOf(model);
  if (indices.length === 0) return { group, ...EMPTY };

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors["3d"], 3));

  const material = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "pads:surface";
  group.add(mesh);

  return {
    group,
    setViewMode: (mode: CityViewMode) => {
      geometry.setAttribute(
        "color",
        new THREE.BufferAttribute(colors[mode], 3)
      );
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
};
