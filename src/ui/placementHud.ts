import { el } from "./dom";

export interface PlacementHudState {
  label: string;
  dimensions: { width: number; height: number; depth: number };
  /** Omitted for a construction element (wall/pillar/beam/...): none of them support pre-placement rotation, so showing a static, uneditable "Rotation 0°" would be noise rather than information. Present only for an asset, where R/Shift+R actually changes it. */
  rotationDegrees?: number;
  /** Viewport-relative (client) pixel position to anchor near - the on-screen projection of the ground point under the preview. */
  anchor: { x: number; y: number };
  /** Whether the current placement point snapped to something (a grid line, a wall corner/endpoint, an alignment) - task section 6/3: "provide a clear indication when an object is snapped." Omitted or false shows no indicator at all, never a misleading one. */
  snapped?: boolean;
}

export interface PlacementHud {
  element: HTMLElement;
  update(state: PlacementHudState | null): void;
}

/** "2.00" -> "2.0", "0.92" -> "0.92" - mirrors ui/assetPreview.ts's own formatter (kept local rather than shared, since it's five lines and the two modules have no other reason to depend on each other). */
function formatMeters(value: number): string {
  let text = value.toFixed(2);
  if (text.endsWith("0")) {
    text = text.slice(0, -1);
  }
  if (text.endsWith(".")) {
    text += "0";
  }
  return text;
}

function reservedBottomPx(): number {
  const rootStyles = getComputedStyle(document.documentElement);
  const bottomWorkspace = parseFloat(rootStyles.getPropertyValue("--bottomworkspace-height")) || 0;
  const statusBar = parseFloat(rootStyles.getPropertyValue("--statusbar-height")) || 0;
  return bottomWorkspace + statusBar;
}

/**
 * A small, contextual "Sofa / 2.00 x 0.92 x 0.85 m / Rotation 90 degrees"
 * card that follows the asset placement preview (Phase 5A) - deliberately
 * independent of SceneManager's own .manipulation-readout, which belongs
 * to ManipulationController's drag gestures; reusing that element would
 * couple placement state to manipulation state for no reason (task: "do
 * not reuse ... if doing so would couple placement and manipulation
 * state"). Appended to document.body and positioned with `fixed`
 * coordinates - the same technique ui/assetPreview.ts's hover preview
 * already uses - so it is never clipped by any panel and always
 * clamped inside the viewport, clear of the bottom command/status bars.
 */
export function createPlacementHud(): PlacementHud {
  const name = el("div", { className: "placement-hud__name" });
  const dimensions = el("div", { className: "placement-hud__dimensions" });
  const rotation = el("div", { className: "placement-hud__rotation" });
  const snapIndicator = el("div", { className: "placement-hud__snap", text: "Snapped" });
  const panel = el("div", { className: "placement-hud", attrs: { role: "status" } }, [name, dimensions, rotation, snapIndicator]);
  panel.hidden = true;

  function update(state: PlacementHudState | null): void {
    if (!state) {
      panel.hidden = true;
      return;
    }

    name.textContent = state.label;
    const { width, height, depth } = state.dimensions;
    dimensions.textContent = `${formatMeters(width)} × ${formatMeters(height)} × ${formatMeters(depth)} m`;
    rotation.hidden = state.rotationDegrees === undefined;
    rotation.textContent = state.rotationDegrees === undefined ? "" : `Rotation ${state.rotationDegrees}°`;
    snapIndicator.hidden = !state.snapped;
    panel.hidden = false;

    const margin = 12;
    const offsetX = 18;
    const offsetY = 18;
    const panelRect = panel.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Prefer just above and to the right of the ground point - clear of
    // the cursor and the model's own footprint - flipping/clamping so it
    // never crosses a viewport edge or the reserved bottom chrome.
    let left = state.anchor.x + offsetX;
    if (left + panelRect.width + margin > viewportWidth) {
      left = state.anchor.x - offsetX - panelRect.width;
    }
    left = Math.max(margin, Math.min(left, viewportWidth - panelRect.width - margin));

    let top = state.anchor.y - offsetY - panelRect.height;
    const maxTop = viewportHeight - reservedBottomPx() - panelRect.height - margin;
    top = Math.min(top, maxTop);
    top = Math.max(margin, top);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  return { element: panel, update };
}
