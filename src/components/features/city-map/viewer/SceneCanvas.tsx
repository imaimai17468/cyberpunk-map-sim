import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import type { CityModel } from "@/entities/city";
import type { CityViewMode } from "../cityModelMachine";
import { type CityCameras, createCameras } from "./cameras";
import { type CityScene, createScene } from "./createScene";

/**
 * The imperative shell around the renderer.
 *
 * Everything stateful about WebGPU lives here and is reported upward as events,
 * so the lifecycle reducer stays pure. `WebGPURenderer.init()` is asynchronous
 * and can settle after unmount, which is exactly the interleaving the spec
 * verification found a hole in — hence the generation counter below: a settled
 * init whose generation is stale disposes itself instead of reporting ready.
 */

interface SceneCanvasProps {
  readonly model: CityModel | null;
  readonly viewMode: CityViewMode;
  readonly onRendererReady: () => void;
  readonly onNoBackend: (message: string) => void;
  readonly onInitFailed: (message: string) => void;
}

interface Runtime {
  renderer: THREE.WebGPURenderer | null;
  cameras: CityCameras | null;
  scene: CityScene | null;
  /** Bumped on teardown; a late async result with a stale value is discarded. */
  generation: number;
  viewMode: CityViewMode;
  /** Latest viewport aspect, kept current by the resize observer. */
  aspect: number;
  /**
   * The map extent the current cameras were built for, or null if none exist.
   *
   * Cameras cannot be created at renderer-init time: the extent is a generation
   * parameter and no model exists yet. Seeding them with a fixed size there
   * looked harmless but was not — the model-sync fallback could never fire,
   * because a model only exists after RENDERER_READY has already run, so every
   * camera stayed framed for one hardcoded extent whatever the user picked.
   */
  cameraSizeM: number | null;
}

const hasAnyBackend = (): boolean =>
  typeof navigator !== "undefined" &&
  ("gpu" in navigator ||
    (() => {
      const probe = document.createElement("canvas");
      return probe.getContext("webgl2") !== null;
    })());

export function SceneCanvas({
  model,
  viewMode,
  onRendererReady,
  onNoBackend,
  onInitFailed,
}: SceneCanvasProps) {
  const runtime = useRef<Runtime>({
    renderer: null,
    cameras: null,
    scene: null,
    generation: 0,
    viewMode,
    aspect: 1,
    cameraSizeM: null,
  });

  // Read at frame time rather than mirrored into state: the render loop is
  // imperative, so the current mode is a value it reads, not one it re-renders on.
  runtime.current.viewMode = viewMode;

  /**
   * Owns the renderer for as long as the canvas element is attached. A callback
   * ref with cleanup (React 19) rather than a mount effect, per react.md.
   */
  const attachCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas === null) return undefined;
      const state = runtime.current;
      const generation = state.generation;

      if (!hasAnyBackend()) {
        onNoBackend("This browser exposes neither WebGPU nor WebGL2.");
        return undefined;
      }

      const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));

      renderer
        .init()
        .then(() => {
          // The component may have unmounted while init was in flight.
          if (state.generation !== generation) {
            renderer.dispose();
            return;
          }
          state.renderer = renderer;
          const rect = canvas.getBoundingClientRect();
          state.aspect = rect.height > 0 ? rect.width / rect.height : 1;
          renderer.setSize(rect.width, rect.height, false);
          void renderer.setAnimationLoop(() => {
            const scene = state.scene;
            const cameras = state.cameras;
            if (scene === null || cameras === null) return;
            renderer.render(scene.scene, cameras.active(state.viewMode));
          });
          onRendererReady();
        })
        .catch((cause: unknown) => {
          if (state.generation !== generation) return;
          onInitFailed(
            cause instanceof Error ? cause.message : "Renderer init failed."
          );
        });

      return () => {
        state.generation += 1;
        void renderer.setAnimationLoop(null);
        state.scene?.dispose();
        state.scene = null;
        state.cameras = null;
        state.renderer = null;
        renderer.dispose();
      };
    },
    [onRendererReady, onNoBackend, onInitFailed]
  );

  // Synchronise the scene graph with the current model.
  useEffect(() => {
    const state = runtime.current;
    if (model === null) return undefined;
    state.scene?.dispose();
    state.scene = createScene(model);
    if (state.cameraSizeM !== model.params.sizeM) {
      state.cameras = createCameras(model.params.sizeM, state.aspect);
      state.cameraSizeM = model.params.sizeM;
    }
    return () => {
      state.scene?.dispose();
      state.scene = null;
    };
  }, [model]);

  // Synchronise the drawing buffer with the element's rendered size.
  const attachResize = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return undefined;
    const observer = new ResizeObserver(() => {
      const state = runtime.current;
      const rect = element.getBoundingClientRect();
      if (state.renderer === null || rect.height === 0) return;
      state.aspect = rect.width / rect.height;
      state.renderer.setSize(rect.width, rect.height, false);
      state.cameras?.resize(state.aspect);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={attachResize} className="relative size-full overflow-hidden">
      <canvas ref={attachCanvas} className="block size-full" />
    </div>
  );
}
