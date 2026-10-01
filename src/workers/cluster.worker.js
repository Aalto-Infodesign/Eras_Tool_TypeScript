/// <reference lib="webworker" />
import { singleCluster, TypologyClusterer } from "../core/cluster/meanshift.ts";
import { resultTransferables, } from "./clusterProtocol.ts";
/**
 * Progressive per-typology clustering.
 *
 * The scheduler is the one the original worker used — a time-budgeted chunk,
 * then a yield, so `pause` / `cancel` / a newer run can interleave. What is new
 * is that a chunk now converges many more seeds inside its budget, and that the
 * results leave as transferred buffers instead of arrays of objects.
 */
/** Budget per macrotask. Short enough that a cancel lands promptly. */
const CHUNK_MS = 14;
let currentRunId = null;
let paused = false;
let runState = null;
const post = (message, transfer) => {
    if (transfer === undefined)
        self.postMessage(message);
    else
        self.postMessage(message, { transfer });
};
function processNext() {
    if (runState === null || runState.runId !== currentRunId)
        return; // stale or cancelled
    if (paused)
        return; // halt at a chunk boundary; `resume` re-enters here
    const { runId, queue, params } = runState;
    if (runState.index >= queue.length) {
        post({ type: "cluster:done", runId });
        runState = null;
        return;
    }
    const matrix = queue[runState.index];
    try {
        // Too small, or a single distinct duration profile: no convergence needed.
        if (matrix.n < Math.max(2, params.minSize)) {
            emit(runId, runState.index, queue.length, singleCluster(matrix));
            advance();
            queueMicrotaskYield();
            return;
        }
        runState.clusterer ??= new TypologyClusterer(matrix, params);
        const clusterer = runState.clusterer;
        const finished = clusterer.step(CHUNK_MS);
        const preview = clusterer.takePreview();
        if (preview !== null && !finished) {
            post({ type: "cluster:preview", runId, typologyKey: matrix.typologyKey, medoidPatients: preview }, [preview.buffer]);
        }
        if (finished) {
            emit(runId, runState.index, queue.length, clusterer.finalize());
            advance();
        }
    }
    catch (error) {
        post({
            type: "cluster:error",
            runId,
            typologyKey: matrix.typologyKey,
            message: error instanceof Error ? error.message : String(error),
        });
        advance();
    }
    queueMicrotaskYield();
}
function emit(runId, index, total, result) {
    post({ type: "cluster:result", runId, index, total, result }, resultTransferables(result));
}
function advance() {
    if (runState === null)
        return;
    runState.index += 1;
    runState.clusterer = null;
}
/** A macrotask yield, so control messages are delivered between chunks. */
function queueMicrotaskYield() {
    setTimeout(processNext, 0);
}
function toMatrix(serialized) {
    return {
        typologyKey: serialized.typologyKey,
        n: serialized.n,
        d: serialized.d,
        rows: serialized.rows,
        patients: serialized.patients,
    };
}
self.onmessage = ({ data }) => {
    switch (data.type) {
        case "cluster:cancel":
            currentRunId = null;
            runState = null;
            paused = false;
            return;
        case "cluster:pause":
            paused = true;
            return;
        case "cluster:resume":
            if (!paused)
                return;
            paused = false;
            processNext();
            return;
        case "cluster:run": {
            currentRunId = data.runId;
            paused = false;
            runState = {
                runId: data.runId,
                // Largest first: the typologies that dominate the chart resolve first.
                queue: data.matrices.map(toMatrix).sort((a, b) => b.n - a.n),
                params: data.params,
                index: 0,
                clusterer: null,
            };
            processNext();
            return;
        }
    }
};
