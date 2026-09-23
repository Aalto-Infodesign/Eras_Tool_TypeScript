import { matrixTransferables, type DurationMatrix } from "../core/cluster/matrices.ts"
import type { ClusterParams, TypologyClusters } from "../core/cluster/types.ts"
import type { ClusterRequest, ClusterResponse } from "./clusterProtocol.ts"

export interface ClusterHandlers {
  onPreview(typologyKey: string, medoidPatients: Uint32Array): void
  onResult(result: TypologyClusters, index: number, total: number): void
  onDone(): void
  onError(message: string, typologyKey: string | null): void
}

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
  private worker: Worker | null = null
  private nextRunId = 1
  private currentRunId = 0
  private handlers: ClusterHandlers | null = null
  private paused = false
  private held: ClusterResponse[] = []

  private ensureWorker(): Worker {
    if (this.worker === null) {
      this.worker = new Worker(new URL("./cluster.worker.ts", import.meta.url), { type: "module" })
      this.worker.addEventListener("message", this.onMessage)
      this.worker.addEventListener("error", this.onError)
    }
    return this.worker
  }

  private readonly onMessage = (event: MessageEvent<ClusterResponse>): void => {
    const message = event.data
    if (message.runId !== this.currentRunId) return // superseded run

    if (this.paused) {
      this.held.push(message)
      return
    }
    this.apply(message)
  }

  private readonly onError = (event: ErrorEvent): void => {
    this.handlers?.onError(event.message, null)
  }

  private apply(message: ClusterResponse): void {
    const handlers = this.handlers
    if (handlers === null) return

    switch (message.type) {
      case "cluster:preview":
        handlers.onPreview(message.typologyKey, message.medoidPatients)
        return
      case "cluster:result":
        handlers.onResult(message.result, message.index, message.total)
        return
      case "cluster:done":
        handlers.onDone()
        return
      case "cluster:error":
        handlers.onError(message.message, message.typologyKey)
        return
    }
  }

  run(
    matrices: readonly DurationMatrix[],
    params: ClusterParams,
    handlers: ClusterHandlers,
  ): void {
    const worker = this.ensureWorker()
    this.currentRunId = this.nextRunId++
    this.handlers = handlers
    this.paused = false
    this.held = []

    const request: ClusterRequest = {
      type: "cluster:run",
      runId: this.currentRunId,
      matrices,
      params,
    }

    worker.postMessage(request, { transfer: matrices.flatMap(matrixTransferables) })
  }

  pause(): void {
    this.paused = true // freeze the UI immediately, before any more results land
    this.worker?.postMessage({ type: "cluster:pause" } satisfies ClusterRequest)
  }

  resume(): void {
    this.paused = false
    const held = this.held
    this.held = []
    for (const message of held) this.apply(message)
    this.worker?.postMessage({ type: "cluster:resume" } satisfies ClusterRequest)
  }

  cancel(): void {
    this.paused = false
    this.held = []
    this.currentRunId = 0
    this.worker?.postMessage({ type: "cluster:cancel" } satisfies ClusterRequest)
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
