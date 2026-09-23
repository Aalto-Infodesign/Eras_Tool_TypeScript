import type { ColumnMapping } from "../core/parse/schema.ts"
import type { IngestSuccess, WorkerRequest, WorkerResponse } from "./protocol.ts"

/**
 * Promise wrapper around the ingest worker.
 *
 * One worker is reused across imports, and requests carry an id so a slow import
 * that the user has already replaced resolves to nothing instead of overwriting
 * the newer dataset — the `runId` cancellation pattern from the clustering
 * worker, applied to loading.
 */
export class IngestClient {
  private worker: Worker | null = null
  private nextRequestId = 1
  private latestRequestId = 0

  private ensureWorker(): Worker {
    this.worker ??= new Worker(new URL("./ingest.worker.ts", import.meta.url), { type: "module" })
    return this.worker
  }

  ingest(text: string, fileName: string, mapping?: ColumnMapping): Promise<IngestSuccess> {
    const worker = this.ensureWorker()
    const requestId = this.nextRequestId++
    this.latestRequestId = requestId

    return new Promise<IngestSuccess>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data
        if (response.requestId !== requestId) return

        worker.removeEventListener("message", onMessage)
        worker.removeEventListener("error", onError)

        if (requestId !== this.latestRequestId) return // superseded; drop silently
        if (response.type === "ingest:error") reject(new Error(response.message))
        else resolve(response)
      }

      const onError = (event: ErrorEvent) => {
        worker.removeEventListener("message", onMessage)
        worker.removeEventListener("error", onError)
        reject(new Error(event.message))
      }

      worker.addEventListener("message", onMessage)
      worker.addEventListener("error", onError)

      const request: WorkerRequest =
        mapping === undefined
          ? { type: "ingest", requestId, text, fileName }
          : { type: "ingest", requestId, text, fileName, mapping }

      worker.postMessage(request)
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
