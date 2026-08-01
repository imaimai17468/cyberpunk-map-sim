<!--
Provenance: produced by the `design-city-generator` judge-panel workflow
(3 independent architecture proposals -> 3 adversarial judges on separate lenses
-> synthesis), then re-synthesised once after the repo's `style-rules/no-loops`
constraint was discovered. Section 12 exists because of that second pass.
Measured on 2026-08-01 in this repo, and relied on by section 12:
  - oxlint reports `for`/`while`; `Array.from(...).reduce`, tail recursion and
    `Float32Array.map` pass.
  - max JS recursion depth ~9,765 frames (node/V8), against 262,144 grid cells --
    which is why per-cell recursion is banned and `boundedDrain` chunks at 4,096.
-->

# Cyberpunk City Generator — Final Design
## "Strata/S": layered scalar fields, subdivision-discretized

## 1. Overview and thesis

**Thesis:** terrain generation produces a stack of continuous scalar fields (elevation, slope, water distance, eminence, flood risk, centrality, shadow, prestige, decay); a small terrain-following arterial graph carves the map into regions; every region is recursively subdivided into blocks whose cut *orientation* is sampled from the fields — so district borders are always street edges, roads always have a terrain reason, and no stage ever traces an unbounded trajectory that would be untestable, loop-dependent, or nondeterministic.

The base is Proposal 1 (Strata). Its field stack, geodesic centrality, shadow field, argmax block zoning, and determinism discipline are the strongest ideas in the panel and all three judges scored them highly. Its one structurally weak stage — free RK4 tensor-streamline tracing — is **removed**, not patched: it was Judge 1's "snapshot suite in disguise", Judge 2's "transition-zone spaghetti", Judge 3's "O(n²) planarization freeze", and (decisively, given the lint constraints discovered in this repo) an inherently sequential, unbounded iteration that has no honest loop-free formulation. Roads are instead produced by two bounded, per-decision-testable mechanisms: **Dijkstra geodesic arterials** between field-derived anchors (bridges emerge from the cost surface) and **orientation-field-guided recursive subdivision** (streets are cut segments, blocks are subdivision leaves — planarization and face-walking of a dense street graph never happens). The tensor idea survives in a bounded role: it picks cut angles, and its degenerate case is one explicit, tested fallback branch.

Grafts adopted from the other proposals (each credited where it appears): megalot arcologies on the corporate/slum rim, relief veto + shack terracing, slenderness clamp, casino facing-snap, slum landlocked-lot exception (P2); tiered megabuildings, floor-quantized shacks, plaza-not-void, closed-form building-count control, block-sorted instance ranges (P3); per-stage content hashes, stream-independence test, subtree-reconstruction test, PRNG known-answer vectors (Judges 1/3).

## 2. Fatal-flaw dispositions

Every flaw named by a judge, and how the final design answers it:

