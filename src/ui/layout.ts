import { el } from "./dom";
import { createHeader } from "./header";
import { createLeftSidebar } from "./leftSidebar";
import { createRightSidebar } from "./rightSidebar";
import { createCommandBar } from "./commandBar";
import type { ViewPreset } from "./viewControls";

export type AppShellOptions = {
  projectName: string;
  onViewChange: (preset: ViewPreset) => void;
};

export type AppShell = {
  /** Root element to mount into #app. */
  root: HTMLElement;
  /** Empty container the 3D renderer should be mounted into. */
  viewportContainer: HTMLElement;
};

/**
 * Builds the full CAD-style application shell (header, sidebars,
 * viewport area, command bar) and returns it along with an empty
 * container for the Three.js renderer. Contains no Three.js code -
 * SceneManager is mounted into `viewportContainer` from main.ts.
 */
export function createAppShell(options: AppShellOptions): AppShell {
  const header = createHeader({ projectName: options.projectName, onViewChange: options.onViewChange });
  const leftSidebar = createLeftSidebar();
  const rightSidebar = createRightSidebar();
  const commandBar = createCommandBar();

  const viewportContainer = el("div", { className: "viewport-container" });
  const viewportArea = el("main", { className: "viewport-area" }, [viewportContainer]);

  const body = el("div", { className: "app-body" }, [leftSidebar, viewportArea, rightSidebar]);

  const root = el("div", { className: "app-shell" }, [header, body, commandBar]);

  return { root, viewportContainer };
}
