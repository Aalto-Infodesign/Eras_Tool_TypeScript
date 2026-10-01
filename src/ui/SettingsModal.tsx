import { isAvailable, PANELS, useSidePanels, type PanelId } from "../app/sidePanels.ts"
import { chartModeOf, useEras } from "../app/store.ts"
import { Modal } from "./Modal.tsx"
import { PinIcon } from "./Panel.tsx"

const TITLES = new Map(PANELS.map((panel) => [panel.id, panel.title]))

/**
 * The settings that do not earn a place on screen: tuning the chart, and
 * arranging the side column. One dialog for both, opened from the gear at the
 * end of the control bar or from the foot of the column.
 *
 * The backdrop is lighter than the other dialogs' and unblurred, so the opacity
 * slider can be judged against the chart behind it.
 */
export function SettingsModal(): React.JSX.Element {
  const open = useSidePanels((s) => s.settingsOpen)
  const setOpen = useSidePanels((s) => s.setSettingsOpen)

  return (
    <Modal
      open={open}
      title="Settings"
      onClose={() => setOpen(false)}
      className="modal--settings"
    >
      <section className="settings__section">
        <h3>Chart</h3>
        <OpacitySetting />
      </section>
      <section className="settings__section">
        <h3>Side panels</h3>
        <PanelSettings />
      </section>
    </Modal>
  )
}

/** Moved here from the control bar; the logic is the one it had there. */
function OpacitySetting(): React.JSX.Element {
  const view = useEras((s) => s.view)
  const opacity = useEras((s) => s.opacity)
  const setOpacity = useEras((s) => s.setOpacity)
  const layers = useEras((s) => s.layers)
  const selectedTypologies = useEras((s) => s.selectedTypologies)

  /*
   * The grid draws every panel's own cohort whatever the Lines toggle says —
   * those hairlines *are* the panel, the thing whose slope is being compared,
   * not a layer over something else. So the slider still governs them there,
   * where in the single chart it belongs to a layer you can switch off.
   */
  const isGrid = chartModeOf(selectedTypologies) === "multiples"
  // The hairlines step back under anything drawn over them, and the slider
  // changes meaning with them. See `ViewState.bulkFade`.
  const isBackdrop = (layers.lines || isGrid) && (layers.medoids || layers.lumps)
  const applies = view === "trajectories" && (layers.lines || isGrid)

  return (
    <label className="settings__row" data-disabled={!applies}>
      <span className="settings__label">
        {isBackdrop ? "Line backdrop" : "Line opacity"}
        <small>
          {view === "sankey"
            ? "Trajectories view only"
            : !applies
              ? "Needs the Lines layer"
              : isBackdrop
                ? "Mixed into the background, so crossings do not stack"
                : "Alpha of each trajectory line"}
        </small>
      </span>
      <input
        type="range"
        className="settings__range"
        min={0.02}
        max={1}
        step={0.01}
        value={opacity}
        disabled={!applies}
        onChange={(event) => setOpacity(Number(event.target.value))}
      />
      <span className="controls__value">{applies ? opacity.toFixed(2) : "—"}</span>
    </label>
  )
}

function PanelSettings(): React.JSX.Element {
  const order = useSidePanels((s) => s.order)
  const hidden = useSidePanels((s) => s.hidden)
  const pinned = useSidePanels((s) => s.pinned)
  const move = useSidePanels((s) => s.move)
  const setVisible = useSidePanels((s) => s.setVisible)
  const togglePinned = useSidePanels((s) => s.togglePinned)
  const resetLayout = useSidePanels((s) => s.resetLayout)

  const ids = order.filter(isAvailable)

  return (
    <>
      <p className="settings__hint">
        Pinned panels stay above the scrolling part of the column. The pin in a panel's header
        does the same.
      </p>
      <ol className="settings__panels">
        {ids.map((id: PanelId, index) => {
          const title = TITLES.get(id) ?? id
          const isVisible = !hidden.includes(id)
          const isPinned = pinned.includes(id)
          return (
            <li key={id} className="settings__panel" data-hidden={!isVisible}>
              <label className="settings__check">
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={(event) => setVisible(id, event.target.checked)}
                />
                {title}
              </label>
              <button
                type="button"
                className="settings__icon"
                aria-pressed={isPinned}
                aria-label={isPinned ? `Unpin ${title}` : `Pin ${title}`}
                title={isPinned ? "Unpin" : "Pin to the top"}
                onClick={() => togglePinned(id)}
              >
                <PinIcon />
              </button>
              <button
                type="button"
                className="settings__icon"
                aria-label={`Move ${title} up`}
                disabled={index === 0}
                onClick={() => move(id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="settings__icon"
                aria-label={`Move ${title} down`}
                disabled={index === ids.length - 1}
                onClick={() => move(id, 1)}
              >
                ↓
              </button>
            </li>
          )
        })}
      </ol>
      <div className="settings__actions">
        <button type="button" className="button button--tiny" onClick={resetLayout}>
          Reset to default
        </button>
      </div>
    </>
  )
}
