import { el } from "./dom";
import { createTabStrip, comingSoon } from "./tabStrip";

function buildAiPromptTab(): HTMLElement {
  const input = el("input", {
    className: "command-bar__input",
    attrs: {
      type: "text",
      placeholder: "Describe what you want to build...",
      disabled: "true"
    }
  });

  const aiButton = el("button", {
    className: "command-bar__ai-button",
    text: "AI Build",
    attrs: { type: "button", disabled: "true" }
  });

  const note = el("span", {
    className: "command-bar__note",
    text: "AI-assisted construction is coming in a future milestone."
  });

  return el("div", { className: "command-bar__row" }, [input, aiButton, note]);
}

function buildManualBuildTab(onAddWall: () => void): HTMLElement {
  const addWallButton = el("button", {
    className: "toolbar-button toolbar-button--primary",
    text: "Add Wall",
    attrs: { type: "button" }
  });
  addWallButton.addEventListener("click", onAddWall);

  const note = el("span", {
    className: "command-bar__note",
    text: "Places a new wall on the grid. Select it in the viewport to edit its properties."
  });

  return el("div", { className: "command-bar__row" }, [addWallButton, note]);
}

/**
 * Bottom workspace: tabbed AI Prompt / Manual Build / Measurements /
 * Quotation / Design Review. AI Prompt is the original command input +
 * AI Build button (still visual-only, unchanged). Manual Build hosts
 * the Add Wall action relocated from the old header. Measurements/
 * Quotation/Design Review are "Coming soon" - out of scope for this
 * UI-focused milestone.
 */
export function createCommandBar(onAddWall: () => void): HTMLElement {
  const { strip, panel } = createTabStrip(
    [
      { id: "ai-prompt", label: "AI Prompt", build: buildAiPromptTab },
      { id: "manual-build", label: "Manual Build", build: () => buildManualBuildTab(onAddWall) },
      { id: "measurements", label: "Measurements", build: () => comingSoon("Measurements"), disabled: true },
      { id: "quotation", label: "Quotation", build: () => comingSoon("Quotation"), disabled: true },
      { id: "design-review", label: "Design Review", build: () => comingSoon("Design review"), disabled: true }
    ],
    "command-bar__tabs",
    "command-bar__tab"
  );

  return el("footer", { className: "command-bar" }, [strip, panel]);
}
