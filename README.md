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

Parse, store construction and the state summaries all run off the
main thread. Only transferred `ArrayBuffer`s come back — the handoff is O(1)
regardless of dataset size, which is what `IdColumn` exists for.

#### A transferred buffer is gone from this side

Transfer is what makes the handoff O(1), and it is also the sharpest edge in the
codebase: `postMessage(msg, { transfer })` **detaches** those buffers here. A
detached typed array is not an error, it is length 0 — so the failure is silent
and arrives later, somewhere else.

It bit exactly once, and instructively. `buildDurationMatrix` set
`patients = typology.patients` rather than copying, and `ClusterClient.run` posts
every matrix with `matrixTransferables`, which includes `patients.buffer`. So
starting a clustering run emptied the membership list of every typology in the
store — and a run starts immediately after every load.

Nothing noticed for a while, because `size` is a plain number that survives and
every count in the UI reads *that*: the silhouette cards, the cluster table and
the path explorer all showed correct totals. Only *using* membership failed.
`intersectTypologies` built its allow-list from zero indices, so the first
typology selection after a load selected nobody and drew nothing — while the
panel that offered it said 27 individuals. Reordering a state rebuilt the
typologies and fixed it for the rest of the session, which made it look like a
rendering bug, and it was reported as one.

The rule the code now follows: **a payload that will be transferred owns its
buffers.** `matrices.ts` slices, and `wire.test.ts` clones with the real transfer
list and asserts the typologies survive it — the assertion that turns a silent
detach back into a failing test.

Typologies are deliberately **not** among the things the worker sends, though
they are derived there cheaply enough. They are pure derivation over the store —
their whole content is patient indices into it — and a reshape already has to
redo them (`syncStates`). Shipping them too meant the load path obtained them one
way and every later path another, so the app ran on a structure only one of those
paths ever produced. Nothing downstream can tell the two apart until membership
is *used*, at which point a bad one selects nobody. One producer, exercised on
every reorder, is worth 12 ms once on a 250k load.

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
  sits without anything being aggregated away. See *Zero-length segments* below
  for the one case this layer has to special-case.
- **Lumps.** Every transition between one ordered pair of states collapses into
  the extent it covers, drawn as a four-cornered quad with its top edge flat on
  the source row and its bottom edge flat on the target row.
- **Medoid spines** (with clustering on): one line per cluster, each a real
  patient. See below.

The three data layers are **toggles, not a choice**, and each is built only while
it is on. See *Stacking the layers*.
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

### Stacking the layers

Lines, lumps and medoid spines started as alternatives, matching the original,
and that was the wrong model. The interesting question about a summary is how it
sits against what it summarises — where the spines run through the density
field, which lumps the hairlines actually fill — and toggling back and forth to
answer it asks the eye to hold one picture while looking at another.

Stacking needs the bottom layer to get out of the way, and **lowering its opacity
is not how**. Alpha accumulates: two faint lines crossing are darker than one,
which is exactly what makes the density readable and exactly what ruins it as a
backdrop, because the dense regions stay dark enough to compete with whatever is
drawn on top. `ViewState.bulkFade` instead mixes each line's colour toward the
chart's own background and draws it **opaque**, so every line lands on the same
value however many others it crosses and the layer reads as one faded sheet.

```glsl
vColor = vec4(mix(aColor.rgb, uBackground, uFade), aColor.a * uOpacity);
```

The caller passes `uOpacity = 1` whenever `uFade > 0`, which keeps the shader
branch-free. Canvas2D does the same mix once per colour — there are a handful of
states and up to a million segments, so it belongs at the stroke, not in the
loop. The background is read off the chart element rather than hard-coded: the
two have to agree exactly or a faded layer reads as a wash of the wrong tint.

The slider keeps one direction — low is faint either way — and only changes what
it means, which the legend says (`Line opacity` / `Line backdrop`).

The spines land in the renderer's **overlay buffer** when the hairlines are
there to sit on top of, so toggling them never touches the megabytes underneath.

#### The spines own the interaction

With an overlay up, the bulk underneath is **not hit-tested at all**. Picking one
line out of a quarter-million was never a useful answer — what is under the
cursor is whichever of several thousand overlapping trajectories happened to be
drawn last, and all a click did was pin it. Picking a spine names a *cluster*,
which is a group you can isolate, read and export.