| # | Flaw (judge) | Disposition |
|---|---|---|
| 1 | P1 roads are a snapshot suite; RK4 fixtures break wholesale on retune (J1) | **Resolved by removal.** No streamline tracing exists. Arterial tests assert path *properties* on tiny grids (cost of chosen path ≤ alternative, bridge flag on a hand-built channel); cut tests assert a single cut decision per fixture. |
| 2 | P1 degenerate-tensor branch unspecified (J1) | **Resolved.** The orientation field only selects cut angles. Blend magnitude < 0.05 → explicit fallback branch: cut perpendicular to the polygon's OBB long axis. Both sides tested. |
| 3 | P1 O(n²) planarization freeze at street density (J3) | **Resolved structurally.** Only ~10–14 arterial polylines are ever planarized (spatial-hash bucketed, ≤ a few thousand candidate pairs). Streets are cut segments of a subdivision tree — they intersect nothing by construction. |
| 4 | P1 empty-suburb / road-coverage coupling (J2) | **Resolved structurally.** Subdivision covers every land region unconditionally; block target area grows with distance from the core instead of streets thinning to nothing. There is no urban-mask threshold to under-cover. |
| 5 | P1 slope-edge floating/clipped buildings (J2) | **Resolved by graft (P2).** 5-point under-footprint relief sample; relief > 6 m vetoes every archetype except `slumShack`, which terraces (stepped `baseZM`). Vetoed parcels become `plaza` (P3 graft), never holes. |
| 6 | P1 weak-seed casino strip (J2) | **Resolved.** The strip is constructed explicitly: a waterfront-band-discounted Dijkstra arterial through the casino anchor, always tagged `strip`; casino lots within 40 m snap facing perpendicular to it (P2 graft). The strip exists on every seed by construction. |
| 7 | P2 circular segId determinism / whole-city hash churn (J1) | **Not inherited** (no growth loop). All entity substreams key on ids that are stable under parameter tuning (block ids from deterministic subdivision paths, lot indexes). Per-stage hashes (`stageHashes`) localize any golden failure to the first divergent stage. |
| 8 | P2 emergent building count + retry loop (J1/J3) | **Resolved, amended in implementation.** Closed-form count control: before lot subdivision, `expected = Σ blockArea/targetLotArea(district)`; a single deterministic `lotAreaScale` is applied once. No retry, no second pipeline run. Two corrections were needed once it was measured. (a) `expected` assumes leaves land *on* the target area, but bisection stops at or under it, so leaves occupy (target/2, target] — measured 1.41x more lots than predicted, now carried as `LOTS.subdivisionOvershoot`. (b) The target was the absolute 5,500 below, which is only meaningful at this design's ~4 km² extent; `sizeM` spans 1024-4096 (a 16x area range) so the upper clamp saturated and the control stopped governing above the default size. It is now a density, `LOTS.targetBuildingDensityPerKm2 = 1311.3` — exactly 5,500 over 4.194 km², so that arithmetic leaves the *target* unchanged, though the default map's count does change because (a) lands in the same revision (measured on akiba-01: 8,300 -> 5,706, ~31%). **The clamp still saturates for some (seed, extent, cells) combinations** — measured unclamped scales against the 1.8 ceiling: 1.8408 at 4096 m/256 cells, 1.9055 at 4096 m/128, 1.8476 at 1024 m/128 — because `expected` does not grow linearly with area (4x area gave 5.14x `expected`). Where it saturates the control stops governing and the residual is absorbed silently; measured density stays in band regardless (~1220-1465/km² over 27 combinations), so this is an accepted bound, not an eliminated one. The invariant test asserts buildings per km² across 1024/2048/4096, not an absolute band. |
| 9 | P2 engine in the presentation layer (J3) | **Resolved.** Engine lives in `src/lib/citygen/` (pure, no component affinity, could ship as a library — the react.md test for `src/lib`). See §8. |
| 10 | P2 road-class extension breaks schema (J3) | **Resolved.** `RoadClass` is a const-array union; all per-class parameters are `Record<RoadClass, T>` built from that array — adding a class is additive. |
| 11 | P2 moth-eaten periphery / dropped faces (J2) | **Not inherited.** No face-size discard exists; every region subdivides. |
| 12 | P2 missing luxury archetype on flat seeds (J2) | **Mitigated, residual accepted.** Zoning is *relative* argmax, so some blocks always win luxury where prestige peaks, and the 25 % ridged-multifractal blend guarantees a ridge exists. There is still no closed-form proof all six districts appear on *every* seed; accepted because argmax-over-relative-scores degrades to "least luxury-ish luxury" rather than absence, and a pipeline invariant test asserts all districts appear on the three fixture seeds. |
| 13 | P3 cellular seams, no through-roads (J2) | **Not inherited.** Arterials cross the whole map (CBD→edges, CBD→anchors, shore strip); regions between them span multiple districts; the orientation field is continuous in space, so street grain flows across region and district borders. Zoning happens *after* streets and never constrains them. |
| 14 | P3 `pow(u, 1/α)` Pareto breaks cross-engine hashes (J1) | **Resolved.** No `pow`, no `exp` anywhere. Heavy-tail skyline via an explicit spike branch (§5), `c·sqrt(c)` for the 1.5-exponent, rational falloffs `1/(1+x²)` and `smoothstep` everywhere else. |
| 15 | P3 unpinned heap tie-breaks (J1) | **Resolved.** Every heap key is lexicographic and total, ending in a unique integer: hydrology `(elev, cellIndex)`, centrality/arterials `(cost, cellIndex)`. Specified in §4, enforced by heap tests. |
| 16 | P3 z.lazy dual serialization drift (J1) | **Not inherited.** The model is flat (no recursive node tree). One canonical binary serializer feeds both hashing and (future) transport. Zod validates `GenerationParams` only — the actual external boundary. |
| 17 | P3 tree-level insertion reshuffles all path streams (J3) | **Not inherited.** Flat stage outputs; substream keys are `(stageLabel, entityId…)`, not tree paths; inserting a stage adds a new label without renumbering anything. |
| 18 | P3 dual-representation clone bloat; `z.literal(2048)` (J3) | **Resolved.** Polygon rings live in pooled `Float32Array`s with offset tables; instances are packed in the worker; `sizeM` is a ranged `z.number()` with default. |
| 19 | P1 per-entity fork discipline is convention only (J1) | **Accepted, with teeth added.** The subtree-reconstruction test (J1 graft from P3) regenerates one block's lots+buildings in isolation from `(block, fork keys)` and asserts byte-equality with pipeline output — a shared-draw leak fails this test, not just the golden hash. |
| 20 | three/webgpu API drift (P1 risk) | **Accepted.** Locked decision; exact import/init shape verified against current three.js docs at implementation time per Knowledge Currency. §6 describes integration at the level that cannot drift. |

## 3. Pipeline stages

All stages are pure functions in `src/lib/citygen/stages/`, composed by `pipeline.ts`. Grid: 512×512 cells over 2048×2048 m (4 m cells) by default. Every numeric parameter below is a named constant in `src/lib/citygen/constants.ts`.

### Stage 1 — `terrain`: elevation
- **Algorithm:** in-repo OpenSimplex2S (integer-hash gradient tables, no transcendentals), 6-octave fBm, base frequency 1/1400 m⁻¹, lacunarity 2.0, gain 0.5; 2-octave domain warp, amplitude 180 m; 25 % ridged-multifractal blend (`1−|n|`) for one dominant ridge. Normalized to [0, 220] m, stored `Float32Array`.
- **Input:** `GenerationParams`, stream `"terrain"`. **Output:** `Field2D elevation`.

### Stage 2 — `hydrology`: sea, lakes, river
- **Algorithm:** sea level = 18th percentile of elevation (every seed gets a coast). Priority-flood depression fill (Barnes 2014), heap key `(elevation, cellIndex)`. D8 flow accumulation: cell indices sorted by `(elevation desc, index asc)`, one pass pushing accumulation downhill. River cells = accumulation > 1.5 % of cells; carved 2 m, dilated twice.
- **Output:** `waterMask (none|ocean|river)`, `waterDepth`, corrected `elevation`, `seaLevelM`.

### Stage 3 — `derived`: slope, distances, eminence, flood risk
- **Algorithm:** slope = central-difference gradient magnitude. `distWater` = exact Felzenszwalb–Huttenlocher EDT from water cells; `distLand` = EDT from land cells (over water — feeds the bridge span limit). `localEminence` = elevation − 3-pass box blur (radius 64 cells). `floodRisk = smoothstep(8,0, elev−sea) · smoothstep(120,0, distWater)`.
- **Output:** `slope`, `distWater`, `distLand`, `localEminence`, `floodRisk`.

### Stage 4 — `anchors`
- **Algorithm (P1, unchanged):** deterministic argmax on an 8× downsampled 64×64 grid, ties broken by lowest cell index. CBD = argmax(0.4·(1−slopeN) + 0.3·band(distWater, 60–400 m) + 0.3·centerBias). Four megablock seeds by farthest-point sampling over cells with `(1−slopeN)·(1−floodRisk) > 0.6`. Casino anchor = argmax(waterfront band · flatness · CBD proximity), excluding the CBD block.
- **Output:** `Anchor[]` (`cbd`, `mega`×4, `casino`).

