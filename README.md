# ERAS — TypeScript / Vite refactor

An incremental rewrite of the ERAS tool, starting from file loading and the main
trajectories chart. The goal is not feature parity — it is to find out how far
the lag on large datasets can be pushed back, and to build the foundation the
rest of the port can move onto.

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # correctness
npm run bench        # the pipeline numbers below
npm run gen:data -- --patients 250000              # synthetic stress dataset
npx tsx scripts/clusterBenchmark.ts                # clustering: original vs rewrite
npx tsx scripts/clusterFullRun.ts                  # clustering: whole dataset, end to end
```

---

## Where the lag came from

Three compounding problems in the current app, none of them fixable by tuning:

**1. Array-of-objects.** Every link was `{ id, source: {state, date, age, x},
target: {...}, speed, lump, ... }`. At 25k patients that is ~375k objects; at
250k it is ~4M. The cost is not the memory, it is the pointer chase — a filter
pass touches every object's header, then two nested objects, in whatever order
the allocator left them.

**2. The pipeline ran three times.** `useTrajectoriesFromData` and
`useSilhouettesFromTrajectories` run in `ProcessedDataContext`, then again in
`DerivedDataContext` on `data`, then a third time on `filteredData`. Filtering
produced a *new array of patient objects*, so moving a slider re-derived the
entire dataset — trajectories, silhouettes, lumps — and handed React a brand new
object graph to diff.

**3. One `<motion.line>` per link.** A DOM node, a style recalculation and a
framer-motion `MotionValue` subscription for every segment. This is the hard
ceiling: it is why `enableScrub` cuts out above 2000 links, why lines mode falls
back to medoids, and why `animationDuration` is set to `0` above 1000 lines.

---

## What replaces them

### Columnar store (`src/core/model/`)

The dataset is Compressed-Sparse-Row: patient `p` owns events
`offsets[p] .. offsets[p+1]-1`, and every event-level field is one flat typed
array. A full scan is a linear walk over contiguous memory.

```
ids            IdColumn (UTF-8 blob + offsets)
offsets        Uint32Array   patientCount + 1
stateIds       Uint16Array   eventCount     ← labels interned to integers
ages / years   Float32Array  eventCount
durations      Float32Array  eventCount     ← the old `speed`, precomputed
eventPatient   Uint32Array   eventCount
```

Links are not stored. Link `i` is the pair (event `i`, event `i+1`) within a
patient, so `linkCount === eventCount`. 250k patients / 1.4M events is **21 MB**,
and every buffer is transferable.

Branded types (`PatientIndex`, `EventIndex`, `StateId`) keep the indices from
being mixed up — the one real hazard of going columnar, and exactly what the
TypeScript port buys.

### Filtering without allocation (`src/core/query/`)

A `Selection` is one byte per patient in a buffer allocated once and rewritten in
place. `applyFilters` never allocates. **0.95 ms for 250k patients** — a slider
drag runs synchronously inside the pointer handler.

### GPU bulk layer + thin interactive overlay (`src/core/render/`)

The split that makes the rest work:

- **Canvas (WebGL2)** draws *every* trajectory as `gl.LINES` in one draw call.
  Cost is independent of how many are visible. The vertex shader applies the
  scales, so zoom, pan and resize change a uniform — the buffers are never
  rebuilt. Per-vertex colour gives the source→target gradient for free.
- **SVG overlay** draws only what is hovered or selected — two or three
  polylines. That is where the interaction, the thick strokes and the labels
  live.

The original paid interaction cost for every line, including the 999 out of 1000
that are one pixel of a dense mass.

A `CanvasRenderer` implements the same interface and consumes the same geometry,
so the two backends are one enum apart and directly comparable in the UI.

### Picking without DOM nodes

Hover needs to find a segment with no elements to hit-test. Two implementations:

- **GPU (WebGL2, default).** A second pass paints each segment in a colour that
  *is* its index — recovered from `gl_VertexID / 2`, so it needs no extra buffer
  and no extra memory. A scissor box restricts rasterisation to ~81 pixels around
  the cursor, then one `readPixels` names the segment. O(1) in dataset size and
  pixel-exact: it picks the line you can actually see.
- **CPU (`SegmentIndex`, Canvas2D fallback).** A uniform grid in the same CSR
  shape as the store. It works, but it is why the GPU path exists: at 1.4M
  segments over 8 state rows the buckets are intrinsically dense — **192 ms to
  build and 4.1 ms per query**, against ~0.4 ms per query at 25k. It is skipped
  entirely above 200k segments.

### Everything heavy in a worker (`src/workers/`)

Parse, store construction, state summaries and typology grouping all run off the
main thread. Only transferred `ArrayBuffer`s come back — the handoff is O(1)
regardless of dataset size, which is what `IdColumn` exists for.

### One flat store instead of seven providers (`src/app/store.ts`)

The `RawData → ProcessedData → Viz → Filters → DerivedData → Clustering → Flow`
chain meant any change re-rendered every consumer below it. Zustand with narrow
selectors replaces it. The large mutable objects (`store`, `selection`) sit
outside React's reconciliation; `selectionVersion` is the reactive signal.

---

## Measured

`npm run bench` — Node 24, M-series, 8 states, 3–8 events per patient.

| Stage | 25k patients (140k events) | 250k patients (1.4M events) |
|---|---|---|
| ingest · JSON (whole pipeline) | 24 ms | 263 ms |
| ingest · TSV (whole pipeline) | 62 ms | 697 ms |
| build store | 5.1 ms | 59 ms |
| summarise states | 0.23 ms | 4.1 ms |
| group typologies | 1.8 ms | 12.4 ms |
| **filter (in place)** | **0.089 ms** | **0.95 ms** |
| **build geometry** | **1.4 ms** | **9.8 ms** |
| build CPU pick index *(fallback only)* | 22.6 ms | 192 ms |
| CPU pick, per query *(fallback only)* | 0.38 ms | 4.1 ms |

The two rows that matter are the bolded ones: they are the only things that run
while the user is dragging something, and both fit inside a 16 ms frame at 250k
patients — ten times the largest dataset the current tool ships with.

Ingest is a one-off and runs in a worker, so the page stays responsive through it.

**Not yet measured:** GPU draw time and GPU pick latency, and the two cluster
layers on screen. Those need a real
browser and I had no browser tooling in this session — the in-app HUD reports
both (`draw`, and the `segments` count), so the first run will tell you. The
WebGL path compiles and typechecks but **has not been executed**; treat the first
`npm run dev` as the smoke test. Everything in `core/` — including all of the
clustering — is covered by the Node tests and benchmarks.

---

## The chart

Layers derived from the store and rebuilt only when *what is shown* changes —
never on a resize, a pan or a hover, which the shader and the overlay handle on
their own.

- **Grid.** A dashed rule per state row in that state's colour, and a dashed rule
  every ten years with its label along the bottom, ported from the original's
  `Grid.jsx`. One inversion was unavoidable: there the grid was the first child
  of the SVG and everything drew over it, but here the hairlines are on a canvas
  and no SVG can sit under one, so the grid draws on top at low opacity instead.
- **Lines.** Every visible trajectory as a hairline on the GPU, coloured by
  state with a source→target gradient per segment. At a low alpha the
  overplotting *is* the reading: the density field shows where the population
  sits without anything being aggregated away.
- **Lumps.** The alternative to the lines, not an overlay on them — one of the
  two is built, never both. Every transition between one ordered pair of states
  collapses into the extent it covers, drawn as a four-cornered quad with its top
  edge flat on the source row and its bottom edge flat on the target row.
- **State box plots.** One range-and-median glyph per row: a bar spanning the
  selection's earliest→latest arrival at that state with a tick at its median,
  and whiskers running out to where the *unnarrowed* population reaches. See
  below — this is the layer the rewrite had been missing.

### Lumps

```
  source row   ┌──────────────┐        ← sourceMin … sourceMax, flat
                \              \
  target row     └──────────────┘      ← targetMin … targetMax, flat
