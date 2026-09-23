/// <reference lib="webworker" />

import { payloadTransferables, toPayload } from "../core/model/transfer.ts"
import { ingest } from "../core/parse/ingest.ts"
import { orderStates, summariseStates } from "../core/stats/states.ts"
import { buildTypologies } from "../core/stats/typologies.ts"
import { Stopwatch } from "../core/util/time.ts"
import { toStatePayload, type WorkerRequest, type WorkerResponse } from "./protocol.ts"

/**
 * Parsing, store construction and the two aggregate passes all run here.
 *
 * In the original everything happened inside `useMemo` on the main thread, so a
 * large import froze the page for the whole pipeline — the parse, the enrich,
 * the trajectory build and the silhouette grouping. The only thing that crosses
 * back is a set of transferred ArrayBuffers.
 */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type !== "ingest") return

  try {
    const clock = new Stopwatch()

    const options = request.mapping === undefined ? {} : { mapping: request.mapping }
    const result = ingest(request.text, request.fileName, options)

    const states = clock.measure("summarise states", () => summariseStates(result.store))
    const stateOrder = clock.measure("order states", () => orderStates(states))
    const typologies = clock.measure("group typologies", () => buildTypologies(result.store))

    const payload = toPayload(result.store)

    const response: WorkerResponse = {
      type: "ingest:ok",
      requestId: request.requestId,
      store: payload,
      mapping: result.mapping,
      format: result.format,
      states: states.map(toStatePayload),
      stateOrder: stateOrder.map(Number),
      typologies,
      timings: [...result.timings, ...clock.timings],
    }

    const transfer = [
      ...payloadTransferables(payload),
      ...response.states.map((s) => s.frequencies.buffer as Transferable),
    ]

    self.postMessage(response, { transfer })
  } catch (error) {
    const response: WorkerResponse = {
      type: "ingest:error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    }
    self.postMessage(response)
  }
}
