import { useCallback, useEffect, useRef, useState } from "react"

interface Props {
  readonly bounds: readonly [number, number]
  /** The committed range. `null` means the filter is off, i.e. the full extent. */
  readonly value: readonly [number, number] | null
  readonly width: number
  readonly inverted: boolean
  /** Fires continuously while dragging, already throttled to one frame. */
  readonly onChange: (next: readonly [number, number]) => void
  /**
   * Live handle positions during a drag, and `null` once it ends — at which
   * point the committed value is authoritative again. Without that second half
   * a preview outlives its drag and survives a reset.
   */
  readonly onPreview?: (next: readonly [number, number] | null) => void
  readonly onHoverX?: (x: number | null) => void
}

const TRACK_HEIGHT = 8
const HANDLE_WIDTH = 7
const HANDLE_HEIGHT = 18
const HEIGHT = 24

/**
 * Two handles on one track.
 *
 * The two native `<input type="range">` elements this replaces could express a
 * range only by stacking two sliders, which is why the old panel showed the
 * bounds as text and left you to infer the band. Here the band *is* the control:
 * it lines up pixel for pixel with the distribution drawn above it, so a handle
 * lands on a feature of the data rather than on a number.
 *
 * The handle position is local state while dragging and only syncs down from
 * `value` when a drag is not in progress. That is what keeps the handle glued to
 * the pointer no matter what the commit costs downstream — the original made the
 * same split, and called it out as "never debounced, always instant".
 */
export function RangeSlider({
  bounds,
  value,
  width,
  inverted,
  onChange,
  onPreview,
  onHoverX,
}: Props): React.JSX.Element {
  const [lo, hi] = bounds
  const span = Math.max(hi - lo, 1e-9)

  const committed = value ?? bounds
  const [local, setLocal] = useState<readonly [number, number]>(committed)
  const [dragging, setDragging] = useState<"min" | "max" | null>(null)

  // While dragging, this component is the source of truth; outside a drag the
  // store is (a reset, a chip's ✕, a reshape that moved the extents).
  useEffect(() => {
    if (dragging === null) setLocal(committed)
  }, [dragging, committed[0], committed[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  const trackRef = useRef<SVGRectElement>(null)
  const usable = Math.max(width - HANDLE_WIDTH, 1)

  const toPixels = useCallback((v: number) => ((v - lo) / span) * usable, [lo, span, usable])
  const toValue = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (rect === undefined) return lo
      const x = Math.max(0, Math.min(clientX - rect.left, usable))
      return lo + (x / usable) * span
    },
    [lo, span, usable],
  )

  // Commits are coalesced to one per frame: a pointer fires many more moves than
  // there are frames, and each commit re-runs the filter and the layers behind it.
  const pending = useRef<readonly [number, number] | null>(null)
  const frame = useRef(0)

  const commit = useCallback(
    (next: readonly [number, number]) => {
      pending.current = next
      if (frame.current !== 0) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        if (pending.current !== null) onChange(pending.current)
        pending.current = null
      })
    },
    [onChange],
  )

  /**
   * Sends whatever the last frame did not, synchronously.
   *
   * Handing the preview back at the end of a drag only works if the commit has
   * already landed — otherwise the display falls back to a committed value that
   * is one frame stale, and the band jumps backwards before catching up.
   */
  const flush = useCallback(() => {
    if (frame.current !== 0) {
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
    if (pending.current !== null) {
      onChange(pending.current)
      pending.current = null
    }
  }, [onChange])

  useEffect(
    () => () => {
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
    },
    [],
  )

  const end = useCallback(() => {
    flush()
    setDragging(null)
    onPreview?.(null)
  }, [flush, onPreview])

  const move = useCallback(
    (handle: "min" | "max", at: number) => {
      const next: readonly [number, number] =
        handle === "min"
          ? [Math.min(at, local[1]), local[1]]
          : [local[0], Math.max(at, local[0])]

      setLocal(next)
      onPreview?.(next)
      commit(next)
    },
    [local, commit, onPreview],
  )

  const start = (event: React.PointerEvent<SVGSVGElement>): void => {
    const at = toValue(event.clientX)
    // Grab whichever handle is nearer, so the track is draggable anywhere.
    const handle = Math.abs(at - local[0]) <= Math.abs(at - local[1]) ? "min" : "max"

    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(handle)
    move(handle, at)
  }

  const minX = toPixels(local[0])
  const maxX = toPixels(local[1])

  return (
    <svg
      className="slider"
      width={width}
      height={HEIGHT}
      onPointerDown={start}
      onPointerMove={(event) => {
        onHoverX?.(toPixels(toValue(event.clientX)) + HANDLE_WIDTH / 2)
        if (dragging !== null) move(dragging, toValue(event.clientX))
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId)
        end()
      }}
      // A cancelled pointer (a touch interrupted, a context menu) never sends an
      // up, and without this the slider would stay latched to a drag that is over.
      onPointerCancel={end}
      onPointerLeave={() => onHoverX?.(null)}
    >
      <g transform={`translate(${HANDLE_WIDTH / 2} ${(HEIGHT - TRACK_HEIGHT) / 2})`}>
        <rect className="slider__track" x={0} width={usable} height={TRACK_HEIGHT} rx={2} />

        {/* Inverted: the *outside* is what is kept, so that is what is lit. */}
        {inverted ? (
          <>
            <rect className="slider__range" x={0} width={Math.max(minX, 0)} height={TRACK_HEIGHT} />
            <rect
              className="slider__range"
              x={maxX}
              width={Math.max(usable - maxX, 0)}
              height={TRACK_HEIGHT}
            />
          </>
        ) : (
          <rect
            className="slider__range"
            x={minX}
            width={Math.max(maxX - minX, 0)}
            height={TRACK_HEIGHT}
          />
        )}

        <rect ref={trackRef} x={0} width={usable} height={TRACK_HEIGHT} fill="transparent" />
      </g>

      {(["min", "max"] as const).map((handle) => (
        <rect
          key={handle}
          className="slider__handle"
          data-active={dragging === handle}
          x={(handle === "min" ? minX : maxX)}
          y={(HEIGHT - HANDLE_HEIGHT) / 2}
          width={HANDLE_WIDTH}
          height={HANDLE_HEIGHT}
          rx={2}
        />
      ))}
    </svg>
  )
}
