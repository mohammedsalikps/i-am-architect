/**
 * One small, hand-drawn SVG silhouette per catalog asset - a real visual
 * thumbnail (task section 3: "actual visual thumbnails rather than
 * text-only buttons"), not a photo and not a claim of realism, in the
 * same spirit as the asset models themselves (scripts/generate-asset-models.mjs):
 * simple, honest, geometric shapes that read at a glance. Every path uses
 * `currentColor` so a card can recolor it (e.g. on hover) with plain CSS,
 * no per-state markup.
 *
 * Deliberately flat inline SVG rather than a live per-card 3D render:
 * a scrolling library of a dozen-plus simultaneous WebGL contexts is a
 * real performance cost for very little visual gain over a clear
 * silhouette (task section 19: caching/lazy-loading, not "load everything
 * to preview it").
 */

const FALLBACK_ICON = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="14" width="28" height="20" rx="2" stroke="currentColor" stroke-width="2"/></svg>`;

const ASSET_ICONS: Readonly<Record<string, string>> = {
  sofa: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 26v6a2 2 0 0 0 2 2h28a2 2 0 0 0 2-2v-6" stroke="currentColor" stroke-width="2"/><rect x="6" y="20" width="6" height="12" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="36" y="20" width="6" height="12" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="10" y="16" width="28" height="12" rx="2" stroke="currentColor" stroke-width="2"/></svg>`,
  "coffee-table": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="18" width="36" height="4" rx="1" stroke="currentColor" stroke-width="2"/><path d="M10 22v10M38 22v10" stroke="currentColor" stroke-width="2"/></svg>`,
  "tv-console": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="20" width="36" height="12" rx="2" stroke="currentColor" stroke-width="2"/><rect x="14" y="9" width="20" height="9" rx="1" stroke="currentColor" stroke-width="2"/></svg>`,
  plant: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 30h16l-2 8H18l-2-8Z" stroke="currentColor" stroke-width="2"/><circle cx="24" cy="18" r="10" stroke="currentColor" stroke-width="2"/></svg>`,
  bed: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="24" width="36" height="10" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="6" y="14" width="8" height="10" rx="1" stroke="currentColor" stroke-width="2"/><rect x="16" y="18" width="12" height="6" rx="1" stroke="currentColor" stroke-width="2"/><path d="M6 34v4M42 34v4" stroke="currentColor" stroke-width="2"/></svg>`,
  "bedside-table": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="14" y="14" width="20" height="20" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M14 24h20" stroke="currentColor" stroke-width="2"/></svg>`,
  wardrobe: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="7" width="24" height="34" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M24 7v34" stroke="currentColor" stroke-width="2"/></svg>`,
  "dining-table": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="17" width="36" height="4" rx="1" stroke="currentColor" stroke-width="2"/><path d="M10 21v10M38 21v10" stroke="currentColor" stroke-width="2"/></svg>`,
  "dining-chair": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="14" y="22" width="16" height="4" rx="1" stroke="currentColor" stroke-width="2"/><path d="M14 12v14M30 12v14M16 26v10M28 26v10" stroke="currentColor" stroke-width="2"/></svg>`,
  "kitchen-counter": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="14" width="36" height="6" rx="1" stroke="currentColor" stroke-width="2"/><rect x="8" y="20" width="32" height="14" rx="1" stroke="currentColor" stroke-width="2"/><rect x="26" y="15" width="8" height="4" rx="0.5" stroke="currentColor" stroke-width="1.5"/></svg>`,
  toilet: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="16" y="8" width="16" height="10" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M14 20c0-1 1-2 2-2h16c1 0 2 1 2 2v6c0 5-4 10-10 10s-10-5-10-10v-6Z" stroke="currentColor" stroke-width="2"/></svg>`,
  "floor-lamp": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 10h12l4 8H14l4-8Z" stroke="currentColor" stroke-width="2"/><path d="M24 18v20" stroke="currentColor" stroke-width="2"/><path d="M14 38h20" stroke="currentColor" stroke-width="2"/></svg>`,
  rug: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="14" width="36" height="20" rx="2" stroke="currentColor" stroke-width="2"/><rect x="11" y="19" width="26" height="10" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>`
};

/** The asset's own icon, or a plain box outline if it has none - never a blank card. */
export function assetIconSvg(assetId: string): string {
  return ASSET_ICONS[assetId] ?? FALLBACK_ICON;
}
