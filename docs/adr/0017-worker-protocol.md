# ADR-0017 — Worker protocol: Comlink host, transferable typed arrays, cancel-preempting AbortSignal, grid crash-fallback

- **Status:** Proposed
- **Date:** 2026-07-06
- **Phase:** 4 (roadmap)
- **Constitution:** ARCHITECTURE.md §1.4 (off the UI thread), §5.5 (caching/progressive), §14 (isolation-shaped), §3.2 (I6); ADR-0009
- **Roadmap:** ROADMAP.md Phase 4 §4, §5, §8 (ADR-0017), §11, §12

## Context

Layout must run off the UI thread (§1.4; roadmap §2, §4: "first Web Worker
infrastructure, reused by P5 picking and P7 parsing"). The roadmap fixes the
mechanism — "Comlink worker host; transferable typed arrays for positions;
cancellation semantics (new request aborts stale one — measured, not assumed)" (§8;
subphase 4C) — and the hard constraint "main thread never blocked > 4ms (asserted
via the worker boundary)" (§12), plus "provider crash inside worker → host
recovers, falls back to grid" (§12). This record specifies the **wire encoding**
(how `LayoutInput`/`LayoutResult` become transferable typed arrays and back), the
**request/response/cancel message shape**, how **`AbortSignal` maps across the
boundary**, and **crash recovery**. It builds on ADR-0015's geometry (a `Rect` is
four finite float64) and ADR-0009's isolation-shaped contract.

## Decision

**Host.** A `LayoutWorkerHost` on the main thread owns one long-lived worker and a
Comlink proxy to an exposed worker object. Comlink carries the RPC ergonomics; the
*payloads* are hand-encoded typed arrays passed in Comlink's `transfer` list
(zero-copy move, not structured clone). All geometry computation happens **in the
worker**; the main thread only builds views and transfers buffers.

**Node index space.** Strings never cross the boundary for geometry. Each request
assigns node `i ∈ [0, N)` = its position in `cut.members`, **which `buildCut`
already emits sorted ascending** (see `abstraction/cut.ts`) — so the index is O(N)
with **no sort**, and is cached/reused across deltas. The main thread keeps the
`index ↔ NodeId` table; the worker computes purely on integer indices.

**Request encoding (`LayoutInput` → worker).**

| Field | Encoding | Transfer |
|---|---|---|
| `N` | int | — (in header object) |
| `sizes` | `Float64Array(2N)` = `[w₀,h₀,w₁,h₁,…]` | yes |
| edges (`InducedEdge[]`) | `Uint32Array(2E)` = `[srcIdx,dstIdx,…]` | yes |
| edge weights | `Float64Array(E)` | yes |
| edge kinds | `Uint32Array(E)` of interned kind-ids + a `string[]` `kindTable` (cloned once) | arr: yes |
| compound parents | `Int32Array(N)`, parent index or `−1` for a root (for elk compound nodes) | yes |
| `hints` | small plain object `{ direction, spacing, seed }` (cloned; not hot) | — |
| `prev` positions | `Float64Array(4N)` `[x,y,w,h,…]` + `Uint8Array(N)` presence mask, in the **same index space** (for hints/warm-start, ADR-0016) | yes |
| `prev` induced edges *(from 4D; absent in 4C)* | `Uint32Array(2·E_prev)` index pairs into the prev index space + `Uint32Array(E_prev)` interned kind-ids — required whenever the previous result carried `edgeRoutes`, so the worker-side ADR-0016 `Λ` equals an independent main-side recomputation; grid/tree (no routes) omit it and `Λ` falls back per ADR-0016 | yes |

**Response encoding (worker → `LayoutResult`).**

| Field | Encoding | Transfer |
|---|---|---|
| `positions` | `Float64Array(4N)` = `[x,y,w,h,…]` per index (a `Rect`, ADR-0015) | yes (ownership returned to main) |
| `edgeRoutes` | CSR polylines: `Float64Array` of concatenated points + `Uint32Array(E+1)` offsets (`[offsets[e], offsets[e+1])` bounds edge `e`); empty ⇒ straight lines | yes |
| `bounds` | 4 float64 in the header object | — |
| `stability` | number in the header (ADR-0016; recomputable, so verifiable) | — |

