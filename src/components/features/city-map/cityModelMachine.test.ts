import { describe, expect, it } from "vitest";
import type {
  CityModel,
  GenerationParams,
  InstanceBuffer,
} from "@/entities/city";
import {
  type CityModelEvent,
  type CityModelState,
  cityModelReducer,
  initialCityModelState,
  isModelStale,
} from "./cityModelMachine";

const params = (seed: string): GenerationParams => ({
  seed,
  sizeM: 2048,
  cells: 512,
});

const emptyInstances = (): InstanceBuffer => ({
  count: 0,
  matrices: new Float32Array(0),
  blockRanges: new Map(),
});

const model = (seed: string): CityModel => ({
  params: params(seed),
  terrain: {
    elevation: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    waterMask: new Uint8Array(1),
    waterDepth: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    seaLevelM: 0,
  },
  fields: {
    slope: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    distWater: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    distLand: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    localEminence: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    floodRisk: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    centrality: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    shadow: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    prestige: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
    decay: { cells: 1, cellSizeM: 1, data: new Float32Array(1) },
  },
  anchors: [],
  roads: {
    nodes: [],
    edges: [],
    polylines: { coords: new Float32Array(0), starts: Uint32Array.from([0]) },
  },
  blocks: [],
  blockPolygons: { coords: new Float32Array(0), starts: Uint32Array.from([0]) },
  lots: [],
  lotPolygons: { coords: new Float32Array(0), starts: Uint32Array.from([0]) },
  buildings: [],
  instances: {
    megabuilding: emptyInstances(),
    corpoTower: emptyInstances(),
    casino: emptyInstances(),
    luxuryResidence: emptyInstances(),
    detachedHouse: emptyInstances(),
    slumShack: emptyInstances(),
  },
  stageHashes: {
    terrain: "0",
    hydrology: "0",
    derived: "0",
    anchors: "0",
    social: "0",
    arterials: "0",
    blocks: "0",
    zoning: "0",
    lots: "0",
    buildings: "0",
  },
  contentHash: `hash-${seed}`,
});

/** Replay a sequence of events from the initial state. */
const run = (events: readonly CityModelEvent[]): CityModelState =>
  events.reduce<CityModelState>(
    (state, event) => cityModelReducer(state, event).state,
    initialCityModelState(params("akiba-01"))
  );

const READY_WITH_CITY: readonly CityModelEvent[] = [
  { type: "RENDERER_READY" },
  { type: "REQUEST_GENERATE" },
  { type: "WORKER_SUCCESS", requestId: 0, model: model("akiba-01") },
];

describe("boot", () => {
  it("should start in booting when freshly created", () => {
    expect(initialCityModelState(params("s")).phase).toBe("booting");
  });

  it("should reach idle when the renderer resolves with a backend", () => {
    expect(run([{ type: "RENDERER_READY" }]).phase).toBe("idle");
  });

  it("should reach unsupported when no backend exists", () => {
    expect(run([{ type: "NO_BACKEND", message: "no webgpu" }]).phase).toBe(
      "unsupported"
    );
  });

  it("should reach initFailed when init rejects for another reason", () => {
    expect(run([{ type: "INIT_FAILED", message: "device lost" }]).phase).toBe(
      "initFailed"
    );
  });

  it("should return to booting when init is retried after a transient failure", () => {
    expect(
      run([
        { type: "INIT_FAILED", message: "device lost" },
        { type: "RETRY_INIT" },
      ]).phase
    ).toBe("booting");
  });

  it("should stay unsupported when retry is attempted with no backend", () => {
    expect(
      run([{ type: "NO_BACKEND", message: "none" }, { type: "RETRY_INIT" }])
        .phase
    ).toBe("unsupported");
  });

  it("should refuse to generate when the renderer has not resolved", () => {
    expect(run([{ type: "REQUEST_GENERATE" }]).activeRequestId).toBe(null);
  });
});

