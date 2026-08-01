import * as THREE from "three/webgpu";
import {
  BUILDING_ARCHETYPES,
  type BuildingArchetype,
  type CityModel,
} from "@/entities/city";

/**
 * One `InstancedMesh` per archetype, fed straight from the worker's packed
 * matrices.
 *
 * The matrices are composed in the worker (trig-free, from `facing` unit
 * vectors) precisely so this module does no generator maths — it uploads a
 * buffer and nothing else. Megabuilding tiers arrive as additional instances in
 * the same buffer rather than as a separate mesh.
 */

interface ArchetypeStyle {
  readonly color: number;
  readonly emissive: number;
  readonly emissiveIntensity: number;
  readonly roughness: number;
}

/**
 * A `Record` over the archetype union, so adding an archetype fails to compile
 * until it has a look.
 */
const STYLES: Readonly<Record<BuildingArchetype, ArchetypeStyle>> = {
  megabuilding: {
    color: 0x1b1d24,
    emissive: 0x2b3a5c,
    emissiveIntensity: 0.55,
    roughness: 0.8,
  },
  corpoTower: {
    color: 0x14171d,
    emissive: 0x1f4f6b,
    emissiveIntensity: 0.7,
    roughness: 0.35,
  },
  casino: {
    color: 0x2a1420,
    emissive: 0xd6357a,
    emissiveIntensity: 1.35,
    roughness: 0.4,
  },
  luxuryResidence: {
    color: 0x2a2721,
    emissive: 0xc8a24a,
    emissiveIntensity: 0.5,
    roughness: 0.55,
  },
  detachedHouse: {
    color: 0x2b2b2e,
    emissive: 0x6b6552,
    emissiveIntensity: 0.18,
    roughness: 0.9,
  },
  slumShack: {
    color: 0x241f1c,
    emissive: 0x8a4a22,
    emissiveIntensity: 0.22,
    roughness: 1,
  },
};

export interface BuildingInstancesResult {
  readonly group: THREE.Group;
  readonly dispose: () => void;
}

export const createBuildingInstances = (
  model: CityModel
): BuildingInstancesResult => {
  const group = new THREE.Group();
  group.name = "buildings";

  // A unit box centred on its own base, so an instance matrix only has to
  // scale and place it — no half-height correction at upload time.
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);

  const materials = BUILDING_ARCHETYPES.map((archetype) => {
    const style = STYLES[archetype];
    const material = new THREE.MeshStandardNodeMaterial({
      color: style.color,
      emissive: style.emissive,
      emissiveIntensity: style.emissiveIntensity,
      roughness: style.roughness,
      metalness: 0.15,
    });
    const buffer = model.instances[archetype];
    if (buffer.count > 0) {
      const mesh = new THREE.InstancedMesh(geometry, material, buffer.count);
      mesh.name = archetype;
      mesh.instanceMatrix.array.set(
        buffer.matrices.subarray(0, buffer.count * 16)
      );
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    return material;
  });

  return {
    group,
    dispose: () => {
      geometry.dispose();
      materials.forEach((material) => material.dispose());
    },
  };
};
