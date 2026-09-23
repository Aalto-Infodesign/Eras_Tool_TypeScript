import { useEras } from "../app/store.ts"
import { Panel } from "./Panel.tsx"

/**
 * The pipeline's cost, itemised.
 *
 * The original scattered `console.time` probes through the hooks; collecting
 * them into a visible panel is what makes "is this change faster?" answerable
 * without a profiler open.
 */
export function PerfHud(): React.JSX.Element | null {
  const timings = useEras((s) => s.timings)
  const reshapeTimings = useEras((s) => s.reshapeTimings)
  const store = useEras((s) => s.store)
  const cohortSize = useEras((s) => s.cohortSize)
  const format = useEras((s) => s.mapping?.source ?? null)

  if (store === null || timings.length === 0) return null

  const total = timings.reduce((sum, t) => sum + t.ms, 0)
  const slowest = Math.max(...timings.map((t) => t.ms))

  return (
    <Panel title="Ingest" count={`${total.toFixed(0)}ms`} className="panel--hud">

      <dl className="hud__facts">
        <div>
          <dt>Patients</dt>
          <dd>
            {cohortSize.toLocaleString()}
            {/* Removing a state can empty a patient; say so rather than just
                showing a number that quietly shrank. */}
            {cohortSize < store.patientCount && (
              <em> −{(store.patientCount - cohortSize).toLocaleString()}</em>
            )}
          </dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{store.eventCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>States</dt>
          <dd>{store.stateNames.length}</dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>{formatBytes(storeBytes(store))}</dd>
        </div>
      </dl>

      <ul className="hud__timings">
        {timings.map((timing) => (
          <li key={timing.label}>
            <span className="hud__label">{timing.label}</span>
            <span className="hud__bar" style={{ width: `${(timing.ms / slowest) * 100}%` }} />
            <span className="hud__ms">{timing.ms.toFixed(1)}ms</span>
          </li>
        ))}
      </ul>

      {reshapeTimings.length > 0 && (
        <>
          {/* Removing a state rebuilds the dataset, so it earns its own line. */}
          <p className="hud__note">
            re-derived after removing states ·{" "}
            <b>{reshapeTimings.reduce((sum, t) => sum + t.ms, 0).toFixed(0)}ms</b>
          </p>
          <ul className="hud__timings">
            {reshapeTimings.map((timing) => (
              <li key={timing.label}>
                <span className="hud__label">{timing.label}</span>
                <span
                  className="hud__bar hud__bar--reshape"
                  style={{ width: `${(timing.ms / slowest) * 100}%` }}
                />
                <span className="hud__ms">{timing.ms.toFixed(1)}ms</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {format !== null && <p className="hud__note">column mapping: {format}</p>}
    </Panel>
  )
}

function storeBytes(store: NonNullable<ReturnType<typeof useEras.getState>["store"]>): number {
  return (
    store.ids.bytes.byteLength +
    store.ids.offsets.byteLength +
    store.diseaseDuration.byteLength +
    store.offsets.byteLength +
    store.stateIds.byteLength +
    store.ages.byteLength +
    store.years.byteLength +
    store.durations.byteLength +
    store.eventPatient.byteLength
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
