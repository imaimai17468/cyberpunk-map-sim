import type { CityModel, GenerationParams } from "@/entities/city";

/**
 * The generation lifecycle, as a pure reducer.
 *
 * This is the machine formalised in `specs/city-generation.spec.md` and checked
 * by the verify-spec pipeline. Three of its shapes exist because that check
 * found counterexamples against an earlier draft, and changing them silently
 * reintroduces the bug:
 *
 * - `disposed` has no outgoing transition. Disposal is real precisely because
 *   nothing is enabled afterwards; a self-loop disabled nothing and let a worker
 *   outlive unmount.
 * - `activeRequestId` becomes `null` the moment a job ends for any reason. Every
 *   staleness guard keys on it, so a cancelled or superseded job's late message
 *   cannot match — an id that only advanced on job *start* still matched.
 * - `WORKER_CRASHED` carries a request id like every other worker message. Left
 *   unguarded it let a terminated worker's late error overwrite a live job.
 *
 * Effects are returned as data rather than performed, so the whole machine is
 * testable without a worker or a GPU.
 */

/**
 * @public the const array is the single source of the union below; exported so
 * a new member can be enumerated and every `Record` over it fails to compile
 * until handled (ADR-0027 additive extension).
 */
export const CITY_VIEW_MODES = ["2d", "3d"] as const;
export type CityViewMode = (typeof CITY_VIEW_MODES)[number];

/** @public the const array is the single source of the union below; exported so a new member can be enumerated and every `Record` over it fails to compile until handled (ADR-0027 additive extension) */
export const LIFECYCLE_PHASES = [
  "booting",
  "unsupported",
  "initFailed",
  "idle",
  "generating",
  "regenerating",
  "ready",
  "error",
  "disposed",
] as const;
/** @public published domain vocabulary: consumers narrow on this union even where the first slice does not, and it is the name a new member is added to */
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export interface CityModelState {
  readonly phase: LifecyclePhase;
  readonly nextRequestId: number;
  /** The id of the in-flight job, or null when none is running. */
  readonly activeRequestId: number | null;
  readonly model: CityModel | null;
  /** The params `model` was generated from; drives the stale indicator. */
  readonly modelParams: GenerationParams | null;
  readonly formParams: GenerationParams;
  readonly lastError: string | null;
  readonly viewMode: CityViewMode;
  readonly stageIndex: number;
}

export type CityModelEvent =
  | { readonly type: "RENDERER_READY" }
  | { readonly type: "NO_BACKEND"; readonly message: string }
  | { readonly type: "INIT_FAILED"; readonly message: string }
  | { readonly type: "RETRY_INIT" }
  | { readonly type: "EDIT_PARAMS"; readonly params: GenerationParams }
  | { readonly type: "REQUEST_GENERATE" }
  | {
      readonly type: "WORKER_PROGRESS";
      readonly requestId: number;
      readonly stageIndex: number;
    }
  | {
      readonly type: "WORKER_SUCCESS";
      readonly requestId: number;
      readonly model: CityModel;
    }
  | {
      readonly type: "WORKER_FAILURE";
      readonly requestId: number;
      readonly message: string;
    }
  | {
      readonly type: "WORKER_CRASHED";
      readonly requestId: number;
      readonly message: string;
    }
  | { readonly type: "CANCEL" }
  | { readonly type: "BACKEND_LOST"; readonly message: string }
  | { readonly type: "SWITCH_VIEW"; readonly viewMode: CityViewMode }
  | { readonly type: "DISPOSE" };

export type CityModelEffect =
  | {
      readonly type: "START_WORKER";
      readonly requestId: number;
      readonly params: GenerationParams;
    }
  | { readonly type: "TERMINATE_WORKER"; readonly requestId: number }
  | { readonly type: "INIT_RENDERER" }
  | { readonly type: "DISPOSE_RENDERER" };

export interface Transition {
  readonly state: CityModelState;
  readonly effects: readonly CityModelEffect[];
}

export const initialCityModelState = (
  formParams: GenerationParams
): CityModelState => ({
  phase: "booting",
  nextRequestId: 0,
  activeRequestId: null,
  model: null,
  modelParams: null,
  formParams,
  lastError: null,
  viewMode: "2d",
  stageIndex: 0,
});

/** Phases in which the renderer exists and can draw. */
const RENDERER_READY_PHASES: ReadonlySet<LifecyclePhase> = new Set([
  "idle",
  "generating",
  "regenerating",
  "ready",
  "error",
]);

/** Phases in which a generation job is in flight. */
const JOB_ACTIVE_PHASES: ReadonlySet<LifecyclePhase> = new Set([
  "generating",
  "regenerating",
]);

const stay = (state: CityModelState): Transition => ({ state, effects: [] });

/**
 * True only for a message belonging to the job that is actually running.
 * `activeRequestId` is null whenever no job is in flight, so a late message from
 * a finished, cancelled or superseded job can never satisfy this.
 */
const isLiveMessage = (state: CityModelState, requestId: number): boolean =>
  JOB_ACTIVE_PHASES.has(state.phase) && state.activeRequestId === requestId;

/** Terminate the in-flight worker, if there is one. */
const terminateActive = (state: CityModelState): readonly CityModelEffect[] =>
  state.activeRequestId === null
    ? []
    : [{ type: "TERMINATE_WORKER", requestId: state.activeRequestId }];

/**
 * Start a job, superseding any in-flight one. The terminate effect is emitted
 * before the start effect so the shell never holds two workers at once.
 */