So clicking a spine isolates its cluster, and isolating scopes the hairlines to
`clusterMembers` — the people that medoid stands for. That is what makes a
medoid legible as a representative rather than as an arbitrary trajectory drawn
thicker: the summary and its evidence end up on screen together, with the
density underneath being that cluster's own.

Hit-testing the spines is a plain CPU `SegmentIndex`, built eagerly. The layer is
capped at `TOP_CLUSTER_LIMIT` spines of a few segments each, so the index is a
few thousand entries where the bulk's is a million — which is why *that* one is
idle-scheduled and abandoned above a ceiling and this one is simply built. It
also works identically on both backends: the GPU pick reads back only what is in
the bulk buffer, so it could never see the overlay.

The link to the panel now runs both ways. It used to go one: pick a cluster in
the table and the chart isolated it. Clicking a spine goes the other, and the
table expands that typology and scrolls its row a third of the way down — landing
on a selection you cannot find in a windowed list of thousands is worse than no
link, and the ids export lives in the expanded row. The reveal is keyed on the
last selected cluster alone, so a re-sort or a streamed result cannot yank the
list back to it while you are reading somewhere else.

#### Pointing at a spine, and fixing it

Clicking was doing two jobs at once: it was the only way to ask what a medoid
stood for, *and* the way to commit to that answer. So finding the right cluster
meant a click to isolate, a look, a click to undo, and another — each one a
change to what was on screen, in a view you were trying to read.

Hovering now asks and clicking still commits. Resting on a spine lifts its
members out at `HIGHLIGHT_OPACITY` while everything else drops to `DIM_FADE`
— a floor, not a factor, so the answer is legible wherever the opacity slider
happens to sit. Clicking does what it always did: isolates the cluster, scopes
the hairlines to its members and reveals its row in the table.

The members are a **third renderer slot** rather than a rebuilt bulk. The bulk is
megabytes that change when the data does; this is a few hundred lines that change
when the pointer does, and re-uploading the former to raise the latter would make
a hover cost what the whole view costs. They are drawn *over* the dimmed field
rather than carved out of it, so they show at the sum of the two — still part of
the field, just the part being named.

**The change of emphasis is animated; the spine's own response is not.** Both
halves of the dim are uniforms, so a frame of the fade is one `drawArrays` with
two floats changed — nothing rebuilt, nothing re-uploaded, not even the row
texture that a view transition replaces. The two therefore take their budgets
separately, and this one is *measured* rather than guessed: `useFrameClock`
already keeps a moving average of what this scene's draws cost, so the ceiling
calibrates itself to the dataset and the machine instead of to a segment count
someone picked once. Above `FADE_FRAME_BUDGET_MS` the highlight lands instead,
because a stuttering fade reads worse than an instant one.

One number drives both halves, so the field receding and the members arriving
are one gesture rather than two that happen to start together — and the members
stay uploaded until it reaches zero, or the fade-out would have nothing to fade.

Two guards keep the reading honest. `clusterOfPatient` answers for any patient,
not only for medoids, so a pick only means a cluster when it actually landed on
the spine layer — otherwise a hairline under the cursor would isolate whatever
cluster its owner happened to sit in, off a line nobody can aim at. And the
pointer has to **settle** for `HOVER_SETTLE_MS` before anything is rebuilt:
sweeping toward a spine crosses others on the way, and a trailing debounce of
every pointer event would push the highlight permanently into the future, so the
timer restarts only when the *target* changes. The trace under the cursor still
follows per frame; only the cluster waits.

#### Removing a state invalidates the run

Clustering is a derivation of the data, not a view of it. The matrices are built
from the spliced store, and a result is filed under a typology key and names a
medoid patient — both of which only mean something against the sequences that
produced them. Splice a state out and the typologies regroup under new keys:
every `byTypology` join misses, every medoid stands for a cohort that no longer
exists, and the typology-scoped lookups in the render path match nothing.

None of that throws, which is the whole problem. Patient indices survive a splice
by design — `reshape.ts` keeps rows in place so the selection mask and the
membership lists stay valid — so a stale run is never an out-of-range read. It is
a set of lookups that quietly return empty. The medoid layer stayed lit and drew
nothing, which reads as a broken renderer rather than as out-of-date results.