### Stage 5 — `social`: centrality, shadow, prestige, decay
- **Algorithm (P1, exp-free):** `costSurface = 1 + 8·slopeN + 1000·isWater`. `centrality = 1/(1+(dCbd/900)²)` with `dCbd` = Dijkstra geodesic distance over `costSurface`, heap key `(cost, cellIndex)`. `shadow = Σ_megaSeeds (1 − smoothstep(0, 260, dist))`. `prestige = clamp01(0.40·eminenceN + 0.25·band(distWater,60–400) + 0.20·(1−smoothstep(0.10,0.30,slope)) − 0.35·floodRisk − 0.30·shadow)`. `decay = clamp01(0.45·(1−centrality) + 0.25·floodRisk + 0.20·smoothstep(0.15,0.35,slope) + 0.30·shadow − 0.30·prestige)`.
- **Output:** `FieldStack` complete.

### Stage 6 — `arterials`: terrain-following arterial graph
- **Algorithm:** three families of geodesic paths over `arterialCost = 1 + 8·slopeN + waterCost`, where `waterCost = 60` for water cells with `distLand ≤ 120 m` and `∞` (excluded) beyond — so any water crossing on a chosen path spans ≤ 240 m and *is* a bridge (maximal water runs flagged `crossing: "bridge"`).
  1. **Highways:** CBD → each of the 4 map-edge midpoints (per-path Dijkstra with predecessor backtrack).
  2. **Avenues:** CBD → each mega seed, CBD → casino anchor.
  3. **Strip avenue:** the two points 450 m either side of the casino anchor along the shore (argmax of waterfront-band score on the downsampled grid, tie-break by index) joined by Dijkstra over `arterialCost · (1 − 0.6·band(distWater,60–400))` — a shore-hugging path through the anchor's neighborhood, tagged `strip: true`. Exists on every seed.
  - Paths are grid polylines → Douglas-Peucker simplify (ε = 6 m). Planarize *only these* (~10–14 polylines): spatial-hash (64 m buckets) candidate pairs, exact segment intersection, split at crossings, snap nodes < 12 m (0.25 m lattice round). Road classes as listed; every edge keeps `crossing: "none" | "bridge"` (enum — tunnels are one member away).
- **Output:** `RoadGraph` (arterial edges only, with polylines), planar.

### Stage 7 — `blocks`: regions and orientation-guided subdivision
- **Algorithm:**
  1. **Regions:** half-edge face traversal on the arterial graph unioned with the map-border rectangle. Outgoing edges sorted by comparison-only pseudo-angle (no `atan2`). Outer face discarded. Faces are super-block regions (tens, not thousands).
  2. **Orientation field** (bounded tensor graft): at point p, blend line-tensors (2θ representation `(x²−y², 2xy)` from unit vectors — no trig): CBD grid tensor at per-seed direction `θ_cbd` (unit vector from the Weierstrass rational parametrization of a `"roads"`-stream draw, §5) weighted `centrality·sqrt(centrality)`; contour tensor (elevation gradient rotated 90°) weighted `smoothstep(0.12, 0.25, slope)`; shore tensor (distWater gradient rotated 90°) weighted `max(0, 1−distWater/300)`. Normalize; magnitude < 0.05 → **fallback branch: OBB long-axis perpendicular**.
  3. **Recursive subdivision:** per region, recurse: compute OBB (monotone-chain hull + rotating calipers); stop when `area ≤ targetBlockArea(p)` where target = `lerp(1400 m², 9000 m², 1 − urbanIntensity)` and `urbanIntensity = clamp01(0.6·centrality + 0.4·prestige + 0.3·decay)`; else cut through the OBB center point offset `t ∈ [0.42, 0.58]` (substream `fork("blocks", regionId, depth, childPath)`) along the long axis, cut direction = orientation-field direction unless `|dot(cutDir, longAxis)| > 0.8` (→ perpendicular fallback, guarantees area decrease/termination); in cells with `decay > 0.6` the cut direction is additionally blended 0.35 toward a hashed random unit vector (slum tangle). Cut segments become `street` edges (or `alley` when emitted below the second subdivision depth inside `decay > 0.6`). Blocks whose ≥ 50 % sample points are water are marked water blocks (no lots); cut segments with midpoint in water are dropped.
  4. **Block identity & adjacency:** `blockId` = deterministic DFS order of the subdivision tree (stable under sibling-content changes). Every block boundary segment records provenance (`cutId | arterialEdgeId | border | water`); adjacency = blocks sharing a provenance id. No geometric epsilon adjacency anywhere.
- **Output:** `Block[]` (pooled polygons, provenance, adjacency), street/alley `RoadEdge`s appended to `RoadGraph`.

