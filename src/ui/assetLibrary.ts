import { el } from "./dom";
import { assetIconSvg } from "./assetIcons";
import { resolveAssetThumbnailUrl } from "./assetThumbnails";
import { assetCategoryLabel, createAssetPreview, formatAssetDimensions } from "./assetPreview";
import type { AssetPreview } from "./assetPreview";
import { ASSET_CATEGORIES, assetDefinitionsIn, searchAssetDefinitions } from "../engine/assets/catalog";
import type { AssetCategory, AssetDefinition } from "../engine/assets/catalog";

/** How long a hover must linger before the preview appears/disappears - short enough to feel immediate, long enough that sweeping the mouse across the grid never flickers a preview per card (task section 8). */
const PREVIEW_SHOW_DELAY_MS = 150;
const PREVIEW_HIDE_DELAY_MS = 150;

/** "Sofa / Living / 2.0 × 0.92 × 0.85 m / A three-seat sofa..." - the existing description, plus category and real dimensions (task section 1), never invented metadata. */
function assetTooltip(definition: AssetDefinition): string {
  return [definition.label, assetCategoryLabel(definition), formatAssetDimensions(definition), definition.description].join("\n");
}

export interface AssetLibraryOptions {
  /** Arms pick-and-place for this asset - see main.ts's addAsset(). Placing follows the exact same pick→place→select→inspect flow every construction tool already uses. */
  onPlaceAsset(assetId: string): void;
  /**
   * Whether placement tool `id` is the one currently armed in the
   * viewport - the exact same function main.ts already hands the ribbon
   * as `RibbonActions.isPlacementActive` (see ribbonTabs.ts), reused
   * here rather than a second way of asking the same question. main.ts
   * arms an asset under the id `asset:<assetId>` - see this file's
   * refresh().
   */
  isPlacementActive(id: string): boolean;
}

export interface AssetLibrary {
  element: HTMLElement;
  /**
   * Re-checks every visible card's armed state against
   * `isPlacementActive` and updates its class accordingly - called from
   * main.ts's existing `placementController.subscribe()` callback
   * (the same subscription that already drives the ribbon's own active
   * state - see ui/layout.ts/leftSidebar.ts), never a second placement
   * observer. Cheap: only toggles classes on the cards the last render()
   * actually produced (respects the current search filter), no rebuild.
   */
  refresh(): void;
}

/** The placement id main.ts's addAsset() arms an asset under - kept in one place so the library and main.ts can never drift apart on the string shape. */
function placementIdFor(assetId: string): string {
  return `asset:${assetId}`;
}

interface AssetCardHandlers {
  onPlace(assetId: string): void;
  onHoverStart(definition: AssetDefinition, anchor: HTMLElement): void;
  onHoverEnd(): void;
}

function assetCard(definition: AssetDefinition, handlers: AssetCardHandlers): HTMLElement {
  const thumbnailUrl = resolveAssetThumbnailUrl(definition);
  const thumb = el("div", { className: "asset-card__thumb" });
  if (thumbnailUrl) {
    const img = el("img", {
      className: "asset-card__thumb-image",
      attrs: { src: thumbnailUrl, alt: "", loading: "lazy" }
    });
    // A thumbnail that resolves to a URL but fails to actually load (a
    // corrupt file, a 404 at runtime) falls back exactly like one that
    // was never generated - the icon, never a broken-image glyph or an
    // empty box (task: "a missing thumbnail must never produce a
    // blank/broken asset card").
    img.addEventListener(
      "error",
      () => {
        img.remove();
        thumb.classList.add("asset-card__thumb--icon");
        thumb.innerHTML = assetIconSvg(definition.id);
      },
      { once: true }
    );
    thumb.append(img);
  } else {
    // No generated thumbnail yet for this asset - the existing
    // hand-drawn icon, same as before this milestone. Automatic, no
    // per-asset bookkeeping: resolveAssetThumbnailUrl() already decided
    // this by checking the real files on disk.
    thumb.classList.add("asset-card__thumb--icon");
    thumb.innerHTML = assetIconSvg(definition.id);
  }

  const card = el(
    "button",
    {
      className: "asset-card",
      attrs: { type: "button", title: assetTooltip(definition), "aria-label": `Place ${definition.label}` }
    },
    [thumb, el("span", { className: "asset-card__name", text: definition.label })]
  );
  // Hover previews (mouseenter/mouseleave) are entirely independent of
  // this click - clicking still arms placement immediately, exactly as
  // before Phase 4B (task section 4: "hover must not arm placement").
  card.addEventListener("mouseenter", () => handlers.onHoverStart(definition, card));
  card.addEventListener("mouseleave", () => handlers.onHoverEnd());
  card.addEventListener("click", () => {
    handlers.onHoverEnd();
    handlers.onPlace(definition.id);
  });
  return card;
}