So the run carries the shape it was computed for. `clusterRemovedStates` is the
removal set as of `startClustering`, `clusterStale` compares it with the one on
screen, and `clusterRunOf` returns `null` for as long as they differ — one gate,
so a stale run is invisible in a single place instead of being something five
call sites have to remember. It is held as the removal *set* rather than as the
store's identity because that is the exact predicate: the same set splices to the
same store, so putting a state back makes an existing run valid again rather than
merely re-runnable.

**Re-running is a decision, not a consequence.** Taking states out is exploratory
and done several at a time, and re-clustering on each click would spend a run
apiece answering questions nobody asked. The prompt appears in the States panel,
where the change is made, and in the Clusters panel, where the consequence is
read; the chart's stats line carries a `clusters out of date` chip so the empty
medoid layer explains itself. A run still in flight is left alone: its results
are consistent with the matrices it was handed, so a *complete* run survives to
be valid again on restore, and `ClusterClient` supersedes it by `runId` the
moment a new one starts. The one automatic change is a floor — medoids alone,
over a run that has just gone stale, would be a blank chart, so the hairlines
come on, the same failure `toggleLayer` already refuses to let anyone click their
way into.

The Clusters panel also grew a plain **Cluster *n* typologies** button for when
there is no run at all. Clustering only ever started by itself, at load, so every
path that ended without one — nothing large enough to cluster after a splice, an
error, a cancel — was a dead end with no control anywhere to leave it.

### Small multiples

**How many typologies are selected decides how the chart reads**, and nothing
stores it:

| selected | reading |
|---|---|
| exactly one | that typology alone, on *its own steps* — a rule per visit |
| anything else | one panel each, as small multiples |

With nothing selected the grid shows the biggest few, which is what the app opens
on: a screen of shapes to choose from rather than a hairball to filter down.

Overlaying several typologies in a single frame used to be the middle case, and
it was the weakest reading in the app: they shared rows, so the paths crossed and
the slope of any one of them — the thing being compared — was lost in the others.
The grid answers that question properly, so the overlay is left to do the one
thing it is good at. There is no view toggle; the selection already says which
question is being asked, and a stored copy of that is a second source of truth
that drifts.

Two things went with it. The typology cards' **"order rows by this shape"**
button, and the **reordering in the states panel** — both existed to bend one
global order toward one sequence, which was always a compromise for every other
sequence and could not express a repeated state at all. Selecting a typology now
does that exactly, per sequence, with no compromise. The states panel keeps
membership: take a state out of the dataset, or put it back.

The global view loses the ability to be arranged, which is a real loss. A Sankey,
as in the original, is the right answer for that and is not built yet.

#### Three layers, three clocks

The grid paints into three stacked canvases rather than one, because the layers
change on completely different schedules and the expensive one changes least:

| canvas | holds | repaints when |
|---|---|---|
| rules | the ladders and their labels | the layout does |
| lines | every panel's cohort | the selection or the opacity does |
| spines | medoids, and the hovered cluster's members | the pointer does |

Folded into one context, pointing at a spine repainted a hundred thousand
hairlines in order to change a few hundred, which is what made the view stutter
once the spines arrived. Separated, a hover touches only the cheap layer — and
the field underneath recedes by a **CSS opacity on the element**, so the browser
composites pixels it already has instead of drawing them again. That also keeps
the density structure intact, where mixing every line toward the background
flattens it: what steps back is the whole sheet, not each line's relationship to
the ones it crosses.

The grid splits the reading across **two clocks**, because its halves cost
completely different things. Emphasising a spine is a repaint of the cheapest
layer with one extra trajectory in it, so it follows the pointer directly — the
mark you are aiming at should acknowledge you. Lifting its members out builds a
whole cluster's geometry and pushes the field back, so that waits for the
pointer to settle. Pointing at a spine answers immediately; asking who it stands
for is the question you have to hold still for. The members then fade on the
same curve as the hairline canvas behind them, one through `useAnimatedScalar`
and one through a CSS transition, which is affordable here for the same reason
the hover is: a frame repaints the cheap layer and never the field.