describe("generation", () => {
  it("should enter generating when the first job starts", () => {
    expect(
      run([{ type: "RENDERER_READY" }, { type: "REQUEST_GENERATE" }]).phase
    ).toBe("generating");
  });

  it("should enter regenerating when a job starts with a city displayed", () => {
    expect(run([...READY_WITH_CITY, { type: "REQUEST_GENERATE" }]).phase).toBe(
      "regenerating"
    );
  });

  it("should display the model when the live job succeeds", () => {
    expect(run(READY_WITH_CITY).model?.contentHash).toBe("hash-akiba-01");
  });

  it("should record the error when the live job fails", () => {
    expect(
      run([
        { type: "RENDERER_READY" },
        { type: "REQUEST_GENERATE" },
        { type: "WORKER_FAILURE", requestId: 0, message: "boom" },
      ]).phase
    ).toBe("error");
  });

  it("should clear the active job when a job ends", () => {
    expect(run(READY_WITH_CITY).activeRequestId).toBe(null);
  });

  it("should track progress when the message belongs to the live job", () => {
    expect(
      run([
        { type: "RENDERER_READY" },
        { type: "REQUEST_GENERATE" },
        { type: "WORKER_PROGRESS", requestId: 0, stageIndex: 4 },
      ]).stageIndex
    ).toBe(4);
  });
});

describe("supersede (invariant I1)", () => {
  it("should terminate the previous worker before starting the next when superseding", () => {
    const superseded = cityModelReducer(
      run([{ type: "RENDERER_READY" }, { type: "REQUEST_GENERATE" }]),
      { type: "REQUEST_GENERATE" }
    );
    expect(superseded.effects.map((e) => e.type)).toEqual([
      "TERMINATE_WORKER",
      "START_WORKER",
    ]);
  });

  it("should advance the request id when superseding", () => {
    expect(
      run([
        { type: "RENDERER_READY" },
        { type: "REQUEST_GENERATE" },
        { type: "REQUEST_GENERATE" },
      ]).activeRequestId
    ).toBe(1);
  });

  it("should ignore the superseded job's result when it arrives late", () => {
    expect(
      run([
        { type: "RENDERER_READY" },
        { type: "REQUEST_GENERATE" },
        { type: "REQUEST_GENERATE" },
        { type: "WORKER_SUCCESS", requestId: 0, model: model("stale") },
      ]).model
    ).toBe(null);
  });
});

/**
 * Regression tests for the counterexamples the verify-spec pipeline confirmed
 * against an earlier draft of `specs/city-generation.spec.md`. Each one failed
 * on that draft.
 */
