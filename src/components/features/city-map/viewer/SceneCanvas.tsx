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

/** Radians of orbit per pixel dragged. */
const ORBIT_RADIANS_PER_PX = 0.006;
/** Exponent applied per unit of wheel delta, so zoom is multiplicative. */
const ZOOM_PER_WHEEL_UNIT = 0.0012;
/**
 * One arrow-key press, expressed as the drag it stands in for.
 *
 * Defining the keyboard step in pixels rather than in radians and metres is
 * what keeps the two input paths from drifting: both feed the same conversions
 * below, so retuning the drag sensitivity retunes the keys with it.
 */
const KEY_STEP_PX = 36;
/** One +/- press, as the wheel delta it stands in for. */
const KEY_ZOOM_DELTA = 180;
/** Assumed pixels per line, for wheel events reported in lines rather than pixels. */
const LINE_HEIGHT_PX = 16;

/**
 * Drag to look, wheel to zoom, and the same two on the keyboard.
 *
 * `createCameras` has exposed clamped `orbit` and `pan` from the start and
 * nothing ever called them, which left a 3D city you could not walk around and
 * a map you could not zoom into — the generator's whole output visible only
 * from one fixed vantage. This is the input that was missing, and it is
 * deliberately the only motion in the scene: the camera moves because the user
 * moved it, never on its own. An idling auto-orbit would fight the one thing a
 * map is for, which is holding still while you read it.
 *
 * The arrow keys and +/- mirror the pointer exactly rather than inventing a
 * second scheme: arrows are a drag of `KEY_STEP_PX`, +/- is a wheel notch, and
 * both route through the same branch, so the view a keyboard user can reach is
 * the view a mouse user can reach. Without them the camera was the one part of
 * the app no keyboard could touch — every generation parameter is already
 * reachable through the sidebar controls.
 *
 * Listeners are attached in the canvas callback ref and torn down with it, per
 * react.md's rule for element-scoped observers. Pointer capture keeps a drag
 * alive when the cursor leaves the canvas mid-gesture.
 */
