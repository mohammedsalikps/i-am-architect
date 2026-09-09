import { el } from "./dom";

const NAV_SECTIONS = ["Project", "Building", "Floors", "Rooms", "Objects"];

/**
 * Left sidebar: project navigation plus a placeholder scene hierarchy.
 * No construction data yet - this is structural scaffolding only.
 */
export function createLeftSidebar(): HTMLElement {
  const nav = el(
    "nav",
    { className: "sidebar__nav" },
    NAV_SECTIONS.map((label) => el("button", { className: "sidebar__nav-item", text: label, attrs: { type: "button" } }))
  );

  const hierarchy = el("div", { className: "sidebar__section" }, [
    el("h3", { className: "sidebar__section-title", text: "Hierarchy" }),
    el("p", { className: "sidebar__placeholder", text: "No objects in the scene yet." })
  ]);

  return el("aside", { className: "sidebar sidebar--left" }, [nav, hierarchy]);
}
