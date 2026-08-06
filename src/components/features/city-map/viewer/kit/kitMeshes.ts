import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Building } from "@/entities/city";
import { KIT_PARTS, type KitPart } from "./manifest";
import { expandKit, type KitMetrics } from "./expandKit";

/**
 * The half of the kit that touches THREE and the network (ADR-0029).
 *
 * `expandKit.ts` holds every decision worth testing and knows nothing about
 * either; this loads the asset, measures it, hands the numbers over and uploads
 * what comes back. The split is why the placement maths is testable against
 * written-down part sizes while the part sizes themselves are read off the mesh
 * — the asset stays the single source of its own dimensions, so re-authoring in
 * Blender needs no edit here.
 */

export interface KitMeshes {
  /** Empty until the asset arrives; added to the scene immediately regardless. */
  readonly group: THREE.Group;
  readonly setMaterial: (material: THREE.Material) => void;
  readonly dispose: () => void;
}

/**
 * The parts' own sizes, in the frame the loader leaves them in.
 *
 * The world matrix is applied rather than assumed away: the parts are authored
 * at the origin with no transform today, and a `Object3D.position` someone sets
 * in Blender tomorrow would otherwise silently shift every instance.
 */
const measure = (meshes: Readonly<Record<KitPart, THREE.Mesh>>): KitMetrics => {
  const boxes = KIT_PARTS.map((part) => {
    const mesh = meshes[part];
    const geometry = mesh.geometry.clone();
    mesh.updateWorldMatrix(true, false);
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox ?? new THREE.Box3();
    geometry.dispose();
    return { part, box };
  });
  const spanOf = (axis: "x" | "z"): number =>
    boxes.reduce(
      (max, { box }) => Math.max(max, box.max[axis] - box.min[axis]),
      0
    );
  const heightOf = (part: KitPart): number => {
    const found = boxes.find((entry) => entry.part === part);
    return found === undefined ? 0 : found.box.max.y - found.box.min.y;
  };
  return {
    partHeights: {
      base: heightOf("base"),
      floor: heightOf("floor"),
      crown: heightOf("crown"),
    },
    footprint: { x: spanOf("x"), z: spanOf("z") },
  };
};

/** The kit's three meshes, or null when the asset does not carry all of them. */
const meshesFrom = (
  root: THREE.Object3D
): Readonly<Record<KitPart, THREE.Mesh>> | null => {
  const found = KIT_PARTS.map((part) => {
    const object = root.getObjectByName(part);
    return object instanceof THREE.Mesh ? { part, mesh: object } : null;
  });
  const present = found.filter((entry) => entry !== null);
  if (present.length !== KIT_PARTS.length) return null;
  const byPart = new Map(present.map((entry) => [entry.part, entry.mesh]));
  const base = byPart.get("base");
  const floor = byPart.get("floor");
  const crown = byPart.get("crown");
  if (base === undefined || floor === undefined || crown === undefined) {
    return null;
  }
  return { base, floor, crown };
};

/**
 * Loads the kit and instances it, returning before the asset arrives.
 *
 * The group is in the scene from the first frame and fills in later, so the
 * caller stays synchronous and the boxes it already drew can be swapped out on
 * `onReady` rather than the whole scene waiting on a fetch. `dispose` is honoured
 * whenever it is called: a load that lands after it releases what it built
 * instead of attaching it, because `ADR-0010`'s machine makes `disposed` terminal
 * and nothing may touch a released scene from there.
 */
export const createKitMeshes = (
  buildings: readonly Building[],
  url: string,
  material: THREE.Material,
  onReady: () => void
): KitMeshes => {
  const group = new THREE.Group();
  group.name = "kit";
  const built: THREE.InstancedMesh[] = [];
  const state = { disposed: false, material };
  /**
   * A manager of this call's own, not the shared default one, so `abort` reaches
   * this fetch and no other. `Loader.loadAsync` takes no signal — cancellation
   * runs through the manager, which `FileLoader` threads into its own `fetch`,
   * and `GLTFLoader` builds its `FileLoader` from whatever manager it was given.
   */
  const manager = new THREE.LoadingManager();

  const releaseBuilt = (): void => {
    built.forEach((mesh) => {
      mesh.geometry.dispose();
      group.remove(mesh);
    });
    built.length = 0;
  };

  new GLTFLoader(manager).loadAsync(url).then(
    (gltf) => {
      const meshes = meshesFrom(gltf.scene);
      if (state.disposed || meshes === null) return;
      const metrics = measure(meshes);
      const buffers = expandKit(buildings, metrics);
      KIT_PARTS.forEach((part) => {
        const buffer = buffers[part];
        if (buffer.count === 0) return;
        const instanced = new THREE.InstancedMesh(
          meshes[part].geometry.clone(),
          state.material,
          buffer.count
        );
        instanced.name = part;
        instanced.instanceMatrix.array.set(buffer.matrices);
        instanced.instanceMatrix.needsUpdate = true;
        instanced.frustumCulled = false;
        group.add(instanced);
        built.push(instanced);
      });
      onReady();
    },
    (error: unknown) => {
      // A kit that will not load is a city drawn with boxes, which is what the
      // caller is already showing — so nothing is raised to the user, who has
      // nothing to do about it. It is said out loud all the same: a renamed
      // asset or a broken build config otherwise degrades to "the kit never
      // appears" with no signal at all, which is a morning lost to a debugger.
      console.warn("kit asset failed to load", url, error);
    }
  );

  return {
    group,
    setMaterial: (next: THREE.Material) => {
      state.material = next;
      built.forEach((mesh) => {
        mesh.material = next;
      });
    },
    dispose: () => {
      state.disposed = true;
      // The flag alone only stops a landed asset being attached; this stops it
      // being fetched. Regenerating repeatedly would otherwise leave one live
      // request per discarded scene, each running to completion to be thrown
      // away.
      manager.abort();
      releaseBuilt();
    },
  };
};