Spines are thinner here than in the single chart (1.4px against 2.5px) for the
same reason the panels are smaller — at a quarter of the width, a 2.5px line is
a quarter of the gap between two rows, and a handful of them closed the ladder
up. While one cluster is highlighted every *other* spine drops too, which the
first pass missed: the members being lifted sit under a layer of spines drawn at
full strength, so nothing appeared to change.

#### A panel is a sample, past a point

The grid opens on the biggest typologies, and on both sample datasets one cohort
is several times the size of the next — 11,589 patients of 24,243 on the 25k
file, drawn in full into a panel a few hundred pixels across. Past a point more
trajectories are not more information; they are the same pixels drawn again, at
full cost.

So each panel draws at most `COMPACT_BUDGET` patients (`DETAILED_BUDGET` in the
two-column layout), taken by a fixed stride over the cohort. A stride over a list
in patient order is an unbiased sample, and a fixed one keeps the picture
identical between repaints — a random sample would reshuffle every panel on
every layout change. `npx tsx scripts/gridCost.ts` prints what that is worth:

| dataset | unsampled | at 1,200 |
|---|---|---|
| 25k | 99,987 segments | 37,407 |
| 250k | 250,704 segments | 77,775 |

The alternative was to draw **lumps** instead of hairlines in the panels, which
would have been cheaper still and much worse: a lump is grouped by state pair,
so it says nothing about slope — and slope is the entire reason the grid exists.
Keeping the mark and reducing the count preserves the reading; changing the mark
would not. The footer shows the real cohort size with a dotted rule under it
when what is drawn is a sample of it.

#### The grid carries the whole stack

Spines are drawn per panel, over their own typology's cohort, and pointing at one
lifts its members exactly as in the single chart. A cluster is a group *within*
one typology, so a panel is precisely the frame it belongs in — without this the
spines were readable one typology at a time, which is the one thing this view
exists not to make you do. Clicking a spine opens that typology *and* isolates
the cluster in one move (`focusCluster`), because isolating one inside a grid of
eight other panels is a change you could not see.

Two consequences of sharing one canvas. The spines get their own memo rather than
a field of `panels`: the hairlines change when the selection does, while results
stream in every `CLUSTER_FLUSH_MS` for the length of a run, and folded together a
run would rebuild every panel's full member geometry a dozen times a second.
And the fade is baked into the colours before painting, because these panels take
the `rowColors` path through `paintGeometry` — the one that reproduces the GPU's
per-vertex blend exactly — which strokes those colours directly and never sees
`fade`.

The panels' hairlines are drawn whatever the **Lines** toggle says, and that is
deliberate rather than an oversight: they *are* the panel, the shape whose slope
is being compared, not a layer over something else. What the toggle governs in
the single chart, the opacity slider governs here — so the slider stays live in
the grid, and reads as a backdrop control whenever spines are over it.

The grid trades the shared frame for legibility, and in doing so buys something
the shared frame cannot give: **each panel gets one row per step of its own
sequence**. Not one per state — per *step*, so a sequence that revisits a state
gets a second rule for the second visit rather than sending the line back up.
Every trajectory is then strictly descending, every panel is a pure diagonal, and
the only thing that varies is the slope: how long that cohort took to walk its
path.

That is a projection the global row order cannot express, and it is why the same
reading is the right shape for loops later — a loop is a line that goes backwards
only because the rows were chosen before the sequence was.

`GeometryOptions.rowsFrom: "position"` does it, putting the step index in the
buffer where the state id normally goes, so the row lookup becomes the identity
and nothing downstream has to know. Two things are then held constant so the
slopes are comparable at all: the x domain, and the **pitch between rows**.
Panels are top-aligned with every row a fixed number of pixels below the last, so
a four-step panel is a shorter ladder than a seven-step one rather than a
stretched one — spreading a short sequence over the same height would make it
read as the shallowest path on screen when it may be the steepest.

Clicking a panel selects that typology alone, which by the table above is the
full-size chart on its own steps. The box plots hide there: they answer a
per-state question that positions do not have.

The cluster selection is **scoped to the focused typology** in the render path,
not only cleared in the store when the typology changes. A cluster is a group
*within* one typology, so one from anywhere else has no place on this ladder —
its members walk a different sequence, and step 3 of theirs is a different state
from step 3 of this one. The failure was silent and worth guarding twice:
`medoidPatients` filters to the focused typology *and* to the chosen clusters,
and when the two disagreed it returned nothing, so the spines just never
appeared.

