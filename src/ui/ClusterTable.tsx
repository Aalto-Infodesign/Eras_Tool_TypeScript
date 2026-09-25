import { memo, useMemo, useState } from "react"

import { useEras } from "../app/store.ts"
import { Panel } from "./Panel.tsx"
import {
  clusterMemberIds,
  clusterSummaryTsv,
  downloadText,
  membershipsTsv,
  safeFilename,
} from "../core/cluster/export.ts"
import type { TypologyClusters } from "../core/cluster/types.ts"

type SortKey = "size" | "clusters" | "score" | "name"

/**
 * One row per typology, expandable to its clusters.
 *
 * Two things changed from the original table. It is windowed — only the rows
 * near the viewport are mounted, because a real dataset has thousands of
 * typologies and the original rendered every one of them. And each row is memoised
 * on the *result object*, which is now referentially stable once a typology has
 * finished, so a streamed result re-renders exactly one row instead of all of them.
 */
const ROW_HEIGHT = 30
const OVERSCAN = 8

export function ClusterTable(): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const typologies = useEras((s) => s.typologies)
  const clusterRun = useEras((s) => s.clusterRun)
  const clusterVersion = useEras((s) => s.clusterVersion)
  const status = useEras((s) => s.clusterStatus)
  const selectedTypologies = useEras((s) => s.selectedTypologies)
  const toggleTypology = useEras((s) => s.toggleTypology)
  const clearTypologies = useEras((s) => s.clearTypologies)
  const progress = useEras((s) => s.clusterProgress)
  const error = useEras((s) => s.clusterError)

  const [sortKey, setSortKey] = useState<SortKey>("size")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(320)

  const rows = useMemo(() => {
    const list = typologies.map((typology) => ({
      typology,
      result: clusterRun?.byTypology.get(typology.key) ?? null,
    }))

    switch (sortKey) {
      case "name":
        return list.sort((a, b) => a.typology.key.localeCompare(b.typology.key))
      case "clusters":
        return list.sort((a, b) => (b.result?.k ?? -1) - (a.result?.k ?? -1))
      case "score":
        return list.sort(
          (a, b) => (b.result?.meanSilhouette ?? -Infinity) - (a.result?.meanSilhouette ?? -Infinity),
        )
      case "size":
        return list.sort((a, b) => b.typology.size - a.typology.size)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typologies, clusterRun, clusterVersion, sortKey])

  if (store === null) return null

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  const window = rows.slice(first, first + visibleCount)

  const percent = progress.total === 0 ? 0 : (progress.done / progress.total) * 100

  return (
    <Panel
      title="Clusters"
      defaultOpen
      className="panel--table"
      count={
        <>
          {selectedTypologies.length > 0 && (
            <em className="panel__badge">{selectedTypologies.length}</em>
          )}
          {status} · {progress.done}/{progress.total}
        </>
      }
    >

      <div className="clusterbar">
        <div className="clusterbar__fill" style={{ width: `${percent}%` }} />
      </div>
      {error !== null && <p className="loader__error">{error}</p>}

      <div className="table__controls">
        {(["size", "clusters", "score", "name"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className="button"
            data-selected={sortKey === key}
            onClick={() => setSortKey(key)}
          >
            {key}
          </button>
        ))}
        <button
          type="button"
          className="button"
          disabled={selectedTypologies.length === 0}
          title="Stop scoping the chart to the selected typologies"
          onClick={clearTypologies}
        >
          Clear {selectedTypologies.length > 0 ? selectedTypologies.length : ""}
        </button>
        <button
          type="button"
          className="button"
          disabled={clusterRun === null || clusterRun.byTypology.size === 0}
          onClick={() => {
            if (clusterRun === null) return
            downloadText(
              "cluster_summary.tsv",
              clusterSummaryTsv(clusterRun.byTypology, store.ids),
              "text/tab-separated-values",
            )
          }}
        >
          Export summary
        </button>
      </div>

      <div className="table__head">
        <span>Typology</span>
        <span>Size</span>
        <span>Clusters</span>
        <span>Score</span>
        <span>BW</span>
        <span />
      </div>

      <div
        className="table__body"
        ref={(node) => {
          if (node !== null && node.clientHeight !== viewportHeight) {
            setViewportHeight(node.clientHeight)
          }
        }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {/* Spacer preserves the true scroll height while only the window mounts. */}
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
            {window.map(({ typology, result }) => (
              <TypologyRow
                key={typology.key}
                typologyKey={typology.key}
                size={typology.size}
                share={typology.share}
                steps={typology.states.length}
                result={result}
                isSelected={selectedTypologies.includes(typology.key)}
                isExpanded={expanded === typology.key}
                onSelect={() => toggleTypology(typology.key)}
                onToggle={() => setExpanded((c) => (c === typology.key ? null : typology.key))}
              />
            ))}
          </div>
        </div>
      </div>

      {expanded !== null && <ClusterDetail typologyKey={expanded} />}
    </Panel>
  )
}

const TypologyRow = memo(function TypologyRow({
  typologyKey,
  size,
  share,
  steps,
  result,
  isSelected,
  isExpanded,
  onSelect,
  onToggle,
}: {
  typologyKey: string
  size: number
  share: number
  /** States in the sequence. Below two there are no durations to cluster on. */
  steps: number
  result: TypologyClusters | null
  isSelected: boolean
  isExpanded: boolean
  onSelect: () => void
  onToggle: () => void
}): React.JSX.Element {
  /*
   * A one-state typology has no transitions, so it has no duration vector and
   * the clusterer is never handed one. It is not pending and never will be —
   * showing it the same "…" as a typology still in the queue reads as a run
   * that never finishes.
   */
  const clusterable = steps >= 2
  const cell = (value: string): string => (result !== null ? value : clusterable ? "…" : "—")

  return (
    <div
      className="table__row"
      style={{ height: ROW_HEIGHT }}
      data-selected={isSelected}
      data-expanded={isExpanded}
      data-pending={result === null && clusterable}
    >
      {/*
       * Two actions, two buttons. The row is the same unit the silhouette cards
       * are — clicking the name scopes the chart to that typology — while the
       * chevron opens its clusters, so exploring the list never costs you the
       * selection you were reading it with.
       */}
      <button
        type="button"
        className="table__select table__key"
        title={`${typologyKey} — click to scope the chart to it`}
        aria-pressed={isSelected}
        onClick={onSelect}
      >
        {typologyKey}
      </button>
      <span>
        {size.toLocaleString()}
        <em>{(share * 100).toFixed(1)}%</em>
      </span>
      <span>{result === null ? cell("") : result.k}</span>
      <span>{cell(result === null ? "" : result.meanSilhouette.toFixed(3))}</span>
      <span>{cell(result === null ? "" : result.bandwidth.toFixed(2))}</span>
      <button
        type="button"
        className="table__expand"
        aria-expanded={isExpanded}
        title={clusterable ? "Show this typology's clusters" : "Nothing to cluster"}
        disabled={!clusterable}
        onClick={onToggle}
      >
        {isExpanded ? "▾" : "▸"}
      </button>
    </div>
  )
})

function ClusterDetail({ typologyKey }: { typologyKey: string }): React.JSX.Element | null {
  const store = useEras((s) => s.store)
  const clusterRun = useEras((s) => s.clusterRun)
  const selectedClusters = useEras((s) => s.selectedClusters)
  const toggleCluster = useEras((s) => s.toggleCluster)

  const result = clusterRun?.byTypology.get(typologyKey) ?? null
  if (store === null || clusterRun === null || result === null) return null

  const refs = clusterRun.clusters.filter((c) => c.typologyKey === typologyKey)

  return (
    <div className="detail">
      <div className="detail__head">
        <strong>{typologyKey}</strong>
        <button
          type="button"
          className="button"
          onClick={() =>
            downloadText(
              `memberships_${safeFilename(typologyKey)}.tsv`,
              membershipsTsv(result, store.ids),
              "text/tab-separated-values",
            )
          }
        >
          Memberships TSV
        </button>
      </div>

      <ul className="detail__clusters">
        {refs.map((ref) => {
          const isMedian = ref.localCluster === result.medianCluster
          return (
            <li key={ref.globalIndex}>
              <button
                type="button"
                className="detail__cluster"
                data-selected={selectedClusters.includes(ref.globalIndex)}
                onClick={() => toggleCluster(ref.globalIndex)}
              >
                <span className="detail__medoid">{store.ids.at(ref.medoidPatient)}</span>
                <span className="detail__size">{ref.size.toLocaleString()}</span>
                {isMedian && <em className="detail__median">median</em>}
              </button>
              <button
                type="button"
                className="button button--tiny"
                title={`Export ${ref.size} member ids`}
                onClick={() =>
                  downloadText(
                    `cluster_${safeFilename(typologyKey)}_${ref.localCluster}.txt`,
                    clusterMemberIds(result, ref.localCluster, store.ids).join("\n"),
                    "text/plain",
                  )
                }
              >
                ids
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
