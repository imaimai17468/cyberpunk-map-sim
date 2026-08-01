# City generation spec

The generation lifecycle of the cyberpunk map simulator: an asynchronous WebGPU
renderer handshake, a Web Worker generation job that can be superseded or cancelled,
and a 2D/3D view switch that shares one scene.

Scope of this machine is **one mounted map component**. Every invariant below is
per-instance; a second tab or a second mounted viewer is a second machine, and
nothing here claims cross-instance exclusivity.

Extended state (context):

- `activeRequestId` — the id of the in-flight job, or `none` when no job is in
  flight. Set to a fresh id when a job starts, and back to `none` the moment a job
  ends for any reason (success, failure, crash, cancel, supersede).
- `nextRequestId: number` — monotone counter, starts at 0, only ever incremented.
- `model` — the generated city currently displayed, or `none`.
- `modelParams` — the parameters `model` was generated from, or `none`.
- `formParams` — the parameters currently in the form.
- `lastError` — the message from the most recent failure, or `none`.
- `viewMode` — `2d` or `3d`.

A model is **stale** when `model` is not `none` and `modelParams` differs from
`formParams`. Stale is a derived predicate, not a state.

## States

- `booting` — `renderer.init()` is in flight. No scene objects exist.
- `unsupported` — init reported that neither a WebGPU nor a WebGL2 backend exists.
  Nothing can ever be rendered here.
- `initFailed` — init rejected for a reason that is not backend absence (device
  lost, adapter request failed under GPU pressure). Distinct from `unsupported`
  because it is retryable.
- `idle` — renderer ready, nothing generated yet, no job in flight.
- `generating` — renderer ready, a job is in flight, nothing displayed yet.
- `regenerating` — renderer ready, a job is in flight, and a previously generated
  city is still displayed.
- `ready` — renderer ready, a city is displayed, no job in flight.
- `error` — renderer ready, the most recent job failed, no job in flight. Any
  previously displayed city stays on screen.
- `disposed` — the component unmounted. Terminal: no action is enabled, so nothing
  can start a worker, initialise a renderer, or touch a released scene.

## Initial state

booting

## Actions

| action | from | to | requires | ensures |
|---|---|---|---|---|
| rendererReady | booting | idle | init resolved with a backend | renderer initialised exactly once; empty scene root created |
| noBackend | booting | unsupported | init reported no WebGPU and no WebGL2 backend | user is told no backend exists; no worker was ever spawned |
| initFailedTransient | booting | initFailed | init rejected for any other reason | failure message names the rejection cause, not a missing backend |
| retryInit | initFailed | booting | true | a fresh init is started; no worker exists |
| editParams | idle | idle | true | formParams updated; nothing generated |
| editParams | ready | ready | true | formParams updated; model and modelParams unchanged |
| editParams | error | error | true | formParams updated |
| editParams | generating | generating | true | formParams updated; the in-flight job is untouched |
| editParams | regenerating | regenerating | true | formParams updated; the in-flight job is untouched |
| requestGenerate | idle | generating | formParams valid | activeRequestId set to nextRequestId++; exactly one live worker; job posted with that id |
| requestGenerate | ready | regenerating | formParams valid | as above; model stays displayed |
| requestGenerate | error | generating | formParams valid | as above; lastError cleared; no model displayed |
| requestGenerate | error | regenerating | formParams valid and model exists | as above; lastError cleared; model stays displayed |
| supersede | generating | generating | formParams valid | previous worker terminated before the next is spawned; activeRequestId set to nextRequestId++; exactly one live worker |
| supersede | regenerating | regenerating | formParams valid | as above; model stays displayed |
| workerProgress | generating | generating | rid equals activeRequestId | stage index updated; nothing else mutated |
| workerProgress | regenerating | regenerating | rid equals activeRequestId | stage index updated; nothing else mutated |
| staleMessage | generating | generating | rid differs from activeRequestId | nothing mutated |
| staleMessage | regenerating | regenerating | rid differs from activeRequestId | nothing mutated |
| staleMessage | idle | idle | true | nothing mutated |
| staleMessage | ready | ready | true | nothing mutated |
| staleMessage | error | error | true | nothing mutated |
| workerSuccess | generating | ready | rid equals activeRequestId | model and modelParams set from the job; activeRequestId set to none; no live worker |
| workerSuccess | regenerating | ready | rid equals activeRequestId | model and modelParams replaced; previous GPU resources released after the swap; activeRequestId set to none; no live worker |
| workerFailure | generating | error | rid equals activeRequestId | lastError set; activeRequestId set to none; no live worker |
| workerFailure | regenerating | error | rid equals activeRequestId | lastError set; model still displayed; activeRequestId set to none; no live worker |
| workerCrashed | generating | error | rid equals activeRequestId | lastError set; activeRequestId set to none; the worker owning that id is terminated; no live worker |
| workerCrashed | regenerating | error | rid equals activeRequestId | as above; model still displayed |
| cancel | generating | idle | true | the worker owning activeRequestId is terminated; activeRequestId set to none; nothing displayed |
| cancel | regenerating | ready | true | the worker owning activeRequestId is terminated; activeRequestId set to none; model unchanged and still displayed |
| backendLost | idle | initFailed | the GPU device or WebGL2 context was lost | any live worker terminated; activeRequestId set to none; user is told rendering stopped |
| backendLost | generating | initFailed | as above | as above |
| backendLost | regenerating | initFailed | as above | as above |
| backendLost | ready | initFailed | as above | as above |
| backendLost | error | initFailed | as above | as above |
| switchView | idle | idle | true | camera swapped; no scene geometry rebuilt; no worker spawned |
| switchView | generating | generating | true | camera swapped; scene geometry not rebuilt; job unaffected |
| switchView | regenerating | regenerating | true | camera swapped; scene geometry not rebuilt; job unaffected |
| switchView | ready | ready | true | camera swapped; scene geometry not rebuilt |
| switchView | error | error | true | camera swapped; scene geometry not rebuilt |
| dispose | booting | disposed | true | the pending init result can no longer be observed; no scene objects exist |
| dispose | unsupported | disposed | true | canvas released |
| dispose | initFailed | disposed | true | canvas released |
| dispose | idle | disposed | true | renderer disposed |
| dispose | generating | disposed | true | any live worker terminated; renderer disposed |
| dispose | regenerating | disposed | true | any live worker terminated; renderer disposed |
| dispose | ready | disposed | true | renderer disposed; scene geometry released |
| dispose | error | disposed | true | renderer disposed |

