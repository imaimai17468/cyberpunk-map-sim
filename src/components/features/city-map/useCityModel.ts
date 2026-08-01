import { useCallback, useEffect, useReducer, useRef } from "react";
import type { CityModel, GenerationParams } from "@/entities/city";
import {
  type CityModelEffect,
  type CityModelEvent,
  type CityViewMode,
  type Transition,
  cityModelReducer,
  initialCityModelState,
} from "./cityModelMachine";

/**
 * Binds the pure lifecycle machine to a real Web Worker.
 *
 * The reducer decides everything and returns effects as data; this hook is the
 * only place that actually spawns or terminates a worker. Keeping the decision
 * and the side effect apart is what let the machine be model-checked without a
 * browser, and it is why the worker cannot drift from the verified spec: if the
 * reducer does not emit START_WORKER, no worker starts.
 */

/** Messages the worker sends back. */
type WorkerOutbound =
  | {
      readonly kind: "progress";
      readonly requestId: number;
      readonly stageIndex: number;
    }
  | {
      readonly kind: "success";
      readonly requestId: number;
      readonly model: CityModel;
    }
  | {
      readonly kind: "failure";
      readonly requestId: number;
      readonly message: string;
    };

const isWorkerOutbound = (value: unknown): value is WorkerOutbound => {
  if (typeof value !== "object" || value === null) return false;
  const candidate: Record<string, unknown> = { ...value };
  const kind = candidate.kind;
  return (
    (kind === "progress" || kind === "success" || kind === "failure") &&
    typeof candidate.requestId === "number"
  );
};

const spawnWorker = (): Worker =>
  new Worker(new URL("../../../lib/citygen/worker.ts", import.meta.url), {
    type: "module",
  });

export interface CityModelController {
  readonly state: Transition["state"];
  readonly generate: () => void;
  readonly cancel: () => void;
  readonly setParams: (patch: Partial<GenerationParams>) => void;
  readonly setViewMode: (viewMode: CityViewMode) => void;
  readonly retryInit: () => void;
  readonly onRendererReady: () => void;
  readonly onNoBackend: (message: string) => void;
  readonly onInitFailed: (message: string) => void;
}

const step = (previous: Transition, event: CityModelEvent): Transition =>
  cityModelReducer(previous.state, event);

export const useCityModel = (
  initialParams: GenerationParams
): CityModelController => {
  const [transition, dispatch] = useReducer(step, {
    state: initialCityModelState(initialParams),
    effects: [],
  });

  /** The single live worker, keyed by the request id that owns it. */
  const workerRef = useRef<{ worker: Worker; requestId: number } | null>(null);

  // Latest-ref so the worker's message handler always runs current logic
  // without re-subscribing on every render.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const terminate = useCallback(() => {
    workerRef.current?.worker.terminate();
    workerRef.current = null;
  }, []);

  const runEffect = useCallback(
    (effect: CityModelEffect) => {
      if (effect.type === "TERMINATE_WORKER") {
        terminate();
        return;
      }
      if (effect.type === "START_WORKER") {
        const worker = spawnWorker();
        workerRef.current = { worker, requestId: effect.requestId };
        worker.addEventListener("message", (message: MessageEvent<unknown>) => {
          const data: unknown = message.data;
          if (!isWorkerOutbound(data)) return;
          if (data.kind === "progress") {
            dispatchRef.current({
              type: "WORKER_PROGRESS",
              requestId: data.requestId,
              stageIndex: data.stageIndex,
            });
            return;
          }
          if (data.kind === "success") {
            dispatchRef.current({
              type: "WORKER_SUCCESS",
              requestId: data.requestId,
              model: data.model,
            });
            return;
          }
          dispatchRef.current({
            type: "WORKER_FAILURE",
            requestId: data.requestId,
            message: data.message,
          });
        });
        worker.addEventListener("error", () => {
          dispatchRef.current({
            type: "WORKER_CRASHED",
            requestId: effect.requestId,
            message: "The generation worker crashed.",
          });
        });
        // The empty transfer list is the two-argument `postMessage(message,
        // transfer)` overload. `Worker.postMessage` has no `targetOrigin` —
        // that belongs to `window.postMessage` — but the lint rule only checks
        // arity, and suppressing it with a comment is forbidden by AGENTS.md.
        worker.postMessage(
          { requestId: effect.requestId, params: effect.params },
          []
        );
      }
      // INIT_RENDERER and DISPOSE_RENDERER are owned by SceneCanvas, which
      // reacts to the phase rather than to these effects.
    },
    [terminate]
  );

  // Synchronise the worker with the effects the reducer emitted.
  useEffect(() => {
    transition.effects.forEach(runEffect);
  }, [transition, runEffect]);

  // Synchronise worker teardown with the component's lifetime.
  useEffect(() => () => terminate(), [terminate]);

  return {
    state: transition.state,
    generate: useCallback(() => dispatch({ type: "REQUEST_GENERATE" }), []),
    cancel: useCallback(() => dispatch({ type: "CANCEL" }), []),
    setParams: useCallback(
      (patch: Partial<GenerationParams>) =>
        dispatch({ type: "EDIT_PARAMS", patch }),
      []
    ),
    setViewMode: useCallback(
      (viewMode: CityViewMode) => dispatch({ type: "SWITCH_VIEW", viewMode }),
      []
    ),
    retryInit: useCallback(() => dispatch({ type: "RETRY_INIT" }), []),
    onRendererReady: useCallback(
      () => dispatch({ type: "RENDERER_READY" }),
      []
    ),
    onNoBackend: useCallback(
      (message: string) => dispatch({ type: "NO_BACKEND", message }),
      []
    ),
    onInitFailed: useCallback(
      (message: string) => dispatch({ type: "INIT_FAILED", message }),
      []
    ),
  };
};