const attachViewControls = (
  canvas: HTMLCanvasElement,
  state: Runtime
): (() => void) => {
  /**
   * The gesture in progress, or `pointerId: null` for none.
   *
   * The id is what keeps a second simultaneous pointer from hijacking the
   * first: without it a second finger's `pointerdown` overwrote `x`/`y`, both
   * pointers' moves fed one pair of deltas, and lifting either one ended the
   * gesture. Only the pointer that started the drag is listened to.
   *
   * `cameras` and `viewMode` are the ones the gesture began under. `moveBy`
   * reads both live, so a swap mid-drag — a size-changing regeneration rebuilds
   * the cameras — would apply the rest of the gesture to a different object, or
   * turn a pan into an orbit without the pointer ever being released. Comparing
   * against what was captured here ends the drag instead.
   */
  const drag = {
    pointerId: null as number | null,
    x: 0,
    y: 0,
    cameras: null as CityCameras | null,
    viewMode: state.viewMode,
  };

  /**
   * Metres of world per pixel of canvas, read back off the camera rather than
   * recomputed from the extent — the ortho frustum and its zoom are the only
   * authority on how far a drag should travel, and duplicating that maths here
   * would drift the moment either changes.
   */
  const metresPerPixel = (ortho: THREE.OrthographicCamera): number =>
    canvas.clientHeight > 0
      ? (ortho.top - ortho.bottom) / ortho.zoom / canvas.clientHeight
      : 0;

  const onPointerDown = (event: PointerEvent): void => {
    // Left button only. Dragging on right/middle also opened the context menu
    // over the view it had just moved, since `contextmenu` is left alone.
    if (event.button !== 0) return;
    // A second pointer arriving mid-gesture is ignored rather than taking over.
    if (drag.pointerId !== null) return;
    drag.pointerId = event.pointerId;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.cameras = state.cameras;
    drag.viewMode = state.viewMode;
    canvas.setPointerCapture(event.pointerId);
  };

  /** A drag of (dx, dy) pixels, whatever produced it. */
  const moveBy = (dx: number, dy: number): void => {
    const cameras = state.cameras;
    if (cameras === null) return;
    if (state.viewMode === "3d") {
      cameras.orbit(dx * ORBIT_RADIANS_PER_PX, dy * ORBIT_RADIANS_PER_PX, 1);
      return;
    }
    // Negated so the map follows the cursor rather than fleeing it. The ortho
    // camera's up is -z, which puts world -z at the top of the screen, so a
    // downward drag moves the target along -z.
    const metres = metresPerPixel(cameras.ortho);
    cameras.pan(-dx * metres, -dy * metres, 1);
  };

  /** A wheel of `delta`, whatever produced it. */
  const zoomBy = (delta: number): void => {
    const cameras = state.cameras;
    if (cameras === null) return;
    // Multiplicative, so a zoom step feels the same at every scale.
    const factor = Math.exp(delta * ZOOM_PER_WHEEL_UNIT);
    // Inverted between the two: for the perspective camera the factor scales
    // orbit *radius* (bigger is further away), for the ortho it scales
    // magnification (bigger is closer).
    if (state.viewMode === "3d") cameras.orbit(0, 0, factor);
    else cameras.pan(0, 0, 1 / factor);
  };

  const endDrag = (pointerId: number): void => {
    drag.pointerId = null;
    drag.cameras = null;
    if (canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (drag.pointerId !== event.pointerId) return;
    // The gesture's world changed underneath it; drop it rather than finish it
    // against something the user did not start on.
    if (state.cameras !== drag.cameras || state.viewMode !== drag.viewMode) {
      endDrag(event.pointerId);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    moveBy(dx, dy);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (drag.pointerId !== event.pointerId) return;
    endDrag(event.pointerId);
  };

  const onWheel = (event: WheelEvent): void => {
    // Without this the page scrolls behind the map while you try to zoom it.
    event.preventDefault();
    // `deltaY` is not in a fixed unit: browsers and input devices report pixels,
    // lines, or pages, and a line is worth roughly an order of magnitude more
    // than a pixel. Feeding the raw value to a constant tuned against pixels
    // makes the same physical notch feel different per browser, so convert
    // first and let `ZOOM_PER_WHEEL_UNIT` mean one thing everywhere.
    const perLine = LINE_HEIGHT_PX;
    const perPage =
      canvas.clientHeight > 0 ? canvas.clientHeight : perLine * 40;
    const scale =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? perLine
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? perPage
          : 1;
    zoomBy(event.deltaY * scale);
  };

  const KEY_MOVES: Readonly<Record<string, readonly [number, number]>> = {
    ArrowLeft: [-KEY_STEP_PX, 0],
    ArrowRight: [KEY_STEP_PX, 0],
    ArrowUp: [0, -KEY_STEP_PX],
    ArrowDown: [0, KEY_STEP_PX],
  };
  const KEY_ZOOMS: Readonly<Record<string, number>> = {
    "+": -KEY_ZOOM_DELTA,
    "=": -KEY_ZOOM_DELTA,
    "-": KEY_ZOOM_DELTA,
    _: KEY_ZOOM_DELTA,
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Ctrl/Cmd +/- is the browser's page zoom, which someone may be relying on
    // to read this at all; swallowing it to move a camera is not a trade worth
    // making. Shift is deliberately absent — `+` and `_` are shifted keys, so
    // guarding on it would disable the very bindings this exists for.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const move = KEY_MOVES[event.key];
    const zoom = KEY_ZOOMS[event.key];
    if (move === undefined && zoom === undefined) return;
    // The arrows would otherwise scroll the page out from under the map.
    event.preventDefault();
    if (move !== undefined) moveBy(move[0], move[1]);
    else zoomBy(zoom);
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKeyDown);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("keydown", onKeyDown);
  };
};

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
      const detachControls = attachViewControls(canvas, state);

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
        detachControls();
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
      {/*
        Focusable and labelled: it is a real control, not an illustration, so it
        has to be reachable by tab and has to say what it is when it gets there.
      */}
      <canvas
        ref={attachCanvas}
        tabIndex={0}
        aria-label="City view. Drag or use the arrow keys to move the camera, scroll or press plus and minus to zoom."
        className="block size-full cursor-grab touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:cursor-grabbing"
      />
    </div>
  );
}