```

Four numbers per lump: where the earliest and latest *departure* from the source
sit, and where the earliest and latest *arrival* at the target sit. Both edges
are horizontal by construction, because both ends of an edge take that row's y.

The property that makes this the cheap reading is that there are at most
`states²` lumps however many patients there are — the layer is bounded by the
vocabulary rather than by the data, so it costs the same on 250k trajectories as
on 250. Building it is one pass into a fixed `states²` table.

Links follow the store's convention exactly as `buildGeometry` reads it: link `e`
is the pair (event `e`, event `e + 1`) within a patient, and a patient's last
event is a self-link onto its own state. That surfaces as a lump whose source and
target are the same state — its two insets fall either side of one row and it
draws as a flat band lying on it, which is where trajectories come to rest.

Each edge is inset toward the other so touching lumps stay distinguishable, and
the quad is skewed slightly in the direction of travel so a→b and b→a do not
coincide — both ported from the original's `lumpPadding` / `lumpOffsetX`, with
the inset scaled to the row height rather than fixed in viewBox units. A lump
holding a single link has no extent to fill and renders as the line it is.

This replaced a median-path ribbon that walked every state of a group carrying a
per-position half-width. That outline spiked wherever the half-width or the row
changed between adjacent points; a quad has four corners and cannot.

That ribbon is kept intact in `core/render/ribbons.ts` and `ui/RibbonLayer.tsx`
with its tests, because it is the natural shape for a *clustered* grouping to
take — `core/cluster/ribbons.ts` is the adapter that feeds it clusters instead of
typologies. It is parked with the clustering rather than deleted.

### Animating the view

Two things animate: the x scale, and the row a state sits on. Both are *view*
parameters, which is the whole reason it is affordable — a frame costs one
redraw and a few dozen floats. No buffer is rebuilt and no geometry re-uploaded,
and `useChartLayers` never re-runs during a transition.

The x scale was already a uniform. The row was not: `buildGeometry` baked
`rowOf[stateId]` into every vertex, so dragging one state past another rebuilt
and re-uploaded the whole buffer and could not be tweened at all. Now
`positions.y` carries the **state id** and the row is resolved at draw time from
a one-row `R32F` texture the vertex shader samples:

```glsl
float py = uMarginY + (rowOf(aPosition.y) + 0.5) * rowHeight;
```

A reorder is therefore a `texSubImage2D` of a few hundred bytes, and an animated
reorder is interpolating those same few hundred bytes per frame. A texture rather
than a `uniform float[]` because GLSL needs the array length at compile time,
which would put an arbitrary ceiling on the state vocabulary.

The thing that actually decides the cost is not the GPU — it is keeping the four
SVG layers in step. The grid, the box plots, the lumps and the highlight overlay
all position by `xDomain` and by row; driving the canvas from a uniform while
React re-rendered SVG only at the end would leave the decade rules standing still
while the density field slid under them. So `useAnimatedView` tweens on the main
thread and pushes one value per frame that *every* layer reads. Those layers are
tens of elements, so the re-render is cheap, and lockstep is worth more than the
frames it costs.

Four cases deliberately do not animate:

- **Above 50,000 segments.** A transition redraws the bulk layer every frame, so
  its cost scales with what is on screen, and past a point the move stutters —
  which reads worse than no move at all.
- **Switching the x axis.** Age and calendar year are not two points on one
  scale to travel between: tweening `[20, 90]` into `[1990, 2060]` slides the
  whole chart sideways through coordinates that never described anything. The
  domain lands with the geometry, and it lands *during render* rather than in an
  effect — deferring it by even one commit lets the draw effect paint calendar
  years against an age scale before the correction arrives.
- **A changed vocabulary** — a new file, a removed state — because there is no
  "from" row for a state that did not exist a moment ago.
- **Hover**, which pauses for the few hundred ms of a transition: hit-testing a
  moving chart answers for where things were, not where the pointer is.

Fade-in/out on filter changes is *not* done. It needs the opposite geometry
model — the whole dataset uploaded once with a per-vertex alpha the selection
drives — which is a real refactor of `buildGeometry`, both shaders, picking and
the Canvas2D path.

### The filter panel

Five things the original got right, rebuilt:

- **A double-handle slider.** Two native `<input type="range">` elements can only
  express a range by stacking, which is why the old panel showed the bounds as
  text and left you to infer the band. Here the band *is* the control.
- **A distribution lined up with it.** Each filter draws the shape of what it
  cuts at exactly the slider's width, directly above it, so a handle lands on a
  feature of the data rather than on a number. The curve is drawn twice: faint
  for the whole distribution, bright through an SVG mask for the selected range,
  so a selection reads as part of a whole rather than as a new chart.
- **Two curves for a span filter.** Age and calendar year keep a patient only
  when their *whole span* falls inside the range, so the two handles cut two
  different populations — one curve for where trajectories start, one for where
  they end. The original called this the filter's "double" mode.
- **Inversion.** One click turns a range into its complement, and the mask, the
  track and the chip all flip with it, so the lit part is always the part that
  survives. `duration` could not be inverted before; it can now.
- **Chips that remember.** Every active range becomes a chip carrying its two
  verbs — invert and drop — with a count badge in the panel header, so a
  collapsed panel still says what is cutting the data.

Plus the stacked-lines diagram: one horizontal line per patient from the start of
their trajectory to the end, stacked and sortable by either end or by disease
duration. It answers what the main chart deliberately cannot — the chart stacks
patients by *state*, so it says nothing about how the cohort sits in time. Sorted
by start it is the recruitment curve; sorted by duration, the cohort's shape.
Canvas rather than the original's three.js: at one line per patient the draw is a
loop of `moveTo`/`lineTo` with no geometry to build, and it avoids a second WebGL
context competing with the chart's. Rows are strided to one per device pixel,
since a quarter-million lines into 120 pixels paints the same band either way.

Two things are kept off the commit path so they never lag the pointer: the
handle's position is local state during a drag and only syncs down from the store
between drags, and the distribution masks against that local position rather than
the committed range. Commits themselves are coalesced to one per frame. The
histograms are built once per dataset (and rebuilt by a reshape, like everything
else) — dragging re-masks a fixed curve, it does not re-bin.

Binning differs from the original in one way: it uses a fixed 64 bins across the
extent rather than `Math.floor` on the raw value. Integer bins read well on whole
years, which is what that data was, but collapse to a single bar as soon as a
span is narrower than one unit — which segment durations, in fractional years,
routinely are.

### The typology cards (the original's silhouettes)

A typology is a group of patients sharing one ordered state sequence. The first
pass here listed them as text keys — `a-b-c`, size, share — capped at the 40
biggest with a line saying how many were hidden. The original knew better: a
sequence is a **shape**, and the eye groups shapes far faster than it parses
dash-separated names. So each group is now a card carrying the glyph the chart
would draw for it — x is the step along the trajectory, y is the state's row in
the *current* ordering, colour is the chart's palette.

That the glyph uses the live row ordering is the point, not a detail. It makes
the card's second action legible: **order rows by this shape** restacks the
chart so the chosen silhouette reads as a staircase, and every other card
restacks with it, so you can see what the reorder did to the rest of the cohort.
The original did this with lodash `xor` for the states the silhouette did not
name, which is a *symmetric difference* — a state the trajectory visited twice
was in both lists, so it landed in neither result and its row silently vanished
from the chart. `orderFromTypology` takes the complement instead, and a test
pins it.

The other action is **export this group's ids**, and above the grid a share band
does it in bulk: drag the handles to a percentage range and one button writes
every patient id in it. The band's upper bound is the largest share rather than
the original's fixed 100 — on any real dataset the biggest silhouette is a few
percent of the cohort, so 0–100 spends most of the track on empty space and puts
the long tail, the part actually worth lassoing, inside the first pixel. Two
things are deliberately *not* eager: the button counts patients by summing group
sizes rather than materialising ids (one UTF-8 decode per patient, a quarter of a
million of them on the full dataset, on every render — the original paid exactly
that to label the button), and the band dims cards without touching the chart,
as it did before.

When filters are live, each card shows a second line: how many of its patients
survive, and their share of the filtered cohort, with the unfiltered numbers
struck through. Those counts read against `population` — the mask *before* the
narrowing filters — not `selection`. `selection` has already been intersected
with whatever typologies are selected, so reading the cards off it would zero
every card but the chosen ones the moment you clicked one, and the panel would
erase its own context. Counting them is one pass over the membership lists,
which together hold each patient exactly once.

The list is **windowed** rather than capped, which is what retires the "+3,114
smaller groups" line: a fixed card size makes the arithmetic trivial (columns
from the measured width, rows from the scroll offset), so only a screenful is
ever mounted and the whole tail is reachable. The original needed react-virtuoso
for the same job; a grid of fixed-size cards does not need a library.

Glyphs are SVG, not canvas — a card is a dozen elements and only a screenful is
mounted, which buys hit-testing, a `<title>` and CSS transitions on the geometry
for free. The reorder animation is those transitions on the SVG2 geometry
properties (`cx`, `cy`, `x1`…), so the whole grid glides from one stacking to the
next without a single animated value crossing the React boundary.

### Removing a state edits the source

The states panel (`ui/StatesPanel.tsx`, ported from the original's
`StateSelection` minus the flowchart it also fed) reorders the chart's rows and
takes states out of play. Removing one is **not a filter**: as in the original,
where `DerivedDataContext` splices the state out of every record and re-derives
`trajectories`, `silhouettes`, `analytics` and the filter ranges from the result,
`model/reshape.ts` returns a whole new store and the store re-runs the ingest's
aggregate passes over it.

The difference is not cosmetic. Two patients whose paths differed *only* by the
removed state become the same typology — `a-b-c` and `a-c` merge once `b` is
gone. No amount of masking at the render layer can do that, which is what makes
this a reshape rather than a filter. Populations drop, the axes rescale, and the
duration of a link that now spans what was removed is recomputed to the gap it
really covers, so the duration filter judges the trajectory that exists.

Two invariants keep that affordable and safe:

- **Patient indices never move.** A patient left with no events keeps its row,
  with `offsets[p] === offsets[p + 1]`. Everything addresses patients by index —
  the selection mask, hover, typology membership — so compacting the rows would
  invalidate all of it at once. Such a patient drops out of the selection, out of
  the typologies and out of the histograms, but keeps its slot.

  That makes `store.patientCount` the number of *rows*, not the number of
  people, so it is the wrong figure to report: after a removal it still counts
  patients whose entire path was made of the removed state. `cohortSize` is the
  one the UI shows, and typology `share` divides by it — otherwise the shares of
  what remains stop summing to 100%, which is exactly what they did before this
  was noticed. Removing every state a patient ever visited removes the patient,
  as it does in the original, which drops emptied records outright. The states
  panel will not let you remove the last remaining state, so the cohort can be
  narrowed but never emptied by accident.
- **The state vocabulary never moves either.** `stateNames` carries over whole,
  including removed states, so palette colours stay put and a removed id still
  means the same state when it is restored. A removed state is one with no events.

The cost is the ingest's aggregate passes, not the ingest — no parse, no store
construction from records:

| | 25k patients | 250k patients |
|---|---|---|
| splice one state | 1.2 ms | 11 ms |
| **whole re-derive** (splice + summarise + typologies) | **3.5 ms** | **27 ms** |

That is a click, not a drag, so it runs on the main thread; the HUD reports what
it cost. Moving it to a worker would mean either keeping a second copy of the
store there or transferring the live one away mid-frame, and 27 ms at ten times
the largest real dataset does not buy that complexity.

`stateOrder` is deliberately *not* re-derived from the new summaries — it is the
user's ordering, and rebuilding it on every removal would yank the rows around.
The original had exactly that bug: `setStatesOrder(difference(statesNames,
removedStates))` ran on every removal change and silently discarded any manual
reordering. Here the order holds every state and the chart reads a derived
`visibleStates`, so a state comes back where it was.

Reordering is HTML5 drag-and-drop plus a pair of arrows rather than a motion
`Reorder.Group` — no animation library, and the arrows make the list
keyboard-reachable, which a drag handle alone never is.

### The box plots, and why the quantiles are a histogram

The glyph puts the selection *inside* the population it was drawn from: narrowing
a filter grows the whiskers rather than silently rescaling the bar, so what you
excluded stays on screen. With nothing narrowed the two coincide and the whiskers
vanish, as in the original. That needs two masks, so `recompute` runs the filter
scan twice — `population` stops at the filters describing who is in the study
(age, calendar span, disease duration), `selection` goes on to apply the
per-segment duration filter and any chosen typologies.

Faithful down to a quirk: the original computes a five-number summary and then
draws its bar from `min` to `max`, never using `q1`/`q3`. It is a range-and-median
glyph, not the interquartile box the name suggests. That is reproduced, and the
quartiles are carried on `StateStats` for whoever wants the real box.

The quantiles themselves are **not** sorted. Collecting each state's arrival
times and sorting them is ~75 ms on a 250k dataset, and this runs twice per
filter change, which puts it directly in the way of a slider drag. Sampling
instead of sorting was worse than slow — a stride sample follows the data's own
order, and when that order correlates with age every quantile comes out biased by
half a stride rather than merely noisy. A histogram over the axis extent has
neither problem: one counting pass, no sort, no buffer proportional to the event
count, and error bounded by the bucket width instead of by the data's
arrangement.

```
sort 1,250,000 values across 5 states     ~75 ms
histogram 1,250,000 events                 ~2-10 ms
```

At 8192 buckets a bucket is ~1/8000th of the axis, comfortably under a pixel.
Extremes are tracked exactly rather than bucketed, because they are drawn as the
bar's span and a bucketed extreme would visibly shorten it. Quantiles interpolate
between the two ranks straddling the target, matching the convention the ribbons'
`quantile` already uses — nearest-rank would be cheaper and is perfectly
standard, but it reports the median of two visits as the earlier of them, and a
tick drawn *between* them should not mean that. A test asserts the two layers
agree.

---

## Clustering — parked

**Turned off behind `CLUSTERING_ENABLED` in `src/app/features.ts`.** The engine
below is intact and still covered by its tests and benchmarks; what is off is the
*product*. No run starts on load, the cluster panel is not mounted, and the chart
offers no cluster-derived layers. A run over thousands of typologies streamed
thousands of updates into a side panel that could not hold them, and the reading
it produced was not worth that. Flipping the flag back on restores the run and
the table; the chart's cluster layers (colour-by-cluster, medoid spines, ribbons
grouped by cluster) would need rewiring in `useChartLayers`, which now builds the
simple path only.

The rest of this section documents the engine as built.

Per-typology mean-shift over duration matrices, same algorithm as the original
worker, streamed largest-typology-first so the chart is useful long before the
run finishes.

### The matrix is free now

A typology's patients all share one state sequence, so their durations are
already contiguous in the store: building its `n × d` matrix is a copy loop into
one `Float32Array`. The original built `trajectories.map(t => t.map(tt => tt.speed))`
— an array per patient, per run — and shipped that nested structure to the worker.

### What was actually slow

`pointwiseMeanshift` walked the data twice per iteration and allocated on both
passes:

```js
let nn = data.filter(row => squED(center, row) <= sqBandwidth)          // pass 1 + array
const newCenter = nn.reduce((acc, el) => acc.map((dim, n) => el[n] + dim))  // pass 2 + array PER ROW
                    .map(e => e / nn.length)