Repeated rows carry their visit number — `a (1)`, `b`, `a (2)`, `c` — and only
states that actually repeat get one, since `(1)` on every label is noise on the
sequences that never come back. Two rules with the same name and colour otherwise
read as a duplicate rather than as a return, which is the one thing the view is
for.

Getting there needed the grid to stop keying its rows by state. It drew one `<g>`
per entry keyed on the state id and positioned by `rowOf[state]`, which is
exactly right for a shared order and wrong twice over for a sequence: React
collapsed the duplicate keys, and both visits resolved to the same row. Rows are
keyed and placed by *index* now; only the shared-order reading resolves through
`rowOf`, which is also what carries the fractional positions of an animated
reorder.

**Clustering follows into the focused view**, and it is the natural pairing: a
typology is exactly the unit `buildDurationMatrix` works on, so the spines there
are that typology's own clusters, drawn on the same ladder. A spine is then a
cluster's path *through this sequence*, clicking one isolates it as everywhere
else, and the hairlines below become its members. Focusing clears any cluster
selection first — a cluster from another typology would be plotted against a
ladder it never walked.

The source→target **gradient** comes back exactly, which it does not in the
Canvas2D backend generally. The GPU gets it per vertex for free; the 2D painter
batches by colour and steps at the midpoint, because a gradient per segment would
mean a `createLinearGradient` per line. But in a panel every segment on row `i`
descends to row `i + 1`, so the colour transition is a function of y alone — and
y is affine along the segment, so *one vertical gradient per step* reproduces the
per-vertex interpolation rather than approximating it. Single-digit gradients per
panel. `PaintOptions.rowColors` turns it on, and it is only correct where rows
are the steps of one shared sequence: under the global state order a segment can
run between any two rows and the transition is not a function of y.

It is **one canvas, not one per panel**. Browsers cap live contexts, and a grid
of them would mean a resize observer and a draw loop each; the panels are
rectangles of a single context. That is what `core/render/paint2d.ts` was
extracted for — `CanvasRenderer` had the only copy of the drawing loop, and the
grid needed the same thing against a sub-rectangle with its own row lookup.
Headers and hit areas are DOM over the pixels.

**Four or fewer panels go to two columns**, which buys enough height for a wider
row pitch and enough width to label every row with its ordinal — at which point a
panel is a readable chart rather than a thumbnail. Past that the point is
comparing shapes, and four across gets more of them on screen than any one
deserves individually. Capped at 24: a path selection can name hundreds, and past
that a grid says no more than the overlay it replaced.

It is a test, and deliberately narrow: no medoid overlay, no lumps, no hover
picking. Enough to answer whether comparing slopes side by side is worth losing
the shared frame.

One bug it exposed, worth recording because the shape recurs: `useRenderer` and
`useElementSize` took a *ref* and listed it as a dependency. A ref object is
referentially stable, so those effects never re-ran — fine while the element
outlives the component, silently wrong the moment it does not. Switching to the
grid unmounted the canvas and switching back mounted a new one; the renderer
stayed bound to the detached original and the chart went blank until a reload.
Both now take the element, delivered by a callback ref, so React reports the
change.

### Zero-length segments

The store closes every patient with a self-link onto their last event — its stop
convention, which the lump layer reads as "where trajectories come to rest". The
lines layer used to emit that link too, and it was a bug in two directions.

Both ends land on the same point, and **a zero-length line draws nothing**:
`gl.LINES` rasterises no fragments for it, and Canvas2D's `butt` cap gives it no
width. So it was invisible and — because GPU picking reads back what was
actually drawn — unpickable, while still taking a slot in every buffer. On the
25k dataset that was 24,243 of 154,342 segments: **16% of the vertex buffer and
16% of the draw, painting nothing.** A line's own endpoint already shows where it
stopped.

The exception is a patient with a *single* event, for whom the self-link is the
whole trajectory. Dropping it erased them from the chart entirely — 753 people in
the 25k dataset, and the second-largest typology is made of nothing else, so
selecting that one card drew an empty chart. They now get a short horizontal mark
centred on their one event, which is both visible and pickable.