### Stage 8 — `zoning`: per-block argmax + megablock rules
- **Algorithm (P1 + grafts):** sample fields at centroid + 4 interior points (area-weighted mean). Affinities: `corporate = 2.2·centrality + 0.5·prestige − 1.5·decay`; `casino = 3.0·stripAdjacency + 1.2·band(distWater) + 0.8·centrality`; `luxury = 2.0·prestige + 1.0·eminenceN − 1.2·centrality − 2.0·decay`; `suburb = 1.0 − 0.8·centrality − 1.0·decay − 0.6·slopeN + 0.3·prestige`; `slum = 2.0·decay + 1.2·shadow + 0.8·floodRisk`. `district = argmax` (fixed evaluation order for exact-tie break). Blocks containing a mega seed → forced `megablock`. Mode filter: 2 iterations, **synchronous double-buffer** (all reads from generation k, writes to k+1 — fixes J1's order-dependence), adopt majority label iff ≥ 4 provenance-neighbours agree AND own margin < 0.08. **Megalot rim pass (P2 graft):** corporate blocks with area ≥ 12,000 m² adjacent to a slum block → `megablock`; the set is computed from post-filter labels and applied simultaneously.
- **Output:** `Block[]` with `district` and `scoreMargin` (kept for tuning).

### Stage 9 — `lots`
- **Algorithm:** closed-form count control first: `expected = Σ_blocks area/targetLotArea(district)`; `lotAreaScale = clamp(expected * subdivisionOvershoot / (targetDensityPerKm2 * areaKm2), 0.6, 1.8)` applied to all targets once — see flaw #8 for why the overshoot factor and the density denominator are both needed. Then per block: recursive OBB bisection, split at `t ∈ [0.42,0.58]` from `fork("lots", blockId, depth, childPath)`; targets (m², pre-scale): corporate 2600, casino 2200, luxury 1700, suburb 650, slum 180 (slum cut angle jittered ±9° via unit-vector blend). Megablock = single lot. Frontage from provenance: a lot edge lying on a street/arterial-provenance boundary segment (≥ 6 m) → `frontage: "street"`. Landlocked lots merge into their largest fronting neighbour — **except in slum blocks**, where they are kept and shared edges emit `alley` edges (P2 graft).
- **Output:** `Lot[]` (pooled polygons, frontage, district).

### Stage 10 — `buildings`
- **Algorithm:** per lot, substream `fork("bld", blockId, lotIndex)`; decision table + massing per §5. Universal gates: 5-point under-footprint relief sample — relief > 6 m vetoes all but `slumShack` (which terraces: `baseZM` quantized to 2.8 m steps up-slope); vetoed or sub-minimum footprints become `plaza` content (never a hole). Tower slenderness clamp `h ≤ 9·min(w,d)`. `baseZM` = max terrain sample under footprint (non-shack), min + terrace steps (shack).
- **Output:** `Building[]` + `ParcelContent` markers.

### Stage 11 — `assemble`
- **Algorithm:** pack one `InstanceBuffer` per archetype in the worker (16 floats/instance, column-major mat4 composed trig-free from `facing` unit vectors), instances sorted by `blockId` with per-block index ranges recorded (P3 graft, future LOD). Road polylines flattened into one coordinate pool. Canonical binary serialization (§5) → per-stage FNV-1a 64 `stageHashes` + whole-model `contentHash`.
- **Output:** `CityModel`.

## 4. Data model

```ts
// src/entities/city/index.ts — the shared vocabulary. Imports nothing above (ADR-0016).
import { z } from "zod";

export const generationParamsSchema = z.object({
  seed: z.string().min(1),
  sizeM: z.number().int().min(1024).max(4096).default(2048),
  cells: z.number().int().min(128).max(1024).default(512),
});
export type GenerationParams = z.infer<typeof generationParamsSchema>;

export interface Vec2 { readonly x: number; readonly y: number; }

/** Dense row-major scalar field over the grid. */
export interface Field2D {
  readonly cells: number;      // per axis
  readonly cellSizeM: number;
  readonly data: Float32Array;
}

export const WATER_CLASSES = ["none", "ocean", "river"] as const;
export type WaterClass = (typeof WATER_CLASSES)[number];

export interface TerrainLayer {
  readonly elevation: Field2D;
  readonly waterMask: Uint8Array;   // WaterClass ordinal
  readonly waterDepth: Field2D;
  readonly seaLevelM: number;
}

export interface FieldStack {
  readonly slope: Field2D;
  readonly distWater: Field2D;
  readonly distLand: Field2D;
  readonly localEminence: Field2D;
  readonly floodRisk: Field2D;
  readonly centrality: Field2D;
  readonly shadow: Field2D;
  readonly prestige: Field2D;
  readonly decay: Field2D;
}

export const ANCHOR_KINDS = ["cbd", "mega", "casino"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];
export interface Anchor { readonly kind: AnchorKind; readonly pos: Vec2; }

export const ROAD_CLASSES = ["highway", "avenue", "street", "alley"] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];
export const CROSSINGS = ["none", "bridge"] as const;   // enum, not boolean: tunnels next
export type Crossing = (typeof CROSSINGS)[number];

/** All polyline geometry lives in one pool: coords[2k], coords[2k+1] = x, y. */
export interface PolylinePool {
  readonly coords: Float32Array;
  readonly starts: Uint32Array;   // starts[i]..starts[i+1] = vertex range of polyline i (length = count+1)
}
export interface RoadNode { readonly id: number; readonly pos: Vec2; }
export interface RoadEdge {
  readonly id: number;
  readonly a: number; readonly b: number;      // node ids (arterials); -1 for cut/alley edges
  readonly cls: RoadClass;
  readonly crossing: Crossing;
  readonly polylineIndex: number;              // into RoadGraph.polylines
  readonly strip: boolean;
}
export interface RoadGraph {
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
  readonly polylines: PolylinePool;
}

export const DISTRICT_KINDS = [
  "corporate", "megablock", "casino", "luxury", "suburb", "slum",
] as const;
export type DistrictKind = (typeof DISTRICT_KINDS)[number];

/** Polygon rings pooled the same way: ring i = coord range starts[i]..starts[i+1], CCW. */
export interface PolygonPool {
  readonly coords: Float32Array;
  readonly starts: Uint32Array;
}
export const BOUNDARY_PROVENANCES = ["cut", "arterial", "border", "water"] as const;
export type BoundaryProvenance = (typeof BOUNDARY_PROVENANCES)[number];
export interface BoundaryRef { readonly kind: BoundaryProvenance; readonly refId: number; }

export interface Block {
  readonly id: number;                 // deterministic subdivision-DFS order
  readonly ringIndex: number;          // into CityModel.blockPolygons
  readonly boundary: readonly BoundaryRef[];
  readonly neighbourIds: readonly number[];   // provenance-shared, symmetric
  readonly district: DistrictKind;
  readonly water: boolean;
  readonly scoreMargin: number;        // argmax margin, kept for tuning
}

export const FRONTAGES = ["street", "landlocked", "landlocked-merged"] as const;
export type Frontage = (typeof FRONTAGES)[number];
export interface Lot {
  readonly id: number;
  readonly blockId: number;
  readonly ringIndex: number;          // into CityModel.lotPolygons
  readonly frontage: Frontage;
}

export const BUILDING_ARCHETYPES = [
  "megabuilding", "corpoTower", "casino",
  "luxuryResidence", "detachedHouse", "slumShack",
] as const;
export type BuildingArchetype = (typeof BUILDING_ARCHETYPES)[number];

export interface Obb {
  readonly cx: number; readonly cy: number;
  readonly facing: Vec2;               // unit vector — never an angle (no trig anywhere)
  readonly w: number; readonly d: number;
}
export interface BuildingTier { readonly heightFrac: number; readonly insetFrac: number; }
export interface Building {
  readonly id: number;
  readonly archetype: BuildingArchetype;
  readonly obb: Obb;
  readonly heightM: number;
  readonly baseZM: number;
  readonly tiers: readonly BuildingTier[];  // length 1 except megabuilding (2–4)
  readonly lotId: number;
  readonly blockId: number;
}

export interface InstanceBuffer {
  readonly count: number;
  readonly matrices: Float32Array;                 // 16 floats/instance, blockId-sorted
  readonly blockRanges: ReadonlyMap<number, readonly [number, number]>;
}

export const STAGE_NAMES = [
  "terrain", "hydrology", "derived", "anchors", "social",
  "arterials", "blocks", "zoning", "lots", "buildings",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface CityModel {
  readonly params: GenerationParams;
  readonly terrain: TerrainLayer;
  readonly fields: FieldStack;                      // FieldInspector reads these
  readonly anchors: readonly Anchor[];
  readonly roads: RoadGraph;
  readonly blocks: readonly Block[];
  readonly blockPolygons: PolygonPool;
  readonly lots: readonly Lot[];
  readonly lotPolygons: PolygonPool;
  readonly buildings: readonly Building[];
  readonly instances: Readonly<Record<BuildingArchetype, InstanceBuffer>>;
  readonly stageHashes: Readonly<Record<StageName, string>>;
  readonly contentHash: string;                     // FNV-1a 64 hex of canonical bytes
}
```

```ts
// src/lib/citygen/rng/types.ts — stream interface (boundary interface, one impl now)
export interface RngStream {
  next(): number;                                   // [0,1), 24-bit resolution: (x >>> 8) / 2**24
  nextInt(maxExclusive: number): number;            // Lemire rejection-free reduction
  fork(...labels: readonly (string | number)[]): RngStream;
}
```

Transfer: `CityModel`'s typed arrays are listed as transferables when posted from the worker; the remaining object graph is ~10k small objects (blocks/lots/buildings metadata), which is acceptable, and all heavy geometry is pooled.

## 5. Determinism / PRNG scheme

- **Master seed:** `m0 = fnv1a32(utf8(seed))`, `m1 = fnv1a32(utf8(seed + "\u0001"))` (FNV-1a 32: offset 2166136261, prime 16777619, over UTF-8 bytes).
- **Stage streams:** xoshiro128++ state = four successive outputs of splitmix32 seeded with `m0 ^ fnv1a32(stageLabel)`, the first output additionally XOR `m1`. Stage labels = `STAGE_NAMES`. Adding a draw in one stage cannot reshuffle another.
- **Per-entity substreams:** `fork(...labels)` folds labels into a fresh splitmix32 seed: `labels.reduce((h, l) => splitmix32(h ^ (typeof l === "number" ? l >>> 0 : fnv1a32(l))), stateWord0)`, then fills a fresh xoshiro state. Entity output never depends on sibling draw counts. Fork keys are always *stable ids* (subdivision DFS path, blockId, lotIndex) — never accept-order counters (fixes P2's cascade).
- **Random unit vectors without trig:** `t = 2u − 1`; `dir = ((1−t²)/(1+t²), 2t/(1+t²))`, negated when a second draw bit is set. Exact ops only. Rotation by 90° = `(−y, x)`; orientation blending in 2θ tensor space as in §3 stage 7.
- **Permitted ops in `src/lib/citygen/`:** `+ − × ÷`, `Math.sqrt`, `floor`, `ceil`, `trunc`, `abs`, `min`, `max`, `sign`, `Math.imul`, `>>> << & | ^`. **Banned:** `Math.sin/cos/tan/exp/log/pow/atan2/hypot/cbrt/random`, `**`, `Date.now`, `performance.now`, `toFixed` in serialization. Enforced by a source-scan unit test (a guard, not proof — the golden hashes are proof).
- **All heaps:** binary min-heap over lexicographic keys ending in a unique integer (`cellIndex` / entity id) — total order, no ambient tie-breaks.
- **Storage:** grids `Float32Array` (deterministic rounding); graph/polygon geometry f64 until pooled into `Float32Array` at assembly.
- **Serialization & hashes:** `serialize.ts` writes a canonical little-endian byte stream per stage (fixed field order, length-prefixed arrays); FNV-1a 64 (two 32-bit lanes, no BigInt) per stage → `stageHashes`, over the concatenation → `contentHash`. Golden hashes for fixture seeds `"akiba-01" | "akiba-02" | "akiba-03"` are committed; a failure names the first divergent stage.
- **Standing determinism tests:** (a) same seed twice → deep-equal; (b) stream independence — inject an extra draw into stage k's stream in a test harness and assert every other stage's hash unchanged; (c) subtree reconstruction — regenerate one block's lots+buildings from `(block, fork keys)` alone and assert byte-equality with the pipeline's slice; (d) known-answer vectors for splitmix32/xoshiro128++/fnv1a32, and `fork` divergence when only the last label differs.

## 6. District archetypes

| District | Terrain signature that wins the argmax | Building | Footprint | Height | Density |
|---|---|---|---|---|---|
| **corporate** | geodesic core: high `centrality` (quadratic falloff over the cost surface — across-the-river is genuinely far), low `decay` | `corpoTower` | lot OBB inset 4 m; slenderness clamp `h ≤ 9·min(w,d)` | `h = (90 + 240·c²)·(0.72 + 0.28u)`, clamp [60, 330]; **spike branch:** `u > 0.96` → ×`(1.5 + 2.5·(u−0.96)/0.04)` before clamp (heavy-tail skyline without `pow`) | lots ~2600 m², near-full coverage |
| **megablock** | forced: blocks holding a mega anchor (flat, dry, farthest-point spread) **plus** ≥ 12,000 m² corporate blocks on a slum border (arcology shadows its slum) | `megabuilding` | whole block inset 6 m | base 140 + 120u m; `2 + ⌊3u₂⌋` tiers from fixed `{heightFrac, insetFrac}` profile tables (P3 graft) | 1 building/block |
| **casino** | adjacency to the always-constructed shore strip avenue + waterfront band (60–400 m) + centrality | `casino` | 85 % coverage podium; frontage within 40 m of strip → `facing` snapped perpendicular to the strip polyline (luminous wall) | 18 + 30u m | lots ~2200 m² |
| **luxury** | high `localEminence` (looks *down* on neighbours — ridge crests, not the whole ridge), low decay, away from core | `luxuryResidence` | coverage 0.25, centered; setback grows with `prestige` | 8 + 10u m | lots ~1700 m², sparse |
| **suburb** | flat, low-centrality, low-decay periphery — coverage guaranteed because subdivision reaches everywhere | `detachedHouse` | 0.35-coverage rectangle on the frontage-side third | 5 + 4u m | lots ~650 m² |
| **slum** | the residue the fields price at zero: high `shadow` (under megatowers), `floodRisk`, steep leftovers, geodesic dead-ends | `slumShack` | 0.9 coverage; landlocked lots kept, alleys emitted; second offset box when `u₂ < 0.3` | floor-quantized: `2.8 × (1 + ⌊3u⌋)` m; terraces up to 6 m+ relief where all else is vetoed | lots ~180 m², cut angles jittered — tangle |

Terrain acts twice (P1's thesis, kept): once through zoning (which family is allowed here) and once through massing (centrality² heights, prestige setbacks, decay shack jitter, terraced bases) — one code path, visibly different slums on a slope vs a floodplain. Universal gates: relief veto → `plaza` (P3), never voids.

## 7. Renderer integration

One `THREE.Scene`, built once per `CityModel` in `src/components/features/city-map/viewer/`:

- **Terrain:** one `BufferGeometry` plane, 256×256 render resolution (downsampled from the field), position attribute displaced by `elevation`, vertex colors from `waterMask`/district tint; indices built with `Uint32Array.from` generators.
- **Roads:** one `LineSegments` (slice scope) per road class from the `PolylinePool`, elevated 0.5 m above terrain samples; bridges drawn in a distinct color.
- **Buildings:** exactly one `InstancedMesh` per `BuildingArchetype` (locked decision): unit `BoxGeometry`, `instanceMatrix` uploaded directly from `InstanceBuffer.matrices` (composed in the worker, trig-free from `facing` unit vectors; megabuilding tiers = additional instances in the same buffer, one per tier). Per-archetype emissive-ish flat materials carry the cyberpunk palette; material/mood work is out of scope (§11).
- **Cameras, one scene, two views:** `viewMode: "2d" | "3d"` (enum, extensible to `"iso"` etc.). 2D = `OrthographicCamera` top-down, frustum fitted to `sizeM`, pan/zoom only. 3D = `PerspectiveCamera` with orbit controls. Both render the *same* scene object graph; switching swaps only the active camera passed to `renderer.render`.
- **Renderer:** `import * as THREE from "three/webgpu"` with `WebGPURenderer` and its automatic WebGL2 fallback (locked). WebGPU init is async; the canvas component treats renderer readiness as an external-system snapshot (`useSyncExternalStore`, per react.md), and the exact init/`setAnimationLoop` API shape is verified against current three.js docs at implementation time (Knowledge Currency — not restated here from memory).
- **FieldInspector:** a plain 2D canvas heatmap of any `FieldStack` layer + `scoreMargin` overlay — the tuning tool the argmax-weights risk depends on.
- The renderer never recomputes generator math; it is a dumb consumer of `CityModel`.

## 8. Generation lifecycle state machine

Feeds `specs/city-generation.spec.md` for the `verify-spec` workflow (async guards ⇒ interaction-complex per ADR-0010).

**Context:** `{ latestRequestId: number, params: GenerationParams | null, model: CityModel | null, error: string | null }`. The worker protocol is `{ requestId, params }` → `{ requestId, ok: true, model } | { requestId, ok: false, message }`. Every worker message is guarded by `msg.requestId === latestRequestId`; stale messages are ignored in **every** state (self-loop).

**States:** `idle`, `generating`, `ready`, `regenerating`, `failed`, `disposed`.

**Events:** `SUBMIT(params)`, `WORKER_SUCCESS(requestId, model)`, `WORKER_FAILURE(requestId, message)`, `WORKER_CRASHED` (worker `error`/termination without reply), `CANCEL`, `DISPOSE`.

| From | Event | Guard | To | Actions |
|---|---|---|---|---|
| `idle` | `SUBMIT` | params valid (Zod) | `generating` | `latestRequestId++`; spawn worker if absent; post |
| `idle` | `SUBMIT` | params invalid | `idle` | surface validation error (no worker call) |
| `generating` | `WORKER_SUCCESS` | id match | `ready` | store model; clear error |
| `generating` | `WORKER_FAILURE` | id match | `failed` | store message |
| `generating` | `SUBMIT` (param change mid-gen) | valid | `generating` | **supersede:** `latestRequestId++`; `worker.terminate()`; spawn fresh; post (deterministic — no queueing, no partial state) |
| `generating` | `CANCEL` | — | `idle` | terminate + respawn lazily |
| `generating` | `WORKER_CRASHED` | — | `failed` | error = "generation worker crashed"; drop worker |
| `ready` | `SUBMIT` | valid | `regenerating` | keep displayed model; `latestRequestId++`; post |
| `regenerating` | `WORKER_SUCCESS` | id match | `ready` | swap model; dispose old GPU resources after swap |
| `regenerating` | `WORKER_FAILURE` | id match | `ready` | keep old model; error banner set |
| `regenerating` | `SUBMIT` | valid | `regenerating` | supersede (terminate + respawn + post) |
| `regenerating` | `CANCEL` | — | `ready` | terminate + respawn lazily; keep model |
| `regenerating` | `WORKER_CRASHED` | — | `ready` | keep model; error banner |
| `failed` | `SUBMIT` | valid | `generating` | as from `idle` |
| any state | `WORKER_SUCCESS`/`WORKER_FAILURE` | id mismatch | same state | ignore (stale) |
| any state | `DISPOSE` (unmount) | — | `disposed` | terminate worker; dispose scene/renderer; terminal |
| `disposed` | any | — | `disposed` | no-op |

Invariants for verify-spec: (1) at most one live worker; (2) a displayed model is never removed except by a newer matching `WORKER_SUCCESS` or `DISPOSE`; (3) no transition consumes a message whose `requestId ≠ latestRequestId`; (4) `SUBMIT` is accepted in every non-`disposed` state.

Implementation: a pure reducer (`useReducer`) owns states/guards; the worker bridge is a module-level store read via `useSyncExternalStore` (react.md external-system rules); worker spawn/terminate happen in event handlers and the dispose path, never in render.

## 9. File layout (`src/`, ADR-0016 layering)

```
src/entities/city/index.ts            # CityModel vocabulary + generationParamsSchema (Zod); imports nothing above
src/entities/city/index.test.ts       # schema branch tests (defaults, bounds)

src/lib/citygen/                      # pure generator engine — no component affinity, could ship as a library
  constants.ts                        # every tuned number, named; single home for epsilons
  rng/types.ts                        # RngStream boundary interface
  rng/hash.ts                         # fnv1a32/64 (two-lane), splitmix32          (+ hash.test.ts)
  rng/xoshiro.ts                      # xoshiro128++, fork(), Lemire nextInt       (+ xoshiro.test.ts)
  field/field2d.ts                    # create/sample/bilinear/combine helpers     (+ test)
  field/noise.ts                      # OpenSimplex2S + fBm + domain warp          (+ test)
  field/edt.ts                        # Felzenszwalb–Huttenlocher exact EDT        (+ test)
  field/blur.ts                       # separable 3-pass box blur via prefix sums  (+ test)
  geometry/vec.ts                     # Vec2 ops, unit-vector-from-u, 2θ tensor blend (+ test)
  geometry/polygon.ts                 # area, inset, line-split, point sampling    (+ test)
  geometry/hull.ts                    # monotone chain + rotating-calipers OBB     (+ test)
  geometry/simplify.ts                # Douglas–Peucker                            (+ test)
  geometry/intersect.ts               # segment intersection + spatial-hash pairs  (+ test)
  graph/heap.ts                       # binary min-heap, lexicographic total keys  (+ test)
  graph/drain.ts                      # bounded-chunk heap drain (loop-free core)  (+ test)
  graph/faces.ts                      # half-edge face traversal, pseudo-angle     (+ test)
  stages/terrain.ts … stages/buildings.ts   # one pure function per stage, colocated *.test.ts each
  stages/assemble.ts                  # instance packing, pools, per-stage hashes  (+ test)
  pipeline.ts                         # composes stages, derives streams, count invariant (+ test)
  serialize.ts                        # canonical byte stream for hashing          (+ test)
  bannedOps.test.ts                   # source scan for banned math/time tokens
  worker.ts                           # Web Worker entry: validate params → generateCity → post transferables

src/components/features/city-map/
  CityMapPage.tsx                     # feature root: view-mode + lifecycle reducer, layout
  SeedControls.tsx                    # seed/param form (Zod-validated), SUBMIT/CANCEL events
  useCityModel.ts                     # worker bridge store + useSyncExternalStore hook (state machine §7)
  FieldInspector.tsx                  # debug heatmap canvas of FieldStack layers
  viewer/SceneCanvas.tsx              # canvas element + renderer lifecycle (readiness snapshot)
  viewer/createScene.ts               # CityModel → Scene (terrain, roads, instances)
  viewer/terrainMesh.ts               # displaced plane geometry from Field2D
  viewer/roadLines.ts                 # LineSegments per RoadClass from PolylinePool
  viewer/buildingInstances.ts         # InstancedMesh per archetype from InstanceBuffer
  viewer/cameras.ts                   # ortho top-down + perspective orbit over one scene

src/routes/map.tsx                    # route module; imports the feature component only
```

No `server/fn` or `gateways` involvement: generation is client-side in the worker; the Zod schema in entities is the ready boundary if seeds are ever shared server-side. Placement of the engine in `src/lib` follows react.md's library test (pure web-of-functions, zero component affinity); if review reads ADR-0016's "generic values" narrowly, the recorded fallback is a short ADR amendment, decided at implementation review — the code moves nowhere either way until then. Component files obey `one-component-per-file` and `component-file-naming` (file stem = exported component name).

## 10. Test strategy (single-expect, `should … when …`)

Coverage: `@vitest/coverage-v8` (add as devDependency matching vitest 4; exact `coverage.thresholds` key shape verified against vitest docs at setup), scoped `include: ["src/lib/citygen/**", "src/entities/city/**"]`, branches 100 per file. Viewer components are thin render shells outside the 100 % surface (the project rule binds pure functions).

Structuring under `arch-rules/single-expect`: **one branch → one `it` → one `expect`**, asserting a tuple/object that captures the branch's full observable consequence in a single `toEqual`/`toBeCloseTo`; boundary pairs use `it.each` (exempt from the rule) with one parametrized expect. Shared fixture construction lives in plain helpers, not `beforeEach` state. Names follow `should <behavior> when <condition>` (lint-enforced). Examples per stage:

- **rng:** `it.each` over known-answer vectors → `expect(stream.next()).toBe(vector)`; `should produce a different first draw when only the last fork label differs` → one expect on a `[a, b]` pair via `expect(a === b).toBe(false)` … expressed as `expect(pair).toSatisfy(([a, b]) => a !== b)` (single expect).
- **hydrology:** hand-built 8×8 single-pit grid → `should raise the pit cell to spill elevation when priority-flood fills a depression` (one `toBeCloseTo`); monotone grid → zero-fill branch (`expect(filled.data).toEqual(input.data)`); `it.each` on accumulation thresholds either side of 1.5 % for the river branch.
- **derived/edt/blur:** 1D known-answer rows; EDT exactness on a 2-point fixture (one `toEqual` of the whole row).
- **anchors:** fixed tie on two cells → `should pick the lower cell index when scores tie`; farthest-point second pick asserted as an id.
- **social:** two cells equidistant Euclidean, one across water → `should score the across-water cell less central when the channel blocks the geodesic` (one comparison expect on a boolean).
- **arterials:** 16×16 channel fixtures — `it.each([[200, "bridge"], [300, "detour"]])` asserting crossing classification; DP epsilon both sides; planarize split-count on two crossing polylines.
- **blocks:** orientation blend degenerate fixture → fallback-branch direction (`toEqual` on unit vector); `|dot| > 0.8` clamp branch; termination on both stop conditions separately; water-block discard branch; provenance adjacency symmetry (single `toSatisfy` over the whole adjacency list).
- **zoning:** 3-block fixtures — mode-filter adopt (margin 0.05) vs hold (margin 0.2) via `it.each`; synchronous-update semantics: a ring fixture where in-place iteration would cascade asserts the double-buffered label vector (`toEqual`); megalot rim branch on/off by area 11,999/12,001 via `it.each`.
- **lots:** sliver no-split branch; landlocked merge vs slum-keep-and-alley branches; frontage threshold 5.9/6.1 m via `it.each`; count-control scale clamp at both bounds.
- **buildings:** every decision-table row via `it.each(rows)`; relief veto 5.9/6.1 m; shack terrace step count; spike branch on `u` either side of 0.96; slenderness clamp engaged/not.
- **pipeline:** golden `contentHash` per fixture seed (one expect each); per-stage hash goldens; same-seed deep-equal; determinism tests of §5 (stream independence, subtree reconstruction); invariants as single aggregate expects (`buildings.length` within band, every district present in fixture seeds, no NaN across buffers via one `toSatisfy`).
- **bannedOps:** one expect: zero matches of the banned-token scan across `src/lib/citygen/` — documented in-test as a guard, with the golden hashes as the actual proof.

## 11. Deliberately out of scope for the vertical slice

Materials/lighting mood (emissive signage, fog, neon — generator emits `strip`/archetype/tier data for it); LOD/streaming (block index ranges are recorded, unused); server-side generation, seed persistence/sharing (no `server/fn`, no gateways); tunnels (`Crossing` has the slot); industrial district and any archetype beyond the locked six; traffic, props, street furniture, labels; progressive preview during generation; auto-tuning of affinity weights (FieldInspector + kept margins are the manual tool); cross-engine golden-hash CI matrix (single-engine CI goldens in the slice; the op restriction is designed for cross-engine and tested opportunistically).

## 12. Loop-free implementation

`style-rules/no-loops` bans all loop statements in `src/`. The generator is designed so no algorithm needs unbounded per-item recursion. Two reusable primitives carry everything:

- **`rangeMap(n, f)` / grid fill:** `Float32Array.from({ length: n }, (_, i) => f(i))`, or preallocate and `arr.forEach((_, i) => { arr[i] = f(i); })` — mutation of a locally created buffer; `no-param-reassign` forbids rebinding parameters, not writing into an owned accumulator's elements.
- **`boundedDrain(state, maxOps)` (graph/drain.ts):** recursive `drain(state)` that processes `min(4096, remaining)` heap pops via `Array.from({ length: chunk }).reduce((s) => step(s), state)` and recurses while the heap is non-empty; `step` is a no-op on an empty heap. Recursion depth = ⌈totalOps/4096⌉. Every priority-queue algorithm has a static op bound (each cell pushed ≤ degree times), so depth is known in advance.

| Algorithm | Loop-free formulation | Stack-depth story (512² = 262,144 cells) |
|---|---|---|
| Noise/fBm grid fill | `Float32Array.from({length,n})` mapper; octaves = `reduce` over a fixed 6-element array | none (no recursion) |
| Percentile sea level | copy → built-in `sort` → index | none |
| Priority-flood fill | seed border cells via `filter`+`forEach` push; `boundedDrain`, bound = 2n ops | depth ≤ ⌈2n/4096⌉ = **128** |
| D8 flow accumulation | index array `Array.from({length:n},(_,i)=>i).sort((a,b)=> e[b]−e[a] || a−b)`; single `forEach` pushing accumulation downhill | none |
| FH exact EDT | per-row then per-column: `map` over 512 lines; each 1D transform = two `reduce` scans over 512 elements with a local envelope accumulator | none |
| Box blur | separable prefix sums: per-line `reduce`, 3 passes | none |
| Dijkstra (centrality, arterial paths ×~10) | init + `boundedDrain`; bound = 4n pushes+pops per run | depth ≤ ⌈8n/4096⌉ = **512** recursion frames — safe (JS stacks are ~10⁴ frames); chunk size is a constant if headroom is ever wanted |
| Path backtrack (predecessor walk) | `reduce` over `Array.from({length: 4096})` carrying `{cur, done, points}`; no-op after source reached; `filter` the sentinel tail | none |
| Douglas–Peucker | natural recursion on split ranges | worst-case depth = points on one polyline (≤ ~1,500) — within stack; typical ≪ 100 |
| Segment planarization (arterials only) | spatial-hash buckets via `flatMap`; candidate pairs `filter`ed by id order; intersections `map`ped; splits applied by `reduce` over intersections per polyline | none |
| Half-edge face traversal | outgoing edges pre-`sort`ed by pseudo-angle; face walk = recursion over `next(halfEdge)`; all faces = `reduce` over half-edges skipping visited | depth = longest face perimeter in *arterial* half-edges (~50) |
| Convex hull + rotating calipers | monotone chain = `sort` + two `reduce`s; calipers = `reduce` over hull edges with inner `reduce` for extents (hull ≤ ~64 points) | none |
| Recursive OBB subdivision (regions→blocks, blocks→lots) | natural recursion: `subdivide(polygon, path)` returns `flatMap` of children; cut = polygon line-split via `reduce` over edges | depth = log₂(maxRegionArea/minLotArea) ≤ **~14**; sibling fan-out is data, not stack |
| Zoning mode filter | `[0, 1].reduce` over generations; each generation = `blocks.map` reading the previous label array (double-buffered — synchronous semantics by construction) | none |
| Megalot rim pass | `filter` to compute the promotion set from frozen labels, then `map` to apply | none |
| Building synthesis | `lots.map` with per-lot forked substream | none |
| Instance packing / serialization | preallocated `Float32Array` + `forEach` with computed offsets; hash = `reduce` over a byte array | none |
| Heap sift-up/down | recursion | depth ≤ log₂(4n) ≈ **20** |
| Terrain render mesh indices | `Uint32Array.from({length: quads*6}, mapper)` | none |

**What was dropped because no honest loop-free form exists:** RK4 streamline tracing (unbounded, stateful, separation-checked iteration — its loop-free rewrite would be a 10⁵-step tail recursion with no engine TCO guarantee and no per-step testability) and Parish-Müller growth (same shape). Their replacements above are not fallback compromises bolted on late; they are the design. `complexity` (error-level) is met the same way: decision tables are data (`Record<DistrictKind, …>`), each stage decomposes into the single-purpose helpers listed in §9, and no function owns more than one algorithmic concern.