**Rehydration is lazy — the 4ms guarantee.** The main thread does **not** eagerly
build an N-entry `Map<NodeId, Rect>`. `LayoutResult.positions` is a thin
`ReadonlyMap`-shaped view backed by the returned `Float64Array` and the cached
`index↔NodeId` table: `get(id)` slices four lanes on demand. Steady-state
per-request main-thread work is therefore **O(1)** (swap buffer refs, post one
message); the only O(N) main-side cost is first-time index-table construction for a
brand-new cut, which reuses `cut.members`' existing sort and is amortized/cached
across deltas. This is the mechanism by which "main thread never blocks > 4ms"
(§12) holds: every O(N) geometry pass is inside the worker; the boundary itself is
constant-time transfers.

**Message shape.** Two channels between host and worker:
- **RPC port** (Comlink): the exposed worker method `compute(request) → response`.
  `request = { requestId, providerId, N, …typed arrays above }`; `response =
  { requestId, positions, edgeOffsets, edgePoints, bounds, stability }`, or the
  method throws → Comlink rejects with `{ requestId, message, stack }`.
- **Control port** (a dedicated `MessageChannel`, **not** the Comlink RPC port):
  carries `{ type: 'cancel', requestId }`. It is separate on purpose — Comlink
  serializes calls on one proxy, so a cancel sent over the RPC port would queue
  *behind* the in-flight `compute` and could never preempt it. The control port is
  read by the worker between work units. The two channels have **no cross-channel
  ordering guarantee**, so a cancel can arrive *before* its `compute` registers in
  the worker (folded back from 4C, where this raced under cancellation storms):
  the worker keeps a bounded set of pre-cancelled `requestId`s and honors such a
  cancel the moment the matching `compute` starts.

