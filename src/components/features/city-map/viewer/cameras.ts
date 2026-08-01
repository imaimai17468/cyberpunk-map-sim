import * as THREE from "three/webgpu";
import type { CityViewMode } from "../cityModelMachine";

/**
 * Two cameras over one scene.
 *
 * The 2D map and the 3D view are the same object graph seen differently, so
 * switching modes swaps which camera is passed to `render` and rebuilds
 * nothing. That is the whole reason the renderer choice was a single
 * `three/webgpu` pipeline rather than a canvas map plus a separate 3D path.
 *
 * Trigonometry is used freely here. The ban in ADR-0027 and design §5 is scoped
 * to `src/lib/citygen/`, where it protects cross-engine hash reproducibility;
 * camera state is view-only and never reaches the model or its content hash.
 */

export interface CityCameras {
  readonly ortho: THREE.OrthographicCamera;
  readonly perspective: THREE.PerspectiveCamera;
  /** The camera for a given mode. */
  active: (mode: CityViewMode) => THREE.Camera;
  /** Re-fit both cameras to a new viewport aspect. */
  resize: (aspect: number) => void;
  /** Orbit/zoom state for the 3D view, applied to the perspective camera. */
  orbit: (deltaYaw: number, deltaPitch: number, zoomFactor: number) => void;
  /** Pan/zoom state for the 2D view. */
  pan: (deltaXM: number, deltaYM: number, zoomFactor: number) => void;
}

const MIN_PITCH = 0.12;
const MAX_PITCH = 1.45;
const MIN_ORTHO_ZOOM = 0.4;
const MAX_ORTHO_ZOOM = 12;

export const createCameras = (sizeM: number, aspect: number): CityCameras => {
  const half = sizeM / 2;

  const ortho = new THREE.OrthographicCamera(
    -half * aspect,
    half * aspect,
    half,
    -half,
    0.1,
    sizeM * 8
  );
  ortho.position.set(0, sizeM * 2, 0);
  ortho.up.set(0, 0, -1);
  ortho.lookAt(0, 0, 0);

  const perspective = new THREE.PerspectiveCamera(55, aspect, 1, sizeM * 8);

  // Spherical orbit state, in metres and radians.
  const orbitState = { yaw: 0.7, pitch: 0.55, radius: sizeM * 0.9 };
  const panState = { x: 0, y: 0, zoom: 1 };

  const applyOrbit = (): void => {
    const horizontal = Math.cos(orbitState.pitch) * orbitState.radius;
    perspective.position.set(
      Math.sin(orbitState.yaw) * horizontal,
      Math.sin(orbitState.pitch) * orbitState.radius,
      Math.cos(orbitState.yaw) * horizontal
    );
    perspective.lookAt(0, 0, 0);
  };

  const applyPan = (): void => {
    ortho.position.set(panState.x, sizeM * 2, panState.y);
    ortho.lookAt(panState.x, 0, panState.y);
    ortho.zoom = panState.zoom;
    ortho.updateProjectionMatrix();
  };

  applyOrbit();
  applyPan();

  return {
    ortho,
    perspective,
    active: (mode) => (mode === "2d" ? ortho : perspective),
    resize: (nextAspect) => {
      ortho.left = -half * nextAspect;
      ortho.right = half * nextAspect;
      ortho.top = half;
      ortho.bottom = -half;
      ortho.updateProjectionMatrix();
      perspective.aspect = nextAspect;
      perspective.updateProjectionMatrix();
    },
    orbit: (deltaYaw, deltaPitch, zoomFactor) => {
      orbitState.yaw += deltaYaw;
      orbitState.pitch = Math.min(
        MAX_PITCH,
        Math.max(MIN_PITCH, orbitState.pitch + deltaPitch)
      );
      orbitState.radius = Math.min(
        sizeM * 3,
        Math.max(sizeM * 0.08, orbitState.radius * zoomFactor)
      );
      applyOrbit();
    },
    pan: (deltaXM, deltaYM, zoomFactor) => {
      panState.x += deltaXM;
      panState.y += deltaYM;
      panState.zoom = Math.min(
        MAX_ORTHO_ZOOM,
        Math.max(MIN_ORTHO_ZOOM, panState.zoom * zoomFactor)
      );
      applyPan();
    },
  };
};