The mark is sized from the dataset's extent rather than from the current view,
because geometry is built once and the x domain moves under it. The trade is that
zooming in magnifies it like any other x measure; holding it to a constant number
of pixels would mean a per-vertex flag and a branch in the vertex shader, which
is a lot of machinery for a tick.

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

### The path explorer

A skill tree over the cohort: pick a first state, see every state anyone went to
next with the count that took it, step, repeat. Stopping anywhere is a selection
— a prefix scopes the chart to every typology under it — and walking to a leaf
lands on one exact trajectory shape.

The structure is a **prefix trie over the typology sequences**, in
`core/stats/pathTree.ts`. That is the whole trick: typologies are *already* the
deduplicated sequences with their patient counts attached, so reading them left
to right gives the tree for free. On the 250k dataset, 3,154 typologies become
3,218 nodes in **0.6 ms**, rebuilt on any change to what is filtered.

This replaces two separate things in the original, and is cheaper than either:

- the **Hasse diagram**, a partial order over silhouettes built with PO.js in its
  own worker (`getDominancePairsSelf` over every pair of names, then
  `setLayers`/`setDepth`/cover relations). Note this is deliberately *not* the
  same structure: the poset related silhouettes by subsequence containment, so
  `a-c` sat beneath `a-b-c`. Here they are different branches from `a`. That is
  the right shape for stepping forward through a trajectory and the wrong one for
  asking what contains what — if the containment question comes back, it wants
  the poset, not this.
- the **React Flow "prediction" board**, where you drew a sequence to ask whether
  anyone had lived it. The explorer answers that as a side effect of its own
  navigation: a step that is not offered is a step nobody took. You cannot draw
  an impossible path, so you never have to ask.

It lives in a **dialog**, not in the side column. A step is a *row* of
alternatives and a walk is a sequence of steps, so the thing has two real axes;
folded into a 300px column it could only stack, which turned the one comparison
that matters — this branch against its siblings — into scrolling. In the dialog
it lays out as one column per step, each holding that step's options, with the
map across the bottom. The side panel keeps only what is genuinely a summary:
the breadcrumb, how much of the cohort is left, and the way in.

The dialog is a real `<dialog>` opened with `showModal`, which is what puts it in
the top layer with a true `::backdrop`, traps focus and makes Escape work. Unlike
the original's, it is driven by a prop rather than by the parent calling
`showModal()` on a ref — the element's own `close` event reports back, so the
browser's dismiss paths and ours cannot drift apart. Its children mount only
while it is open: the explorer builds a trie and paints a canvas, and neither
should happen for a dialog nobody has opened.

Three details that make it usable rather than merely correct:

- **Every level stays on screen.** What you excluded by stepping is as visible as
  what you chose, greyed but still clickable, so changing your mind at step two
  is one click rather than a reset. Clicking the state you are standing on steps
  back off it.
- **Counts read from `population`, not `selection`.** `selection` has already
  been narrowed by the explorer's own last click, so the tree would describe its
  own history: every branch but the chosen one would drop to zero and the
  alternatives the panel exists to show would vanish. Same reasoning as the
  silhouette cards' filtered line.
- **A branch a filter has emptied stays in the tree at size 0**, struck through
  rather than removed. "Nobody *here* did this" and "nobody ever did this" are
  different answers and the panel should not conflate them.

The board also carries the path as one line — `a → b → c`, in the chart's
colours, with the surviving count at each step. The columns show the *decisions*,
which is what you need while choosing and the wrong shape for reading back what
you chose: that answer is one card per column with the rejected options in
between. The same component sits in the side panel without the counts, where it
is the "where am I" and the way back.

The minimap is a canvas — nothing in it is hovered or clicked, so there is no
reason to pay for a DOM node per edge; it is the same trade the stacked-lines
diagram makes. Nodes and edges take the state's own colour, so the map reads
against the chart and the board rather than inventing a second encoding, and
three ranks carry the rest: off the route, still reachable from where you stand,
and the route itself — each brighter, thicker and larger than the last, with a
ring on the node you are standing on. Drawing is batched into one `Path2D` per
(rank, state), which turns a few thousand strokes into a dozen — the same
grouping the Canvas2D trajectory backend uses. Layout is a one-dimensional tidy
tree: depth sets x, leaves take consecutive slots, parents centre over their
children, one iterative post-order pass.