```

The rewrite fuses the neighbourhood test and the mean into one pass that
accumulates into two preallocated `Float64Array`s — nothing is allocated inside
the loop — and adds three things the original did not have:

- **weighted unique rows.** Mean-shift over `m` unique points carrying
  multiplicity weights is *identical* to mean-shift over `n` points, so collapsing
  duplicates is free accuracy-neutral work. Durations repeat heavily.
- **a uniform grid** over the duration space, cell size = bandwidth, so
  neighbour lookup visits 3^d cells instead of scanning everything. It is built,
  then **kept only if it measurably narrows the search** — duration vectors
  cluster tightly, and when the data occupies fewer cells than the neighbourhood
  covers the grid is pure overhead. The dimensionality test alone was not enough.
- **basin pruning.** A seed that starts within `½ × bandwidth` of an
  already-converged mode reuses it instead of walking there again. Mean-shift is
  deterministic, so this skips the walk without moving the destination. Set
  `seedPruneFactor: 0` to converge every seed as the original did.

### Measured

`npx tsx scripts/clusterBenchmark.ts` — one typology, 5 states (d=4), 3 latent
speed groups, default parameters.

| patients | original | columnar + grid | + basin pruning | speedup | clusters |
|---|---|---|---|---|---|
| 500 | 14 ms | 4.9 ms | 2.8 ms | **5×** | 3 / 3 / 3 |
| 2,000 | 44 ms | 13.6 ms | 6.3 ms | **7×** | 3 / 3 / 3 |
| 8,000 | 180 ms | 54.2 ms | 24.8 ms | **7×** | 3 / 3 / 3 |
| 25,000 | not run | 182.4 ms | 91.1 ms | — | 3 / 3 |

All three agree on the number of clusters, which is the point — the speedup is
not bought with a coarser result. The original is not run at 25k because it takes
long enough that measuring it once is enough.

`npx tsx scripts/clusterFullRun.ts` — every typology of the 250k dataset:

```
typologies               3,154
clusters found           32,943
clustering (all)         1,688 ms
  first typology done      234 ms   <- chart is useful here
