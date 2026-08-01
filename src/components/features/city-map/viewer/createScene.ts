import * as THREE from "three/webgpu";
import type { CityModel } from "@/entities/city";
import { createBuildingInstances } from "./buildingInstances";
import { createRoadLines } from "./roadLines";
import { createTerrainMesh } from "./terrainMesh";

/**
 * Builds the whole scene for one `CityModel`.
 *
 * The scene is a dumb consumer: nothing here recomputes generator maths. It is
 * rebuilt wholesale per model and disposed as a unit, which is what lets the
 * lifecycle machine treat "swap the model" as one atomic step with an explicit
 * release of the previous GPU resources.
 */

export interface CityScene {
  readonly scene: THREE.Scene;
  readonly dispose: () => void;
}

/** Night-city key light: low, cool, and from one side so massing reads. */
const addLighting = (scene: THREE.Scene, sizeM: number): void => {
  const ambient = new THREE.AmbientLight(0x2b3550, 1.1);
  const key = new THREE.DirectionalLight(0x9fc4e8, 1.4);
  key.position.set(sizeM * 0.4, sizeM * 0.5, sizeM * 0.25);
  const fill = new THREE.DirectionalLight(0xd6357a, 0.35);
  fill.position.set(-sizeM * 0.3, sizeM * 0.2, -sizeM * 0.4);
  scene.add(ambient, key, fill);
};

export const createScene = (model: CityModel): CityScene => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080a0f);

  const terrain = createTerrainMesh(model);
  const roads = createRoadLines(model);
  const buildings = createBuildingInstances(model);

  /**
   * The generator works in world metres over `[0, sizeM]` with the origin at a
   * corner. Both cameras orbit and frame the origin, so the whole city is
   * re-centred exactly once here rather than by offsetting every coordinate at
   * every producer — one transform to get wrong instead of many.
   */
  const half = model.params.sizeM / 2;
  const root = new THREE.Group();
  root.name = "city";
  root.position.set(-half, 0, -half);
  root.add(terrain.mesh, roads.group, buildings.group);

  scene.add(root);
  addLighting(scene, model.params.sizeM);

  return {
    scene,
    dispose: () => {
      terrain.dispose();
      roads.dispose();
      buildings.dispose();
      scene.clear();
    },
  };
};
