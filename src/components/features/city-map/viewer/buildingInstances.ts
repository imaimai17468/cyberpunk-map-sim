import * as THREE from "three/webgpu";
import {
  BUILDING_ARCHETYPES,
  type BuildingArchetype,
  type CityModel,
} from "@/entities/city";
import type { CityViewMode } from "../cityModelMachine";
import { PLAN_ARCHETYPE } from "./palette";
import { createWindowMaterial } from "./windowMaterial";

/**
 * One `InstancedMesh` per archetype, fed straight from the worker's packed
 * matrices.
 *
 * The matrices are composed in the worker (trig-free, from `facing` unit
 * vectors) precisely so this module does no generator maths — it uploads a
 * buffer and nothing else. Megabuilding tiers arrive as additional instances in
 * the same buffer rather than as a separate mesh.
 *
 * Grouping by archetype is what makes the plan view cheap: the district colour
 * is a property of the mesh, so switching views swaps six materials rather than
 * touching any per-instance data.
 */

export interface BuildingInstancesResult {
  readonly group: THREE.Group;
  readonly setViewMode: (mode: CityViewMode) => void;
  readonly dispose: () => void;
}

/**
 * Flat, unlit district fill. A plan drawing states the category and nothing
 * else — no shading to read a roof's height off, because height is the 3D
 * view's job and guessing it from a top-down tone is not.
 */
const createPlanMaterial = (archetype: BuildingArchetype) =>
  new THREE.MeshBasicNodeMaterial({ color: PLAN_ARCHETYPE[archetype] });

export const createBuildingInstances = (
  model: CityModel
): BuildingInstancesResult => {
  const group = new THREE.Group();
  group.name = "buildings";

  // A unit box centred on its own base, so an instance matrix only has to
  // scale and place it — no half-height correction at upload time.
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);

  const built = BUILDING_ARCHETYPES.map((archetype) => {
    // Widened to `Material` so the mesh's material slot accepts either reading;
    // narrowing to the night type would pin the slot to it.
    const materials: Readonly<Record<CityViewMode, THREE.Material>> = {
      "2d": createPlanMaterial(archetype),
      "3d": createWindowMaterial(archetype),
    };
    const buffer = model.instances[archetype];
    if (buffer.count === 0) return { materials, mesh: null };

    const mesh = new THREE.InstancedMesh(
      geometry,
      materials["3d"],
      buffer.count
    );
    mesh.name = archetype;
    mesh.instanceMatrix.array.set(
      buffer.matrices.subarray(0, buffer.count * 16)
    );
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    return { materials, mesh };
  });

  return {
    group,
    setViewMode: (mode: CityViewMode) => {
      built.forEach(({ materials, mesh }) => {
        if (mesh !== null) mesh.material = materials[mode];
      });
    },
    dispose: () => {
      geometry.dispose();
      built.forEach(({ materials }) => {
        materials["2d"].dispose();
        materials["3d"].dispose();
      });
    },
  };
};
