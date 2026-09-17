import { el } from "./dom";
import { assetIconSvg } from "./assetIcons";
import { resolveAssetThumbnailUrl } from "./assetThumbnails";
import { ASSET_CATEGORIES } from "../engine/assets/catalog";
import type { AssetDefinition } from "../engine/assets/catalog";

/** "2.00" -> "2.0", "0.92" -> "0.92" - the real catalog number, trimmed to at most 2 decimals without losing a trailing ".0". */
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

function categoryLabelOf(definition: AssetDefinition): string {
  return ASSET_CATEGORIES.find((entry) => entry.id === definition.category)?.label ?? definition.category;
}

export function formatAssetDimensions(definition: AssetDefinition): string {
  const { width, height, depth } = definition.defaultDimensions;
  return `${formatMeters(width)} × ${formatMeters(height)} × ${formatMeters(depth)} m`;
}

export function assetCategoryLabel(definition: AssetDefinition): string {
  return categoryLabelOf(definition);
}

export interface AssetPreview {
  /** The preview surface itself - hovering it should keep it open (see assetLibrary.ts's own mouseenter/mouseleave wiring). */
  element: HTMLElement;
  /** Shows the preview populated with `definition`, positioned beside `anchor`'s current on-screen rect. */
  show(definition: AssetDefinition, anchor: HTMLElement): void;
  hide(): void;
}

/**
 * A static, real-thumbnail information card shown on hover over an asset
 * card (task section 4-9) - never a live 3D preview, never a second click
 * before placement. Appended once to `document.body` (not the asset
 * library's own scrolling panel) so it is never clipped by the left
 * sidebar's `overflow-y: auto` - `position: fixed` positioning, computed
 * in `show()` from the anchor card's real on-screen rect, keeps it fully
 * inside the viewport and clear of the bottom command/status bars on
 * every reflow, at any sidebar width.
 */
export function createAssetPreview(): AssetPreview {
  const thumb = el("div", { className: "asset-preview__thumb" });
  const name = el("h4", { className: "asset-preview__name" });
  const meta = el("p", { className: "asset-preview__meta" });
  const description = el("p", { className: "asset-preview__description" });
  const panel = el("div", { className: "asset-preview", attrs: { role: "note" } }, [thumb, name, meta, description]);
  panel.hidden = true;
  document.body.append(panel);

  function reservedBottomPx(): number {
    const rootStyles = getComputedStyle(document.documentElement);
    const bottomWorkspace = parseFloat(rootStyles.getPropertyValue("--bottomworkspace-height")) || 0;
    const statusBar = parseFloat(rootStyles.getPropertyValue("--statusbar-height")) || 0;
    return bottomWorkspace + statusBar;
  }

  function position(anchor: HTMLElement): void {
    const margin = 10;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Prefer the card's right side; flip to its left if there isn't room,
    // then clamp so it can never extend past either viewport edge.
    let left = anchorRect.right + margin;
    if (left + panelRect.width + margin > viewportWidth) {
      left = anchorRect.left - panelRect.width - margin;
    }
    left = Math.max(margin, Math.min(left, viewportWidth - panelRect.width - margin));

    // Align with the card's top, but never drop the panel into the
    // reserved AI command bar / status bar strip at the bottom, and
    // never push it above the top margin.
    let top = anchorRect.top;
    const maxTop = viewportHeight - reservedBottomPx() - panelRect.height - margin;
    top = Math.min(top, maxTop);
    top = Math.max(margin, top);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function show(definition: AssetDefinition, anchor: HTMLElement): void {
    const thumbnailUrl = resolveAssetThumbnailUrl(definition);
    thumb.classList.remove("asset-preview__thumb--icon");
    thumb.replaceChildren();
    if (thumbnailUrl) {
      const img = el("img", { className: "asset-preview__thumb-image", attrs: { src: thumbnailUrl, alt: "" } });
      img.addEventListener(
        "error",
        () => {
          img.remove();
          thumb.classList.add("asset-preview__thumb--icon");
          thumb.innerHTML = assetIconSvg(definition.id);
        },
        { once: true }
      );
      thumb.append(img);
    } else {
      thumb.classList.add("asset-preview__thumb--icon");
      thumb.innerHTML = assetIconSvg(definition.id);
    }

    name.textContent = definition.label;
    meta.textContent = `${categoryLabelOf(definition)} · ${formatAssetDimensions(definition)}`;
    description.textContent = definition.description;

    panel.hidden = false;
    position(anchor);
  }

  function hide(): void {
    panel.hidden = true;
  }

  return { element: panel, show, hide };
}