**AbortSignal mapping.** `LayoutProvider.compute(input, prev?, signal?)` takes a
main-thread `AbortSignal`. The host, per request:
1. On dispatch, records `requestId → { resolve, reject }`.
2. Subscribes to `signal`'s `abort` event; on abort it posts `{ type:'cancel',
   requestId }` over the **control port** (fire-and-forget, preempting).
3. The worker sets a per-`requestId` cancellation flag; cooperative providers check
   it at work-unit boundaries — **d3-force** every tick (abandons the sim),
   **elk-layered** is not interruptible mid-call, so cancellation for elk means
   "run to return, then **drop** the result" (no positions posted).
4. On cancel the worker posts `{ type:'cancelled', requestId }`; the host **rejects
   that request's promise with `new DOMException('Aborted','AbortError')`**, so the
   awaiting caller sees standard AbortSignal semantics on the main side.

**Runtime-neutral spawning (folded back from 4C).** The host never constructs a
worker itself; it takes an injected `WorkerFactory`, keeping `layout/src` free of
both DOM and `node:*` imports (core-law). The Node factory (`worker_threads`)
ships with the CLI in 4C; the browser `new Worker(...)` factory lands with the
Studio shell (subphase 5B) — the host is already browser-ready through the seam.

**"New request aborts stale one."** The host holds at most one in-flight request per
layout slot. When a new request arrives while one is in flight, the host **aborts
the in-flight one** (fires its `AbortSignal` → control-port cancel) *before*
dispatching the new one. This is the roadmap's "new request aborts stale one," and
4C measures that compute actually stops (a still-running stale sim would keep
posting ticks; it must go silent).

**Provider-crash recovery → grid.** Two failure modes:
- **Provider throws in-worker** (bad input, engine assertion): the `compute`
  promise rejects; the host **re-runs the request with the deterministic `grid`
  provider** and marks the result **degraded** (surfaced in host stats / a
  `degraded` flag). `grid` is chosen as the universal fallback because it is O(N),
  allocation-light, deterministic, needs no external engine, and cannot itself fail
  on any finite input.
- **Worker process dies** (uncaught error → `worker.onerror`, `messageerror`, or
  OOM): the host tears the worker down, **immediately returns a `grid` layout so
  the UI is never left blocked**, then **respawns** a fresh worker for subsequent
  requests. A crash budget (e.g. N crashes / minute) trips a circuit breaker that
  pins the slot to `grid`, preventing a crash loop.

The emergency `grid` on worker death is the **single sanctioned exception** to the
"all layout in-worker" rule (in steady state `grid`/`tree` also run *in* the worker,
4C). The > 4ms budget is a **steady-state** guarantee; the one-time crash-recovery
frame may exceed it — a bounded, degraded, visibly-flagged event is strictly better
than a white screen. See *Open questions* for where that emergency `grid` runs.

## Alternatives considered

- **Structured-clone the whole `Cut`/`InducedEdge[]`.** Rejected: Maps and strings
  clone slowly and allocate; typed arrays transfer zero-copy and keep the main
  thread O(1).
- **Cancel over the Comlink RPC port.** Rejected: serialized behind the in-flight
  `compute`, so it cannot preempt — the separate control port is mandatory.
- **`SharedArrayBuffer` + atomics for positions.** Rejected for v1: cross-origin
  isolation (COOP/COEP) headers are an app-shell burden not yet paid, and transfer
  already gives zero-copy; revisit only if double-buffering demands it.
- **Terminating and respawning the worker to cancel.** Rejected as the primary
  path: teardown/spawn is far slower than a cooperative flag and loses warm engine
  state; reserved for actual crashes.
- **Eagerly materializing `Map<NodeId, Rect>` on return.** Rejected: O(N) main-side
  per frame would blow the 4ms budget on large cuts; the array-backed lazy view
  keeps it O(1).

## Tradeoffs & consequences

- Buys: zero-copy transfers, an O(1) main-thread hot path (the 4ms guarantee), true
  preemptive cancellation, and a layout that always returns *something* (grid) even
  when an engine explodes.
- Costs: an index-space indirection (string↔int table) the host must maintain and
  invalidate on cut change; two ports instead of one; provider authors must write
  cooperative cancellation checks (only d3-force meaningfully can — documented).
- The CSR edge-route encoding means the renderer/exporter read routes from arrays,
  not object arrays — consistent with `RenderModel`'s typed-array design (P5 §7).

## Reasoning

The 4ms ceiling (§12) is only achievable if the main thread never does O(N) work on
the layout hot path; typed-array transfer + lazy array-backed results is the one
design that keeps it O(1) while still handing back a `ReadonlyMap`-typed API.
Preemptive cancellation needs an out-of-band channel because Comlink is serialized.
Grid is the fallback because it is the one provider that is total over all finite
inputs. This is the worker substrate P5 (picking) and P7 (parsing) reuse, so its
shape is deliberately provider-agnostic (indices + typed arrays + two ports).

## Future implications

`LayoutCache` (4C) keys on `(storeVersion, cutHash, providerId, hintsHash)` and
stores the returned `Float64Array`s directly — cache hit is a buffer-ref return
(< 1ms, roadmap §11). The same host generalizes to P5 picking jobs and P7
tree-sitter parses (roadmap §4). The control-port cancellation pattern is what P6
retarget-not-queue (zoom-during-flight) will lean on. `SharedArrayBuffer`
double-buffering remains an additive future option behind the same host API.

## Open questions for review

1. **Where the emergency `grid` runs on worker death.** Proposed: **main thread**,
   synchronously, accepting a one-time > 4ms frame as the price of never
   white-screening. Alternative: keep a **pre-warmed backup worker** so even the
   crash frame stays off-main (costs a second idle worker + its memory). Recommended
   main-thread-emergency for v1 simplicity; flag for the reviewer because it is the
   only place the 4ms budget is knowingly waived.
   **Ruling (4A review, 2026-07-06): accepted as recommended** — emergency `grid`
   on the main thread; the one-time > 4ms waiver is documented above and stands.
2. **elk non-interruptibility.** elkjs `layout()` is a single blocking call with no
   progress callback, so elk cancellation is "run-to-return then drop." Confirm this
   is acceptable (the *worker* stays busy until the call returns; only the *main
   thread* is unblocked). If elk compute on a 2k-node compound cut approaches the
   1.5s budget (§12), a large stale elk job could hold the worker; mitigation would
   be a second worker for elk — deferred unless 4D measurements demand it.
   **Ruling (4A review, 2026-07-06): accepted as recommended** —
   run-to-return-then-drop; the second-worker mitigation stays deferred unless 4D
   measurements show stale elk jobs actually contend.
3. **`SharedArrayBuffer` opt-in.** Left out of v1 (needs COOP/COEP). Confirm defer,
   or require the app shell to set cross-origin isolation now so double-buffering is
   available to 4C.
   **Ruling (4A review, 2026-07-06): deferred** — no COOP/COEP burden in v1.
