import { useCallback, useRef, useState } from "react"

import { useEras } from "../app/store.ts"
import { MAPPING_SUMMARY_ENABLED, TEMPLATES_ENABLED } from "@app/features.ts"
import { Panel } from "./Panel.tsx"

const TEMPLATES = [
  { label: "Demo · 100", url: "/data/data_semilinear_dates.json" },
  { label: "Medium · 25k", url: "/data/data_25k.json" },
  { label: "Stress · 250k", url: "/data/generated/data_250k.json" },
  { label: "Stress · 1M", url: "/data/generated/data_1m.json" },
] as const

/**
 * The loader as a side panel, once a dataset is open. The file name rides in
 * the header so it stays visible folded, and so does a load error: a failed
 * replace leaves the old data on screen, which must not pass for success.
 */
export function DataPanel(): React.JSX.Element {
  const fileName = useEras((s) => s.fileName)
  const error = useEras((s) => s.error)

  return (
    <Panel
      title="Data"
      count={fileName ?? undefined}
      defaultOpen
      className="panel--data"
      summary={error !== null ? <p className="loader__error">{error}</p> : undefined}
    >
      <FileLoader showError={false} />
    </Panel>
  )
}

/**
 * Upload, drop, or pick a sample. On its own on the empty screen before
 * anything is loaded, and inside `DataPanel` after.
 */
export function FileLoader({
  showError = true,
}: {
  /** Off inside `DataPanel`, which shows the error in its header instead. */
  readonly showError?: boolean
}): React.JSX.Element {
  const status = useEras((s) => s.status)
  const error = useEras((s) => s.error)
  const mapping = useEras((s) => s.mapping)
  const loadFile = useEras((s) => s.loadFile)
  const loadUrl = useEras((s) => s.loadUrl)

  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setDragging] = useState(false)

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files[0]
      if (file !== undefined) void loadFile(file)
    },
    [loadFile],
  )

  return (
    <section
      className={`loader ${isDragging ? "loader--dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="loader__row">
        <button
          type="button"
          className="button button--primary button--tiny"
          onClick={() => inputRef.current?.click()}
          disabled={status === "loading"}
        >
          {status === "loading" ? "Loading…" : "Upload dataset"}
        </button>

        <input
          ref={inputRef}
          type="file"
          accept=".tsv,.csv,.txt,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file !== undefined) void loadFile(file)
          }}
        />

        <div className="loader__templates">
          {TEMPLATES_ENABLED &&
            TEMPLATES.map((template) => (
              <button
                key={template.url}
                type="button"
                className="button button--tiny"
                onClick={() => void loadUrl(template.url)}
                disabled={status === "loading"}
              >
                {template.label}
              </button>
            ))}
        </div>

        {showError && error !== null && <p className="loader__error">{error}</p>}

        {mapping !== null && MAPPING_SUMMARY_ENABLED === true && <MappingSummary />}
      </div>
    </section>
  )
}

/**
 * Shows which column was read as what. The original hard-coded these names, so
 * a file with different headers produced an empty chart and no explanation —
 * making the mapping visible is most of the fix.
 */
function MappingSummary(): React.JSX.Element | null {
  const mapping = useEras((s) => s.mapping)
  if (mapping === null) return null

  const entries = Object.entries(mapping.mapping).filter(([, column]) => column !== null)
  const isUncertain = mapping.confidence < 0.5

  return (
    <div className={`mapping ${isUncertain ? "mapping--uncertain" : ""}`}>
      <span className="mapping__title">
        Columns {isUncertain && <em>· low confidence, please check</em>}
      </span>
      <ul className="mapping__list">
        {entries.map(([role, column]) => (
          <li key={role}>
            <span className="mapping__role">{role}</span>
            <span className="mapping__column">{column}</span>
          </li>
        ))}
      </ul>
      {mapping.notes.map((note) => (
        <p key={note} className="mapping__note">
          {note}
        </p>
      ))}
    </div>
  )
}