describe("verify-spec regressions", () => {
  it("should ignore a crashed message when it belongs to a superseded job (C1)", () => {
    expect(
      run([
        { type: "RENDERER_READY" },
        { type: "REQUEST_GENERATE" },
        { type: "REQUEST_GENERATE" },
        { type: "WORKER_CRASHED", requestId: 0, message: "late crash" },
      ]).phase
    ).toBe("generating");
  });

  it("should keep the live job running when a superseded worker crashes (C2)", () => {
    expect(
      run([
        { type: "RENDERER_READY" },
        { type: "REQUEST_GENERATE" },
        { type: "REQUEST_GENERATE" },
        { type: "WORKER_CRASHED", requestId: 0, message: "late crash" },
      ]).activeRequestId
    ).toBe(1);
  });

  it("should enable nothing when a generate is attempted after dispose (C3)", () => {
    expect(
      run([
        ...READY_WITH_CITY,
        { type: "DISPOSE" },
        { type: "REQUEST_GENERATE" },
      ]).phase
    ).toBe("disposed");
  });

  it("should emit no effects when an event arrives after dispose (C3)", () => {
    const disposed = run([...READY_WITH_CITY, { type: "DISPOSE" }]);
    expect(
      cityModelReducer(disposed, { type: "REQUEST_GENERATE" }).effects
    ).toEqual([]);
  });

  it("should ignore a renderer resolution when it lands after dispose (C11)", () => {
    expect(run([{ type: "DISPOSE" }, { type: "RENDERER_READY" }]).phase).toBe(
      "disposed"
    );
  });

  it("should ignore a cancelled job's success when it arrives late (C4)", () => {
    expect(
      run([
        ...READY_WITH_CITY,
        { type: "REQUEST_GENERATE" },
        { type: "CANCEL" },
        { type: "WORKER_SUCCESS", requestId: 1, model: model("cancelled") },
      ]).model?.contentHash
    ).toBe("hash-akiba-01");
  });

  it("should return to the displayed city when a regeneration is cancelled (C5)", () => {
    expect(
      run([
        ...READY_WITH_CITY,
        { type: "REQUEST_GENERATE" },
        { type: "CANCEL" },
      ]).phase
    ).toBe("ready");
  });

  it("should return to idle when a first generation is cancelled", () => {
    expect(
      run([
        { type: "RENDERER_READY" },
        { type: "REQUEST_GENERATE" },
        { type: "CANCEL" },
      ]).phase
    ).toBe("idle");
  });

  it("should allow a view switch when the last job failed (C13)", () => {
    expect(
      run([
        { type: "RENDERER_READY" },
        { type: "REQUEST_GENERATE" },
        { type: "WORKER_FAILURE", requestId: 0, message: "boom" },
        { type: "SWITCH_VIEW", viewMode: "3d" },
      ]).viewMode
    ).toBe("3d");
  });

  it("should allow a view switch when nothing has been generated yet (C13)", () => {
    expect(
      run([{ type: "RENDERER_READY" }, { type: "SWITCH_VIEW", viewMode: "3d" }])
        .viewMode
    ).toBe("3d");
  });

  it("should keep the displayed model when the view switches (I7)", () => {
    expect(
      run([...READY_WITH_CITY, { type: "SWITCH_VIEW", viewMode: "3d" }]).model
        ?.contentHash
    ).toBe("hash-akiba-01");
  });
});

describe("backend loss", () => {
  it("should become retryable when the backend is lost at runtime", () => {
    expect(
      run([
        ...READY_WITH_CITY,
        { type: "BACKEND_LOST", message: "device lost" },
      ]).phase
    ).toBe("initFailed");
  });

  it("should terminate the running job when the backend is lost mid-generation", () => {
    const generating = run([
      { type: "RENDERER_READY" },
      { type: "REQUEST_GENERATE" },
    ]);
    expect(
      cityModelReducer(generating, {
        type: "BACKEND_LOST",
        message: "device lost",
      }).effects.map((e) => e.type)
    ).toEqual(["TERMINATE_WORKER", "DISPOSE_RENDERER"]);
  });
});

describe("staleness", () => {
  it("should not be stale when nothing has been generated", () => {
    expect(isModelStale(run([{ type: "RENDERER_READY" }]))).toBe(false);
  });

  it("should not be stale when the form matches the displayed city", () => {
    expect(isModelStale(run(READY_WITH_CITY))).toBe(false);
  });

  it("should be stale when the form is edited after generating", () => {
    expect(
      isModelStale(
        run([
          ...READY_WITH_CITY,
          { type: "EDIT_PARAMS", patch: { seed: "akiba-02" } },
        ])
      )
    ).toBe(true);
  });

  it("should keep the displayed city when the form is edited", () => {
    expect(
      run([
        ...READY_WITH_CITY,
        { type: "EDIT_PARAMS", patch: { seed: "akiba-02" } },
      ]).model?.contentHash
    ).toBe("hash-akiba-01");
  });

  /**
   * The regression that motivated patches. Two edits dispatched without a
   * render between them used to be built from the same pre-edit params, so the
   * second overwrote the first: clicking an extent and a resolution together
   * kept only the resolution.
   */
  it("should keep both edits when two land without a render between them", () => {
    expect(
      run([
        ...READY_WITH_CITY,
        { type: "EDIT_PARAMS", patch: { sizeM: 1024 } },
        { type: "EDIT_PARAMS", patch: { cells: 128 } },
      ]).formParams
    ).toEqual({ ...params("akiba-01"), sizeM: 1024, cells: 128 });
  });
});