const startJob = (
  state: CityModelState,
  phase: LifecyclePhase
): Transition => ({
  state: {
    ...state,
    phase,
    nextRequestId: state.nextRequestId + 1,
    activeRequestId: state.nextRequestId,
    lastError: null,
    stageIndex: 0,
  },
  effects: [
    ...terminateActive(state),
    {
      type: "START_WORKER",
      requestId: state.nextRequestId,
      params: state.formParams,
    },
  ],
});

const onRequestGenerate = (state: CityModelState): Transition => {
  if (!RENDERER_READY_PHASES.has(state.phase)) return stay(state);
  // A displayed city stays on screen while the next one generates.
  return startJob(state, state.model === null ? "generating" : "regenerating");
};

const onEditParams = (
  state: CityModelState,
  params: GenerationParams
): Transition =>
  RENDERER_READY_PHASES.has(state.phase)
    ? stay({ ...state, formParams: params })
    : stay(state);

const endJob = (
  state: CityModelState,
  patch: Partial<CityModelState>
): CityModelState => ({ ...state, ...patch, activeRequestId: null });

const onCancel = (state: CityModelState): Transition =>
  JOB_ACTIVE_PHASES.has(state.phase)
    ? {
        // Returning to `ready` rather than `idle` when a city is displayed is
        // what keeps cancel from blanking the screen.
        state: endJob(state, {
          phase: state.model === null ? "idle" : "ready",
        }),
        effects: terminateActive(state),
      }
    : stay(state);

const onBackendLost = (state: CityModelState, message: string): Transition =>
  RENDERER_READY_PHASES.has(state.phase)
    ? {
        state: endJob(state, { phase: "initFailed", lastError: message }),
        effects: [...terminateActive(state), { type: "DISPOSE_RENDERER" }],
      }
    : stay(state);

const onDispose = (state: CityModelState): Transition =>
  state.phase === "disposed"
    ? stay(state)
    : {
        state: endJob(state, { phase: "disposed" }),
        effects: [...terminateActive(state), { type: "DISPOSE_RENDERER" }],
      };

const onBoot = (state: CityModelState, event: CityModelEvent): Transition => {
  if (state.phase !== "booting") return stay(state);
  if (event.type === "RENDERER_READY") return stay({ ...state, phase: "idle" });
  if (event.type === "NO_BACKEND")
    return stay({ ...state, phase: "unsupported", lastError: event.message });
  if (event.type === "INIT_FAILED")
    return stay({ ...state, phase: "initFailed", lastError: event.message });
  return stay(state);
};

type WorkerEvent = Extract<
  CityModelEvent,
  {
    type:
      | "WORKER_PROGRESS"
      | "WORKER_SUCCESS"
      | "WORKER_FAILURE"
      | "WORKER_CRASHED";
  }
>;

/**
 * All four worker messages share one staleness guard, which is the point: a
 * message that does not belong to the running job changes nothing, whatever
 * kind it is.
 */
const onWorkerMessage = (
  state: CityModelState,
  event: WorkerEvent
): Transition => {
  if (!isLiveMessage(state, event.requestId)) return stay(state);
  if (event.type === "WORKER_PROGRESS") {
    return stay({ ...state, stageIndex: event.stageIndex });
  }
  if (event.type === "WORKER_SUCCESS") {
    return {
      state: endJob(state, {
        phase: "ready",
        model: event.model,
        modelParams: event.model.params,
        lastError: null,
      }),
      effects: terminateActive(state),
    };
  }
  return {
    state: endJob(state, { phase: "error", lastError: event.message }),
    effects: terminateActive(state),
  };
};

const onRetryInit = (state: CityModelState): Transition =>
  state.phase === "initFailed"
    ? {
        state: { ...state, phase: "booting", lastError: null },
        effects: [{ type: "INIT_RENDERER" }],
      }
    : stay(state);

const onSwitchView = (
  state: CityModelState,
  viewMode: CityViewMode
): Transition =>
  RENDERER_READY_PHASES.has(state.phase)
    ? stay({ ...state, viewMode })
    : stay(state);

export const cityModelReducer = (
  state: CityModelState,
  event: CityModelEvent
): Transition => {
  // Terminal by construction: nothing is enabled, so no late callback can start
  // a worker or touch a released scene.
  if (state.phase === "disposed") return stay(state);

  switch (event.type) {
    case "RENDERER_READY":
    case "NO_BACKEND":
    case "INIT_FAILED":
      return onBoot(state, event);
    case "RETRY_INIT":
      return onRetryInit(state);
    case "EDIT_PARAMS":
      return onEditParams(state, event.params);
    case "REQUEST_GENERATE":
      return onRequestGenerate(state);
    case "WORKER_PROGRESS":
    case "WORKER_SUCCESS":
    case "WORKER_FAILURE":
    case "WORKER_CRASHED":
      return onWorkerMessage(state, event);
    case "CANCEL":
      return onCancel(state);
    case "BACKEND_LOST":
      return onBackendLost(state, event.message);
    case "SWITCH_VIEW":
      return onSwitchView(state, event.viewMode);
    case "DISPOSE":
      return onDispose(state);
    default:
      // Unreachable: the cases above are exhaustive over CityModelEvent, and
      // TypeScript enforces that. Present only to satisfy consistent-return.
      return stay(state);
  }
};

/** True when the displayed city no longer matches the form. */
export const isModelStale = (state: CityModelState): boolean =>
  state.modelParams !== null &&
  JSON.stringify(state.modelParams) !== JSON.stringify(state.formParams);
