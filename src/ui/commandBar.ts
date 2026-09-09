import { el } from "./dom";
import { createTabStrip, comingSoon } from "./tabStrip";
import { AiPromptController } from "../engine/ai/AiPromptController";
import type { AiInstructionSubmitter, AiPromptState } from "../engine/ai/AiPromptController";

/**
 * Renders one AiPromptState onto the tab's DOM - the only place this
 * file touches the DOM based on AI state. `controller` (see
 * AiPromptController.ts) owns every actual decision (what the status
 * is, what message/notes to show, whether a submission is already in
 * flight); this function only translates that decision into
 * attributes/text/class names. No store, CommandExecutor, or
 * AICommandPipeline reference exists anywhere in this file - the only
 * thing a click or Enter keypress ever does is call
 * `controller.submit(instruction)`, which itself only ever calls the
 * injected `onSubmitAiInstruction` function (in the running app,
 * AIService.submit - see main.ts).
 */
function renderAiPromptState(
  state: AiPromptState,
  input: HTMLInputElement,
  button: HTMLButtonElement,
  status: HTMLElement
): void {
  const busy = state.status === "submitting";
  input.disabled = busy;
  button.disabled = busy;
  button.textContent = busy ? "Building…" : "AI Build";

  status.classList.remove("command-bar__note--error", "command-bar__note--success");
  if (state.status === "error") {
    status.classList.add("command-bar__note--error");
  } else if (state.status === "success") {
    status.classList.add("command-bar__note--success");
  }

  const parts: string[] = [];
  if (busy) {
    parts.push("Working…");
  } else if (state.message) {
    parts.push(state.message);
  } else {
    parts.push("Describe a wall, pillar, beam, slab, door, or window to build it.");
  }
  if (state.notes) {
    parts.push(`Note: ${state.notes}`);
  }
  status.textContent = parts.join(" ");
}

function buildAiPromptTab(onSubmitAiInstruction: AiInstructionSubmitter): HTMLElement {
  const input = el("input", {
    className: "command-bar__input",
    attrs: { type: "text", placeholder: "Describe what you want to build..." }
  });

  const aiButton = el("button", {
    className: "command-bar__ai-button",
    text: "AI Build",
    attrs: { type: "button" }
  });

  const status = el("span", { className: "command-bar__note" });

  // AiPromptController is DOM-free (see its own docs) - it owns the
  // idle/submitting/success/error state machine and the
  // "prevent duplicate submissions while a request is running" guard.
  // This tab only ever calls `.submit()` and renders whatever state it
  // reports back via `.subscribe()`.
  const controller = new AiPromptController(onSubmitAiInstruction);
  controller.subscribe((state) => renderAiPromptState(state, input, aiButton, status));

  function submit(): void {
    // controller.submit() already no-ops while a submission is in
    // flight (see AiPromptController.submit) - no need to duplicate
    // that guard here. Deliberately not `await`ed: this is a DOM event
    // handler, and the controller's own subscription is what drives the
    // UI update once the (async) submission settles.
    void controller.submit(input.value);
  }

  aiButton.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });

  return el("div", { className: "command-bar__row" }, [input, aiButton, status]);
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
 * Quotation / Design Review. AI Prompt sends the typed instruction
 * through `onSubmitAiInstruction` (in the running app, `AIService.submit`
 * - constructed once in main.ts from the shared CommandExecutor and a
 * BackendAIProvider - see main.ts and ai/README.md "Where
 * AICommandPipeline can be constructed safely") and renders the result
 * via AiPromptController - see buildAiPromptTab() above. Manual Build
 * hosts the Add Wall action relocated from the old header.
 * Measurements/Quotation/Design Review are "Coming soon" - out of scope
 * for this milestone.
 */
export function createCommandBar(onAddWall: () => void, onSubmitAiInstruction: AiInstructionSubmitter): HTMLElement {
  const { strip, panel } = createTabStrip(
    [
      { id: "ai-prompt", label: "AI Prompt", build: () => buildAiPromptTab(onSubmitAiInstruction) },
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