function categorySection(
  category: AssetCategory,
  label: string,
  assets: readonly AssetDefinition[],
  handlers: AssetCardHandlers,
  cards: { id: string; card: HTMLElement }[]
): HTMLElement {
  const body =
    assets.length === 0
      ? el("p", { className: "sidebar__placeholder asset-library__empty", text: "No assets available yet." })
      : el(
          "div",
          { className: "asset-library__grid" },
          assets.map((definition) => {
            const card = assetCard(definition, handlers);
            cards.push({ id: definition.id, card });
            return card;
          })
        );
  return el("div", { className: "asset-library__category", attrs: { "data-category": category } }, [
    el("h4", { className: "hierarchy-objects__group-title asset-library__category-title", text: label }),
    body
  ]);
}

/**
 * The visual design-asset browser (task sections 3-4): real rendered
 * thumbnails (see assetThumbnails.ts/scripts/generate-thumbnails.html)
 * grouped by category, with a search field that filters the same catalog
 * by label/category/keyword - never a second, hand-maintained asset list
 * (see engine/assets/catalog.ts, the one source both this panel and
 * AI/commands read from). The 8 categories and their assets are exactly
 * the existing catalog's own - this module invents no grouping of its
 * own.
 *
 * Clicking a card arms pick-and-place through `onPlaceAsset` - in the
 * running app, main.ts's addAsset(), the exact same commandExecutor path
 * every construction tool already uses (task section 7's pick→place→
 * select→inspect flow). This module never touches a store, a command, or
 * Three.js itself.
 */
export function createAssetLibrary(options: AssetLibraryOptions): AssetLibrary {
  const search = el("input", {
    className: "asset-library__search",
    attrs: { type: "search", placeholder: "Search assets (sofa, bed, plant...)", "aria-label": "Search assets" }
  });

  const results = el("div", { className: "asset-library__results" });
  /** The cards the last render() produced, for refresh() to re-check - see AssetLibrary.refresh()'s own docs. */
  let cards: { id: string; card: HTMLElement }[] = [];

  // A single preview surface reused across every card (task section 6-7:
  // one shared, viewport-anchored overlay, not one per card) - see
  // assetPreview.ts's own docs for why it lives on document.body rather
  // than inside this scrolling panel.
  const preview: AssetPreview = createAssetPreview();
  let showTimer: number | undefined;
  let hideTimer: number | undefined;

  const cancelPendingShow = (): void => {
    window.clearTimeout(showTimer);
  };
  const cancelPendingHide = (): void => {
    window.clearTimeout(hideTimer);
  };
  const hideNow = (): void => {
    cancelPendingShow();
    cancelPendingHide();
    preview.hide();
  };
  const handlers: AssetCardHandlers = {
    onPlace: options.onPlaceAsset,
    onHoverStart: (definition, anchor) => {
      cancelPendingHide();
      cancelPendingShow();
      showTimer = window.setTimeout(() => preview.show(definition, anchor), PREVIEW_SHOW_DELAY_MS);
    },
    onHoverEnd: () => {
      cancelPendingShow();
      cancelPendingHide();
      hideTimer = window.setTimeout(() => preview.hide(), PREVIEW_HIDE_DELAY_MS);
    }
  };
  // Moving from a card onto the preview itself (task section 6: "preview
  // remains available") cancels that pending hide; leaving the preview
  // (to empty space, not back onto a card) hides it the same way leaving
  // a card does.
  preview.element.addEventListener("mouseenter", cancelPendingHide);
  preview.element.addEventListener("mouseleave", () => {
    hideTimer = window.setTimeout(() => preview.hide(), PREVIEW_HIDE_DELAY_MS);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideNow();
    }
  });

  const render = (): void => {
    cards = [];
    const query = search.value.trim();
    if (!query) {
      results.replaceChildren(
        ...ASSET_CATEGORIES.map((category) => categorySection(category.id, category.label, assetDefinitionsIn(category.id), handlers, cards))
      );
    } else {
      const matches = searchAssetDefinitions(query);
      results.replaceChildren(
        matches.length === 0
          ? el("p", { className: "sidebar__placeholder asset-library__empty", text: `No assets match "${query}".` })
          : el(
              "div",
              { className: "asset-library__grid" },
              matches.map((definition) => {
                const card = assetCard(definition, handlers);
                cards.push({ id: definition.id, card });
                return card;
              })
            )
      );
    }
    refresh();
  };

  const refresh = (): void => {
    for (const { id, card } of cards) {
      card.classList.toggle("asset-card--active", options.isPlacementActive(placementIdFor(id)));
    }
  };

  search.addEventListener("input", () => {
    hideNow();
    render();
  });
  render();

  return { element: el("div", { className: "asset-library" }, [search, results]), refresh };
}