Superseding is deliberately unthrottled: a generate while a job is in flight
terminates that job and starts a new one, every time. An earlier draft guarded
this with a coalescing window, but nothing implements one and no invariant needs
it — I1 holds because the terminate always precedes the spawn. The cost is that
a rapid double-submit restarts the work rather than coalescing, which is a
missing feature rather than a defect in this machine.

`disposed` has no outgoing action. That is what makes disposal real: no later
event can start a worker or touch a released scene, because nothing is enabled.

## Invariants

- I1: At most one live worker exists at any time, for this component instance.
- I2: `nextRequestId` never decreases, and a worker message mutates context only
  when its rid equals `activeRequestId`. Since `activeRequestId` becomes `none` the
  moment a job ends, a message from a cancelled, superseded or already-finished job
  can never match.
- I3: In `ready`, `model` exists. In `error`, `lastError` exists.
- I4: `cancel` never discards an existing `model`.
- I5: The renderer is initialised at most once per entry into `booting`.
- I6: No scene object is constructed while in `booting`, `unsupported`,
  `initFailed`, or `disposed`.
- I7: `switchView` never changes which model is displayed.
- I8: No worker is live in `disposed`, and no action is enabled there.

## Forbidden flows

- Two live workers existing simultaneously in one instance.
- A superseded, cancelled or crashed job's result becoming the displayed model.
- Displaying a model that no `workerSuccess` produced.
- Generating anything while in `booting`, `unsupported`, `initFailed` or `disposed`.
- A worker outliving `dispose`.
- `cancel` blanking the screen when a city was already displayed.
- Reaching `unsupported` for a failure that is not backend absence.

## Requirements

- R1: From `error` the user can recover: `editParams` is unguarded there, and
  `requestGenerate` is enabled for any valid `formParams`. Recovery is therefore
  always reachable, though it may take an edit first.
- R2: Absent an explicit `cancel` or `dispose`, after the last `editParams` the
  city eventually displayed is the one generated from those parameters, never an
  older one, regardless of message interleaving.
- R3: Cancelling a regeneration returns the user to the city that was previously
  displayed, not to a blank screen.
- R4: Whenever the renderer is ready, the user can switch between the 2D and 3D
  views without triggering regeneration — including while a job is running and
  after a failure.
- R5: A user whose browser supports neither WebGPU nor WebGL2 is told so rather
  than being left on a blank canvas, and a user whose backend fails or is lost for
  any other reason is told that and offered a retry.
- R6: When `model` is stale, the UI says so, so the displayed city is never
  silently mistaken for the current parameters.
