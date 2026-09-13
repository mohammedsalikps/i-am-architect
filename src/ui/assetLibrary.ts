import { el } from "./dom";
import { assetIconSvg } from "./assetIcons";
import { ASSET_CATEGORIES, assetDefinitionsIn, searchAssetDefinitions } from "../engine/assets/catalog";
import type { AssetCategory, AssetDefinition } from "../engine/assets/catalog";

export interface AssetLibraryOptions {
  /** Arms pick-and-place for this asset - see main.ts's addAsset(). Placing follows the exact same pick→place→select→inspect flow every construction tool already uses. */
  onPlaceAsset(assetId: string): void;
}

function assetCard(definition: AssetDefinition, onPlace: (assetId: string) => void): HTMLElement {
  const icon = el("div", { className: "asset-card__icon" });
  icon.innerHTML = assetIconSvg(definition.id);

  const card = el(
    "button",
    {
      className: "asset-card",
      attrs: { type: "button", title: definition.description, "aria-label": `Place ${definition.label}` }
    },
    [icon, el("span", { className: "asset-card__name", text: definition.label })]
  );
  card.addEventListener("click", () => onPlace(definition.id));
  return card;
}

function categorySection(category: AssetCategory, label: string, assets: readonly AssetDefinition[], onPlace: (assetId: string) => void): HTMLElement {
  const body =
    assets.length === 0
      ? el("p", { className: "sidebar__placeholder asset-library__empty", text: "No assets available yet." })
      : el(
          "div",
          { className: "asset-library__grid" },
          assets.map((definition) => assetCard(definition, onPlace))
        );
  return el("div", { className: "asset-library__category", attrs: { "data-category": category } }, [
    el("h4", { className: "hierarchy-objects__group-title asset-library__category-title", text: label }),
    body
  ]);
}

/**
 * The visual design-asset browser (task sections 3-4): real thumbnails
 * (see assetIcons.ts) grouped by category, with a search field that
 * filters the same catalog by label/category/keyword - never a second,
 * hand-maintained asset list (see engine/assets/catalog.ts, the one
 * source both this panel and AI/commands read from).
 *
 * Clicking a card arms pick-and-place through `onPlaceAsset` - in the
 * running app, main.ts's addAsset(), the exact same commandExecutor path
 * every construction tool already uses (task section 7's pick→place→
 * select→inspect flow). This module never touches a store, a command, or
 * Three.js itself.
 */
export function createAssetLibrary(options: AssetLibraryOptions): HTMLElement {
  const search = el("input", {
    className: "asset-library__search",
    attrs: { type: "search", placeholder: "Search assets (sofa, bed, plant...)", "aria-label": "Search assets" }
  });

  const results = el("div", { className: "asset-library__results" });

  const render = (): void => {
    const query = search.value.trim();
    if (!query) {
      results.replaceChildren(
        ...ASSET_CATEGORIES.map((category) => categorySection(category.id, category.label, assetDefinitionsIn(category.id), options.onPlaceAsset))
      );
      return;
    }
    const matches = searchAssetDefinitions(query);
    results.replaceChildren(
      matches.length === 0
        ? el("p", { className: "sidebar__placeholder asset-library__empty", text: `No assets match "${query}".` })
        : el(
            "div",
            { className: "asset-library__grid" },
            matches.map((definition) => assetCard(definition, options.onPlaceAsset))
          )
    );
  };

  search.addEventListener("input", render);
  render();

  return el("div", { className: "asset-library" }, [search, results]);
}
