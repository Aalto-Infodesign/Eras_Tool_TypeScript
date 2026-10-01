import { matrixTransferables } from "../core/cluster/matrices.ts";
/**
 * Streaming client for the clustering worker.
 *
 * Unlike the ingest client this is not promise-shaped: results arrive one
 * typology at a time and the UI is meant to update as they land. Messages from a
 * superseded run are dropped on arrival, and messages that arrive while paused
 * are held and flushed on resume — the worker can only halt between chunks, so
 * without the buffer a pause would still let a few results through.
 */
export class ClusterClient {
    worker = null;
    nextRunId = 1;
    currentRunId = 0;
    handlers = null;
    paused = false;
    held = [];
    ensureWorker() {
        if (this.worker === null) {
            this.worker = new Worker(new URL("./cluster.worker.ts", import.meta.url), { type: "module" });
            this.worker.addEventListener("message", this.onMessage);
            this.worker.addEventListener("error", this.onError);
        }
        return this.worker;
    }
    onMessage = (event) => {
        const message = event.data;
        if (message.runId !== this.currentRunId)
            return; // superseded run
        if (this.paused) {
            this.held.push(message);
            return;
        }
        this.apply(message);
    };
    onError = (event) => {
        this.handlers?.onError(event.message, null);
    };
    apply(message) {
        const handlers = this.handlers;
        if (handlers === null)
            return;
        switch (message.type) {
            case "cluster:preview":
                handlers.onPreview(message.typologyKey, message.medoidPatients);
                return;
            case "cluster:result":
                handlers.onResult(message.result, message.index, message.total);
                return;
            case "cluster:done":
                handlers.onDone();
                return;
            case "cluster:error":
                handlers.onError(message.message, message.typologyKey);
                return;
        }
    }
    run(matrices, params, handlers) {
        const worker = this.ensureWorker();
        this.currentRunId = this.nextRunId++;
        this.handlers = handlers;
        this.paused = false;
        this.held = [];
        const request = {
            type: "cluster:run",
            runId: this.currentRunId,
            matrices,
            params,
        };
        worker.postMessage(request, { transfer: matrices.flatMap(matrixTransferables) });
    }
    pause() {
        this.paused = true; // freeze the UI immediately, before any more results land
        this.worker?.postMessage({ type: "cluster:pause" });
    }
    resume() {
        this.paused = false;
        const held = this.held;
        this.held = [];
        for (const message of held)
            this.apply(message);
        this.worker?.postMessage({ type: "cluster:resume" });
    }
    cancel() {
        this.paused = false;
        this.held = [];
        this.currentRunId = 0;
        this.worker?.postMessage({ type: "cluster:cancel" });
    }
    dispose() {
        this.worker?.terminate();
        this.worker = null;
    }
}
