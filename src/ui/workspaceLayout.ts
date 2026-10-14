/**
 * The workspace's panel layout: which panels are open and how big they
 * are - the project browser (left, beside its icon rail), the inspector
 * (right), the AI assistant drawer (beside the inspector), the bottom
 * dock (records and secondary work areas, under the viewport) and the
 * tool palette (under the category tabs).
 *
 * Pure state, no DOM: layout.ts renders it, and src/ui/verify.ts tests it
 * in Node. Kept for the browser session only (sessionStorage): a reload
 * keeps the arrangement, a new session starts from the defaults for its
 * window width. Every value read back is checked field by field - a
 * missing or odd one falls back to its default, the rest are kept.
 *
 * The viewport is the point of the workspace, so the panels never squeeze
 * it below MIN_VIEWPORT_WIDTH on a desktop window: fitToWidth() closes
 * panels (the browser first, then the inspector, then the assistant -
 * never the one just opened) until it fits, and the store reopens them
 * when the panel that pushed them out closes again. Dragging a panel's
 * edge stops where the viewport would get too narrow - it never closes
 * another panel. Below COMPACT_WIDTH the panels draw over the viewport
 * instead, one at a time.
 */

export type PanelId = "left" | "right" | "assistant" | "dock" | "ribbon";
export type SidePanelId = "left" | "right" | "assistant";

export interface WorkspaceLayout {
  /** The project browser beside the left icon rail. */
  left: { open: boolean; width: number };
  /** The inspector - Properties and Materials. */
  right: { open: boolean; width: number };
  /** The EAVARA Architect conversation. */
  assistant: { open: boolean; width: number };
  /** Records and secondary work areas under the viewport; `tab` is the one shown. */
  dock: { open: boolean; height: number; tab: string };
  /** The active category's tool palette. */
  ribbon: { open: boolean };
}

/** Each side panel's width range and starting width, px. */
export const PANEL_WIDTHS: Readonly<Record<SidePanelId, { min: number; max: number; initial: number }>> = {
  left: { min: 200, max: 440, initial: 264 },
  right: { min: 240, max: 460, initial: 292 },
  assistant: { min: 320, max: 560, initial: 380 }
};

/** The bottom dock's height range, px - and at most this share of the space it opens into. */
export const DOCK_HEIGHT = { min: 140, initial: 280, maxShare: 0.7 } as const;

/** The left icon rail (always shown) and the closed inspector's tab, px. */
export const RAIL_WIDTH = 62;
export const INSPECTOR_TAB_WIDTH = 30;

/** The narrowest the 3D viewport gets beside open panels on a desktop window, px. */
export const MIN_VIEWPORT_WIDTH = 480;

/** Below this window width the panels draw over the viewport, one at a time. */
export const COMPACT_WIDTH = 900;

export const LAYOUT_STORAGE_KEY = "eavara.workspace-layout.v1";

export const DOCK_TABS = ["measurements", "construction-method", "manual-build", "ai-prompt"] as const;

/** Which panels close first when the viewport runs out of room. */
const CLOSE_ORDER: readonly SidePanelId[] = ["left", "right", "assistant"];

export function isCompact(windowWidth: number): boolean {
  return windowWidth < COMPACT_WIDTH;
}