```

### Scoping, not re-running

Clustering runs **once, over the whole dataset**, when a file loads. Filters and
typology selection scope what is *drawn*; they never trigger a re-run. A patient
therefore keeps its cluster — and its colour — however the view is narrowed. The
original derived its matrices from the filtered data, so every filter change
reclustered and cluster identity shifted underneath the user.

### The two layers it drove (parked)

- **Individuals + medoid spines.** Every trajectory stays a hairline, coloured by
  cluster instead of by state — the density field itself becomes the cluster map,
  which costs only a different colour buffer. Each cluster's medoid is drawn on
  top as an opaque spine, in its own geometry slot so toggling spines never
  rebuilds the bulk buffers. WebGL only guarantees 1px lines, so a spine is drawn
  a few times at sub-pixel offsets — affordable precisely because the spine layer
  is a few hundred segments, not a million.
- **Ribbons grouped by cluster.** The same shapes the chart draws today, but with
  a cluster supplying the group instead of a typology. The geometry never knew
  the difference: `core/cluster/ribbons.ts` turns a cluster into a set of
  patients and hands it to the shared builder in `core/render/ribbons.ts`.

The renderer keeps its overlay geometry slot and its colour-by-cluster source, so
neither has to be rebuilt to bring the spine layer back.

### Streaming without thrash

Results arrive one typology at a time, and a real dataset has thousands. Three
things keep that from costing more than the clustering:

- store updates are **coalesced** to one every 120 ms, so 3,154 results become
  ~15 React updates;
- the builder maintains the ranked top-1000 clusters **incrementally**, so the
  render path never re-sorts 33k entries per update;
- cluster colours are a fixed ring of 48 that indices wrap around — identity
  comes from the spines, the table and selection, so colour only has to separate
  neighbours.

### The table (parked)

One row per typology, expandable to its clusters, **windowed** — only the rows
near the viewport are mounted, where the original rendered every typology. Rows
are memoised on the result object, which is referentially stable once a typology
finishes, so a streamed result re-renders one row instead of all of them.

Exports are pure functions in `core/cluster/export.ts` (testable without a DOM):
per-cluster member ids, the per-typology memberships TSV, and a whole-run summary.
The memberships file now carries the "kernel weights, not calibrated
probabilities" caveat **in the file**, where the original only had it in a code
comment that whoever opened the TSV never saw.

---

## Where TypeSafe fits — and where it does not

You asked where the TypeSafe skill could be applied. The honest answer is
**nowhere on the hot path**. This tool's inner loops are millions of numeric
operations per interaction; a model judgment per patient, per link or per frame
is precisely the kind of work the rewrite exists to delete.

Import is the opposite situation, and there is one genuinely good fit:

**Column mapping** (`src/ai/columnMapper.ts`). The original hard-codes
`FINNGENID` / `stage` / `age` / `date` — a real export with `patient_id`,
`dx_code` and `event_date` silently produces an empty chart with no explanation.
Deciding what a column *means* is semantic, and it happens exactly once per file,
on an already-async path.

The design follows the System One guidance:

- **Five independent Choice questions in one `systemOne` call** — one per role.
  They share the same state (headers + 8 sample rows) and none depends on
  another's answer, which is the condition for batching them.
- **Criteria are the actual column names**, so the model *selects* from what
  exists rather than generating a name that might not be in the file. There is an
  explicit `__none__` option for roles the file does not have, and a
  hallucinated name is rejected against the header list anyway.
- **Confidence drives the UI, not the outcome.** Above threshold the import
  proceeds; below it the mapping panel flags itself and asks the user to confirm.
  Confidence is weighted to the two required roles, so a shaky guess about an
  optional duration column does not poison the whole mapping.
- **The deterministic heuristic stays the default** (`core/parse/schema.ts`,
  aliases + value-shape checks). The assisted path is a fallback for files the
  heuristic cannot read, so import stays instant and offline for known formats
  and a model outage degrades to the old behaviour rather than to no import.

Two things to settle before enabling it, both flagged in the file:

1. **The key cannot reach the browser.** ERAS is client-only, served by nginx
   inside the sandbox, so `endpoint` has to point at a small proxy holding the
   key server-side.
2. **Column names and sample values would leave the machine.** Inside a sandbox
   holding patient data that is a governance call, not a technical one — hence
   the explicit opt-in rather than a silent default.

Other plausible-but-not-built fits, in rough order of value: grouping
near-duplicate state labels at import (`"Acute viral pharyngitis"` vs
`"acute_viral_pharyngitis"`) — once, over the state vocabulary, which is dozens
of items not millions; and naming discovered clusters/typologies for the legend.
Both are once-per-dataset, both are semantic, neither is on a frame budget.

---

## Layout

```
src/
  core/          no React, no DOM — testable and benchmarkable in Node
    parse/       delimited reader, dates, column detection, JSON, ingest
    model/       StateVocabulary, IdColumn, CSR builder, reshape, worker transfer
    query/       Selection, allocation-free filters
    stats/       state summaries + ordering, typology grouping, silhouette ops
    cluster/     duration matrices, mean-shift, grid, run, exports (parked)
    render/      scales, palette, geometry, lumps, box plots, WebGL2 / Canvas2D
    util/
  workers/       ingest + clustering (parked) workers, with run-id cancellation
  ai/            TypeSafe-assisted column mapping (opt-in, proxied)
  ui/            React components — thin
  app/           store + shell + feature flags
bench/           vitest bench over the pipeline; legacy mean-shift baseline
scripts/         dataset generator, clustering benchmarks
```

The `core/` boundary is deliberate: nothing in it imports React, which is what
lets the benchmarks run in Node and keeps the expensive code portable if the
shell ever changes again.

---

## Not ported yet

DBSCAN, the poset / Hasse work, the flow chart import step (React Flow), the arc
chart, stacked state density, the scrub-flashlight hover, and the progressive
"martini" reveal choreography (results still stream largest-first; only the timed
fade-and-settle is gone).

The silhouettes' Hasse diagram is the natural next one: the poset is a subset
relation over the same state sequences the cards already hold, so it is a
group-by over `typologies` rather than new data.
