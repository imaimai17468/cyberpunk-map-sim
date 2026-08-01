import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
// `bloom` is an addon node, not part of the core TSL surface.
import { bloom } from "three/addons/tsl/display/BloomNode.js";
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
   * The post-processing pipeline, and the (scene, viewMode) pair it was built
   * for. `pass()` binds a specific scene and camera, so both a model swap and a
   * view switch invalidate it.
   */
  pipeline: THREE.RenderPipeline | null;
  pipelineKey: string | null;
  /**
   * The nodes hanging off `pipeline.outputNode`, which own GPU memory that
   * nothing else reclaims.
   *
   * `RenderPipeline.dispose()` frees only its own quad-mesh material and does
   * not walk `outputNode`; the renderer's caches are `WeakMap`s whose `dispose`
   * replaces the map rather than releasing what is in it, and three registers
   * no finalizer. So a `PassNode` (one render target) and a `BloomNode` (eleven,
   * plus its materials) survive every rebuild unless they are disposed by hand
   * — and the key rebuilds on every view toggle and every regeneration.
   *
   * Structurally typed so this does not depend on three's internal node types.
   */
  pipelineNodes: readonly { readonly dispose: () => void }[];
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

/**
 * Free the current post-processing pipeline and everything hanging off it.
 *
 * Idempotent, and safe to call when none has been built yet — both the rebuild
 * path and the unmount path go through here so neither can be the one that
 * forgets. See `Runtime.pipelineNodes` for why the nodes need this by hand.
 */
const releasePipeline = (state: Runtime): void => {
  state.pipeline?.dispose();
  state.pipelineNodes.forEach((node) => node.dispose());
  state.pipeline = null;
  state.pipelineNodes = [];
  state.pipelineKey = null;
};

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
    pipeline: null,
    pipelineKey: null,
    pipelineNodes: [],
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
            const camera = cameras.active(state.viewMode);
            scene.setViewMode(state.viewMode);
            const key = `${scene.id}:${state.viewMode}`;
            if (state.pipelineKey !== key) {
              // Safe to free before building the replacement: the outgoing
              // pipeline's last `render()` completed in an earlier frame of this
              // same single-threaded loop, so nothing is mid-flight.
              releasePipeline(state);

              const scenePass = pass(scene.scene, camera);
              const composed = new THREE.RenderPipeline(renderer);
              // Bloom is a photograph of light, so only the night view gets it.
              // Over the plan's flat fills it had nothing to pick out and simply
              // blew the brightest district to white, taking its outline with it
              // — the one thing a plan owes you.
              //
              // In the night view it is thresholded so only the emissive window
              // bays and the strip bleed; without a threshold the terrain glows
              // too and the whole frame turns to haze.
              if (state.viewMode === "3d") {
                const bloomNode = bloom(
                  scenePass.getTextureNode(),
                  0.85,
                  0.35,
                  0.55
                );
                composed.outputNode = scenePass.add(bloomNode);
                state.pipelineNodes = [scenePass, bloomNode];
              } else {
                composed.outputNode = scenePass;
                state.pipelineNodes = [scenePass];
              }
              state.pipeline = composed;
              state.pipelineKey = key;
            }
            state.pipeline?.render();
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
        releasePipeline(state);
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