/** A side panel's width within its range (whole pixels). */
export function clampWidth(panel: SidePanelId, width: number): number {
  const { min, max, initial } = PANEL_WIDTHS[panel];
  if (!Number.isFinite(width)) return initial;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** The dock's height within its range, given the height of the area it opens into (whole pixels). */
export function clampDockHeight(height: number, available: number): number {
  const ceiling = Math.max(DOCK_HEIGHT.min, Math.floor(available * DOCK_HEIGHT.maxShare));
  if (!Number.isFinite(height)) return Math.min(DOCK_HEIGHT.initial, ceiling);
  return Math.round(Math.min(ceiling, Math.max(DOCK_HEIGHT.min, height)));
}

/** The starting layout for a window this wide: browser and inspector open where there is room, the assistant and dock closed. */
export function defaultLayout(windowWidth: number): WorkspaceLayout {
  const compact = isCompact(windowWidth);
  return {
    left: { open: !compact && windowWidth >= 1280, width: windowWidth >= 1600 ? 288 : PANEL_WIDTHS.left.initial },
    right: { open: !compact, width: windowWidth >= 1600 ? 320 : windowWidth < 1280 ? 260 : PANEL_WIDTHS.right.initial },
    assistant: { open: false, width: PANEL_WIDTHS.assistant.initial },
    dock: { open: false, height: DOCK_HEIGHT.initial, tab: DOCK_TABS[0] },
    ribbon: { open: true }
  };
}

/** How wide each side column is right now (the left one includes its rail; a closed inspector keeps its tab). */
export function columnWidths(layout: WorkspaceLayout): { left: number; assistant: number; right: number } {
  return {
    left: RAIL_WIDTH + (layout.left.open ? layout.left.width : 0),
    assistant: layout.assistant.open ? layout.assistant.width : 0,
    right: layout.right.open ? layout.right.width : INSPECTOR_TAB_WIDTH
  };
}

/** The viewport's width beside the open panels, in a body this wide (desktop layout). */
export function viewportWidth(layout: WorkspaceLayout, bodyWidth: number): number {
  const columns = columnWidths(layout);
  return bodyWidth - columns.left - columns.assistant - columns.right;
}

/**
 * Makes the layout fit a body this wide. Desktop: closes panels, in
 * CLOSE_ORDER and never `keep`, until the viewport has MIN_VIEWPORT_WIDTH;
 * if `keep` alone is still too wide it narrows (down to its minimum).
 * Compact: at most one side panel open - `keep` if it is one of them.
 * Returns the same object when nothing needed to change.
 */
export function fitToWidth(layout: WorkspaceLayout, bodyWidth: number, windowWidth: number, keep?: PanelId): WorkspaceLayout {
  let next = layout;
  const close = (panel: SidePanelId): void => {
    next = { ...next, [panel]: { ...next[panel], open: false } };
  };
  if (isCompact(windowWidth)) {
    const open = CLOSE_ORDER.filter((panel) => next[panel].open);
    const winner = keep && (CLOSE_ORDER as readonly PanelId[]).includes(keep) && next[keep as SidePanelId].open ? (keep as SidePanelId) : open[open.length - 1];
    for (const panel of open) if (panel !== winner) close(panel);
    return next;
  }
  for (const panel of CLOSE_ORDER) {
    if (viewportWidth(next, bodyWidth) >= MIN_VIEWPORT_WIDTH) break;
    if (panel !== keep && next[panel].open) close(panel);
  }
  const shortBy = MIN_VIEWPORT_WIDTH - viewportWidth(next, bodyWidth);
  if (shortBy > 0 && keep && (CLOSE_ORDER as readonly PanelId[]).includes(keep) && next[keep as SidePanelId].open) {
    const panel = keep as SidePanelId;
    const width = clampWidth(panel, next[panel].width - shortBy);
    if (width !== next[panel].width) next = { ...next, [panel]: { ...next[panel], width } };
  }
  return next;
}

/** A saved layout read back field by field - anything missing or odd keeps the fallback's value. */
export function parseLayout(raw: unknown, fallback: WorkspaceLayout): WorkspaceLayout {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const part = (key: string): Record<string, unknown> => {
    const value = source[key];
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  };
  const flag = (value: unknown, otherwise: boolean): boolean => (typeof value === "boolean" ? value : otherwise);
  const width = (panel: SidePanelId): number => {
    const value = part(panel).width;
    return typeof value === "number" && Number.isFinite(value) ? clampWidth(panel, value) : fallback[panel].width;
  };
  const dock = part("dock");
  const height = typeof dock.height === "number" && Number.isFinite(dock.height) ? Math.max(DOCK_HEIGHT.min, Math.round(dock.height)) : fallback.dock.height;
  const tab = typeof dock.tab === "string" && (DOCK_TABS as readonly string[]).includes(dock.tab) ? dock.tab : fallback.dock.tab;
  return {
    left: { open: flag(part("left").open, fallback.left.open), width: width("left") },
    right: { open: flag(part("right").open, fallback.right.open), width: width("right") },
    assistant: { open: flag(part("assistant").open, fallback.assistant.open), width: width("assistant") },
    dock: { open: flag(dock.open, fallback.dock.open), height, tab },
    ribbon: { open: flag(part("ribbon").open, fallback.ribbon.open) }
  };
}

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LayoutStore {
  get(): WorkspaceLayout;
  /** Calls `listener` now and on every change; returns an unsubscribe. */
  subscribe(listener: (layout: WorkspaceLayout) => void): () => void;
  setOpen(panel: PanelId, open: boolean): void;
  toggle(panel: PanelId): void;
  /** A side panel's width, or the dock's height (clamped later, by fit and render). */
  setSize(panel: "left" | "right" | "assistant" | "dock", size: number): void;
  setDockTab(tab: string): void;
  /** Re-fits the open panels to a body this wide (call on window resize). */
  fit(bodyWidth: number): void;
}

/**
 * The layout as live state. `measure` reports the window's width and the
 * body's - layout.ts reads them from the DOM, verify.ts passes numbers.
 * Opening a panel fits the others around it - and closing it brings back
 * the ones it pushed out, if they still fit. A panel the person opens or
 * closes themself is theirs: it is no longer waiting to come back. Every
 * change is saved.
 */
export function createLayoutStore(storage: LayoutStorage | null, measure: () => { windowWidth: number; bodyWidth: number }): LayoutStore {
  const { windowWidth } = measure();
  const fallback = defaultLayout(windowWidth);
  let saved: unknown = null;
  try {
    const text = storage?.getItem(LAYOUT_STORAGE_KEY);
    saved = text ? JSON.parse(text) : null;
  } catch {
    saved = null;
  }
  let layout = saved ? parseLayout(saved, fallback) : fallback;
  const listeners = new Set<(layout: WorkspaceLayout) => void>();
  /** Side panels closed to make room for another (desktop only) - by the panel that pushed them out. */
  const displaced = new Map<PanelId, SidePanelId[]>();

  const commit = (next: WorkspaceLayout, keep?: PanelId): void => {
    const size = measure();
    const fitted = fitToWidth(next, size.bodyWidth, size.windowWidth, keep);
    if (keep && !isCompact(size.windowWidth)) {
      const pushedOut = CLOSE_ORDER.filter((panel) => panel !== keep && next[panel].open && !fitted[panel].open);
      if (pushedOut.length > 0) displaced.set(keep, [...new Set([...(displaced.get(keep) ?? []), ...pushedOut])]);
    }
    if (fitted === layout) return;
    layout = fitted;
    try {
      storage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Storage refused (a privacy mode): the layout still works for this page.
    }
    for (const listener of listeners) listener(layout);
  };
  // A saved layout from a wider window may not fit this one.
  layout = fitToWidth(layout, measure().bodyWidth, windowWidth);

  const setOpen = (panel: PanelId, open: boolean): void => {
    if (layout[panel].open === open) return;
    // The person decides this one now: it no longer waits to come back.
    for (const [owner, panels] of displaced) {
      const rest = panels.filter((entry) => entry !== panel);
      if (rest.length > 0) displaced.set(owner, rest);
      else displaced.delete(owner);
    }
    if (open) {
      commit({ ...layout, [panel]: { ...layout[panel], open: true } }, panel);
      return;
    }
    // Closing: on a desktop window the panels this one pushed out come back (the fit closes them again if they no
    // longer fit); on a compact one an overlay never opens by itself.
    let next: WorkspaceLayout = { ...layout, [panel]: { ...layout[panel], open: false } };
    if (!isCompact(measure().windowWidth)) {
      for (const back of displaced.get(panel) ?? []) next = { ...next, [back]: { ...next[back], open: true } };
    }
    displaced.delete(panel);
    commit(next);
  };

  return {
    get: () => layout,
    subscribe(listener) {
      listeners.add(listener);
      listener(layout);
      return () => listeners.delete(listener);
    },
    setOpen,
    toggle: (panel) => setOpen(panel, !layout[panel].open),
    setSize(panel, size) {
      if (panel === "dock") {
        const height = Math.max(DOCK_HEIGHT.min, Math.round(size));
        if (height !== layout.dock.height) commit({ ...layout, dock: { ...layout.dock, height } }, "dock");
        return;
      }
      let width = clampWidth(panel, size);
      const { bodyWidth, windowWidth: currentWindow } = measure();
      if (!isCompact(currentWindow) && layout[panel].open) {
        // A drag stops where the viewport would get too narrow - it never closes another panel.
        const room = viewportWidth(layout, bodyWidth) - MIN_VIEWPORT_WIDTH;
        width = Math.max(Math.min(width, layout[panel].width + Math.max(0, room)), Math.min(layout[panel].width, width));
      }
      if (width !== layout[panel].width) commit({ ...layout, [panel]: { ...layout[panel], width } }, panel);
    },
    setDockTab(tab) {
      if (tab !== layout.dock.tab && (DOCK_TABS as readonly string[]).includes(tab)) commit({ ...layout, dock: { ...layout.dock, tab } });
    },
    fit(bodyWidth) {
      const next = fitToWidth(layout, bodyWidth, measure().windowWidth);
      if (next !== layout) commit(next);
    }
  };
}
