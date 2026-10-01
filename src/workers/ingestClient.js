/**
 * Promise wrapper around the ingest worker.
 *
 * One worker is reused across imports, and requests carry an id so a slow import
 * that the user has already replaced resolves to nothing instead of overwriting
 * the newer dataset — the `runId` cancellation pattern from the clustering
 * worker, applied to loading.
 */
export class IngestClient {
    worker = null;
    nextRequestId = 1;
    latestRequestId = 0;
    ensureWorker() {
        this.worker ??= new Worker(new URL("./ingest.worker.ts", import.meta.url), { type: "module" });
        return this.worker;
    }
    ingest(text, fileName, mapping) {
        const worker = this.ensureWorker();
        const requestId = this.nextRequestId++;
        this.latestRequestId = requestId;
        return new Promise((resolve, reject) => {
            const onMessage = (event) => {
                const response = event.data;
                if (response.requestId !== requestId)
                    return;
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                if (requestId !== this.latestRequestId)
                    return; // superseded; drop silently
                if (response.type === "ingest:error")
                    reject(new Error(response.message));
                else
                    resolve(response);
            };
            const onError = (event) => {
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                reject(new Error(event.message));
            };
            worker.addEventListener("message", onMessage);
            worker.addEventListener("error", onError);
            const request = mapping === undefined
                ? { type: "ingest", requestId, text, fileName }
                : { type: "ingest", requestId, text, fileName, mapping };
            worker.postMessage(request);
        });
    }
    dispose() {
        this.worker?.terminate();
        this.worker = null;
    }
}