Selection flows through `selectedTypologies`, which already existed — so the
chart, the silhouette cards, the cluster table and the medoid layer all respond
to a path with no new wiring. A path selection can name hundreds of keys, which
turned two `Array.includes` scans into quadratic work; both are `Set` lookups
now, and the selected-chips row collapses to a count past 18.

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

**Back on** — `CLUSTERING_ENABLED` in `src/app/features.ts` is `true`, and the
medoid layer above is what the run now feeds. It was parked for a while: a run
over thousands of typologies streamed thousands of updates into a side panel that
could not hold them, and the reading it produced was not worth that. What made it
worth turning back on was the medoid layer — one line per cluster, against the
field it summarises — rather than the table alone. Colour-by-cluster and
cluster-grouped ribbons are still unwired in `useChartLayers`.

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

### The medoid layer

With clustering on, the chart offers **Medoids** as a third layer beside Lines
and Lumps — a third *alternative*, not an overlay, on the same footing as the
other two.

A medoid is a real patient: the member nearest its cluster's centre. So the layer
needs no new geometry, no new shader and no new picking path — it is
`buildGeometry` handed a thousand patient indices instead of a million. Hover,
the GPU colour-pick, the animated reorder and the box plots behind it all work
unchanged, and hovering a spine names the actual person the cluster is standing
on.

Which clusters get a spine follows the app's scoping rule — selecting narrows
what is drawn and never re-runs anything:

- **clusters selected** → exactly those, however small, because an explicit
  choice outranks any ranking.
- **the cohort is narrowed** (a typology, a filter) → *every* cluster whose
  medoid survives.
- **nothing narrows it** → the run's ranked `topBySize`, maintained
  incrementally and capped at 1000. The full run is tens of thousands of
  clusters, and drawing every medoid would rebuild the hairball the layer exists
  to replace.

The cap applies to the **survivors**, not to the run. Applying it to the run
first was a bug, and a quiet one: on the 25k dataset it hid 2,263 of 3,263
medoids, and 924 of 938 typologies were missing at least one — select a typology
with 12 clusters and the chart drew 11 spines while the panel beside it listed
12. The chart must not show a subset of a list the user is reading next to it,
and a narrowed cohort is small enough that there is nothing to cap.

A medoid whose patient the filters have excluded is dropped, so the summary never
claims a cohort that is no longer on screen. The layer draws at full opacity and
2px, and the opacity slider is disabled while it is up: alpha is what turns
overplotting into a density field, and a thousand lines have nothing to stack.
(The slider had been doing nothing in lump mode too; now it says so.)

Colouring stays by state rather than by cluster. Cluster colour is a ring of 48
that thousands of clusters wrap around, so it separates neighbours but does not
identify anything without a legend — whereas the state gradient means the same
thing here as everywhere else in the chart. The `ColorSource` case for it is
still there, unwired.

**Ribbons grouped by cluster** remain parked: the same shapes, with a cluster
supplying the group instead of a typology. The geometry never knew the
difference — `core/cluster/ribbons.ts` turns a cluster into a set of patients and
hands it to the shared builder in `core/render/ribbons.ts`.

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
carry two independent actions rather than one: clicking the name scopes the
chart to that typology, exactly as its silhouette card does, while the chevron
opens its clusters — so exploring the list never costs you the selection you
were reading it with, and the medoid layer follows the row you are on. A
typology of a single state shows `—` rather than `…`: it has no transitions, so
it has no duration vector and the clusterer is never handed one; the old spinner
read as a run that never finished. Rows
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
    stats/       state summaries + ordering, typology grouping, silhouettes, path trie
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

DBSCAN, the Hasse / poset diagram itself (the path explorer replaces what it was
used for — see above), the flow chart import step (React Flow), the arc chart,
stacked state density, the scrub-flashlight hover, and the progressive
"martini" reveal choreography (results still stream largest-first; only the timed
fade-and-settle is gone).

The Hasse diagram proper is the natural next one. The path explorer covers what
that view was mostly *used* for, but not what it was: a partial order by
subsequence containment is a different question from stepping forward, and it is
still a group-by over `typologies` rather than new data.
