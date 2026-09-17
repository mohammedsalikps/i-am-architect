import { el } from "./dom";
import { createTabStrip, comingSoon } from "./tabStrip";
import { AiPromptController, isAiPromptSubmitKey } from "../engine/ai/AiPromptController";
import type { AiBuildSummary, AiInstructionSubmitter, AiPromptState } from "../engine/ai/AiPromptController";
import type { HouseDesignSummary } from "../engine/ai/houseDesign.ts";

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "7" stays "7", "7.5" stays "7.5" - a plain, minimal-decimal meters format for a footprint dimension (never invented precision beyond what the design actually used). */
function formatMetersValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** Counts room labels matching `pattern` - e.g. "Bedroom 2" and "Bathroom" from HouseDesignSummary.rooms, the same real, generator-authored labels summarizeHouseDesign() already renders as prose. Never a guess: a label either matches or it doesn't. */
function countRoomsMatching(rooms: readonly string[], pattern: RegExp): number {
  return rooms.filter((room) => pattern.test(room)).length;
}

export interface AiResultActions {
  onFocusBuilding: () => void;
  onReviewChanges: () => void;
  /** The same undo the top toolbar's own Undo button already runs (HistoryManager.undo()) - not a second, scoped-to-this-response undo. */
  onUndo: () => void;
  /** The same save the top toolbar's own Save button already runs - prompts to sign in first when signed out, exactly as it already does there. */
  onSave: () => void;
}

/**
 * "EAVARA AI - Design generated" (task: the AI should feel like an
 * architectural assistant reporting a real result, not a bare "prompt ->
 * command executed" line). Purely a presentation of data that already
 * exists:
 *
 * - `houseSummary` (AIPipelineResult.houseSummary, present only for a
 *   recognized whole-house request - see houseDesign.ts) drives the
 *   structured footprint/bedroom/bathroom/room/element-count stats;
 *   bedroom and bathroom counts come from matching the design's own real
 *   room labels ("Bedroom 2", "Bathroom") - never invented, and simply
 *   absent from the list when a design has none (e.g. a single room).
 * - Every other successful response (a single wall, an edit) falls back
 *   to the existing generic "N objects created - ..." breakdown
 *   (AiPromptController.summarizeCreatedObjects) - nothing here invents
 *   architectural detail a plain construction command doesn't have.
 *
 * All four actions call real, already-existing behavior
 * (SceneManager.focusOn/SelectionStore.select/HistoryManager.undo/
 * ProjectPersistenceController.save) - no action is shown that doesn't
 * actually do something.
 */
function buildAiResultCard(summary: AiBuildSummary, notes: string | null, houseSummary: HouseDesignSummary | null, actions: AiResultActions): HTMLElement {
  const eyebrow = el("p", { className: "ai-result__eyebrow", text: "EAVARA AI" });
  const heading = el("p", { className: "ai-result__heading", text: houseSummary ? "Design generated" : "Build complete" });
  const children: HTMLElement[] = [eyebrow, heading];

  if (houseSummary) {
    const { footprint, rooms } = houseSummary;
    const bedrooms = countRoomsMatching(rooms, /bedroom/i);
    const bathrooms = countRoomsMatching(rooms, /bathroom/i);
    const stats: { label: string; value: string }[] = [
      { label: "Footprint", value: `${formatMetersValue(footprint.length)}m × ${formatMetersValue(footprint.width)}m` },
      ...(bedrooms > 0 ? [{ label: bedrooms === 1 ? "Bedroom" : "Bedrooms", value: String(bedrooms) }] : []),
      ...(bathrooms > 0 ? [{ label: bathrooms === 1 ? "Bathroom" : "Bathrooms", value: String(bathrooms) }] : []),
      { label: "Rooms", value: String(rooms.length) },
      { label: "Construction elements", value: String(summary.total) }
    ];
    children.push(
      el(
        "div",
        { className: "ai-result__stats" },
        stats.map((stat) =>
          el("div", { className: "ai-result__stat" }, [
            el("span", { className: "ai-result__stat-value", text: stat.value }),
            el("span", { className: "ai-result__stat-label", text: stat.label })
          ])
        )
      )
    );
  } else {
    // A house-design response's own summarizeHouseDesign() prose reaches
    // here as `notes` too, but houseSummary being set already gave it
    // the structured card above - this branch only ever shows notes for
    // a NON-house response (an ordinary provider-mapped instruction).
    if (notes) {
      children.push(el("p", { className: "ai-result__line ai-result__line--notes", text: notes }));
    }
    children.push(
      el("p", {
        className: "ai-result__line",
        text: `${pluralize(summary.total, "object")} created — ${summary.byType.map((entry) => `${entry.count} ${entry.label}`).join(", ")}`
      })
    );
  }

  const focusButton = el("button", {
    className: "toolbar-button toolbar-button--primary ai-result__action",
    text: "View",
    attrs: { type: "button", title: "Frame everything this response just created" }
  });
  focusButton.addEventListener("click", actions.onFocusBuilding);
  const reviewButton = el("button", {
    className: "toolbar-button ai-result__action",
    text: "Modify",
    attrs: { type: "button", title: "Select the first object this response created, and open its properties" }
  });
  reviewButton.addEventListener("click", actions.onReviewChanges);
  const undoButton = el("button", {
    className: "toolbar-button ai-result__action",
    text: "Undo",
    attrs: { type: "button", title: "Undo this generation" }
  });
  undoButton.addEventListener("click", actions.onUndo);
  const saveButton = el("button", {
    className: "toolbar-button ai-result__action",
    text: "Save",
    attrs: { type: "button", title: "Save the project" }
  });
  saveButton.addEventListener("click", actions.onSave);
  children.push(el("div", { className: "ai-result__actions" }, [focusButton, reviewButton, undoButton, saveButton]));
  return el("div", { className: "ai-result" }, children);
}

/**
 * "AI Could Not Complete Request" - the failure counterpart to
 * buildAiResultCard(), same visual weight so an error doesn't read as
 * "quieter" than success. `message` is always the pre-filtered, normal-
 * user-safe text (see AiPromptController.friendlyAiErrorMessage) -
 * `details`, when present, is the original technical message (a raw
 * fetch failure, HTTP status, or provider exception string), tucked
 * behind an opt-in "Show details" toggle rather than shown by default.
 */
function buildAiErrorCard(message: string, details: string | null): HTMLElement {
  const heading = el("p", { className: "ai-result__heading ai-result__heading--error", text: "AI Could Not Complete Request" });
  const line = el("p", { className: "ai-result__line", text: message });
  const children: HTMLElement[] = [heading, line];
  if (details) {
    const detailsText = el("pre", { className: "ai-result__details" });
    detailsText.hidden = true;
    detailsText.textContent = details;
    const toggle = el("button", { className: "ai-result__details-toggle", text: "Show details", attrs: { type: "button" } });
    toggle.addEventListener("click", () => {
      detailsText.hidden = !detailsText.hidden;
      toggle.textContent = detailsText.hidden ? "Show details" : "Hide details";
    });
    children.push(toggle, detailsText);
  }
  return el("div", { className: "ai-result ai-result--error" }, children);
}

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
  status: HTMLElement,
  hasCard: boolean
): void {
  const busy = state.status === "submitting";
  input.disabled = busy;
  button.disabled = busy;
  button.textContent = busy ? "Designing…" : "Generate Design";

  status.classList.remove("command-bar__note--error", "command-bar__note--success");
  if (state.status === "success") {
    status.classList.add("command-bar__note--success");
  }

  // The result itself (success or failure) is shown as its own card
  // (buildAiResultCard/buildAiErrorCard, below) with equal visual
  // weight - this line stays a short, single-purpose status: what's
  // happening right now (or the prompt's placeholder hint). Notes are
  // shown here only when there's no card to carry them (an edit-only
  // response has a summary of nothing to show) - never duplicated.
  const parts: string[] = [];
  if (busy) {
    parts.push("Designing…");
  } else if (state.status === "idle") {
    parts.push("Describe a wall, a room, or a whole house to build it.");
  }
  if (state.notes && !hasCard) {
    parts.push(`Note: ${state.notes}`);
  }
  status.textContent = parts.join(" ");
}

export interface AiPromptTab {
  element: HTMLElement;
  /** Moves focus to the instruction input - used by the viewport empty-state's "Ask AI to Design" action (see ui/layout.ts). */
  focusInput(): void;
}

/**
 * Example instructions shown only while the input is empty and idle
 * (task section 20: "only display examples for capabilities that are
 * actually supported") - each one names a request path this build
 * genuinely handles: the deterministic house planner (the first two -
 * see houseIntent.ts/houseDesign.ts, untouched by this milestone), an
 * ordinary single-object construction command, a hosted-opening edit,
 * and asset.add furniture placement (see engine/ai/providers/
 * promptSchema.ts's assetPromptLines()). Clicking one fills the input
 * for the user to review and submit - it never submits on its own, so
 * browsing examples never spends an AI call or changes the project by
 * itself.
 */
const AI_EXAMPLES: readonly string[] = [
  "Build a 10m × 8m house with 3 bedrooms",
  "Create a small 2-bedroom house",
  "Add a wall 5m long",
  "Add a window to the selected wall",
  "Furnish the living room"
];

function buildAiPromptTab(
  onSubmitAiInstruction: AiInstructionSubmitter,
  onFocusCreated: (objectIds: string[]) => void,
  onSelectObject: (objectId: string) => void,
  onUndo: () => void,
  onSaveProject: () => void
): AiPromptTab {
  const input = el("input", {
    className: "command-bar__input",
    attrs: { type: "text", placeholder: "Describe what you want to design..." }
  });

  const aiButton = el("button", {
    className: "command-bar__ai-button",
    text: "Generate Design",
    attrs: { type: "button" }
  });

  const status = el("span", { className: "command-bar__note" });
  const resultContainer = el("div", { className: "ai-result-container" });

  const examples = el(
    "div",
    { className: "ai-panel__examples" },
    AI_EXAMPLES.map((example) => {
      const chip = el("button", {
        className: "ai-panel__example",
        text: example,
        attrs: { type: "button", title: "Use this example - review it, then Generate Design" }
      });
      chip.addEventListener("click", () => {
        input.value = example;
        input.focus();
        updateExamplesVisibility();
      });
      return chip;
    })
  );
  // Examples are a starting point, not a permanent fixture - once the
  // user has typed something, or the panel has ever shown a real result,
  // they'd only be clutter alongside it.
  const updateExamplesVisibility = (): void => {
    examples.hidden = input.value.trim().length > 0 || resultContainer.childElementCount > 0;
  };
  input.addEventListener("input", updateExamplesVisibility);

  // AiPromptController is DOM-free (see its own docs) - it owns the
  // idle/submitting/success/error state machine, the "prevent duplicate
  // submissions" guard, and what a response actually created (summary).
  // This tab only ever calls `.submit()` and renders whatever state it
  // reports back via `.subscribe()` - `onFocusCreated` is threaded
  // straight through to it as `onCreated`, so the viewport frames a
  // successful build automatically (task: "VIEWPORT: displays the
  // building"), not only when the result card's own button is clicked.
  const controller = new AiPromptController(onSubmitAiInstruction, onFocusCreated);
  controller.subscribe((state) => {
    const summary = state.status === "success" ? state.summary : null;
    const card = summary
      ? buildAiResultCard(summary, state.notes, state.houseSummary, {
          onFocusBuilding: () => onFocusCreated(summary.objectIds),
          onReviewChanges: () => {
            const firstId = summary.objectIds[0];
            if (firstId) {
              onSelectObject(firstId);
            }
          },
          onUndo,
          onSave: onSaveProject
        })
      : state.status === "error" && state.message
        ? buildAiErrorCard(state.message, state.details)
        : null;
    resultContainer.replaceChildren(...(card ? [card] : []));
    renderAiPromptState(state, input, aiButton, status, card !== null);
    updateExamplesVisibility();
  });

  function submit(): void {
    // Disabling the input during the submitting state (see
    // renderAiPromptState) drops its keyboard focus, and re-enabling it
    // does not bring focus back - so after an Enter submission, a second
    // Enter or any typing went nowhere until the user clicked back in.
    // Remember whether the input had focus when this submission began,
    // and hand focus back once it settles - unless the user has
    // deliberately moved focus somewhere else in the meantime.
    const restoreFocus = document.activeElement === input;

    // controller.submit() already no-ops while a submission is in
    // flight (see AiPromptController.submit) - no need to duplicate
    // that guard here. Not `await`ed: this is a DOM event handler, and
    // the controller's own subscription drives the UI update once the
    // (async) submission settles. That render re-enables the input
    // before this `.then()` runs, so focus() lands on an enabled input.
    void controller.submit(input.value).then(() => {
      const focusIsUnclaimed = document.activeElement === null || document.activeElement === document.body;
      if (restoreFocus && focusIsUnclaimed) {
        input.focus();
      }
    });
  }

  aiButton.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (isAiPromptSubmitKey(event)) {
      event.preventDefault();
      submit();
    }
  });

  const header = el("div", { className: "ai-panel__header" }, [
    el("span", { className: "ai-panel__mark", text: "✦", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "ai-panel__title", text: "EAVARA AI" })
  ]);

  const element = el("div", { className: "command-bar__column ai-panel" }, [
    header,
    el("div", { className: "command-bar__row" }, [input, aiButton]),
    examples,
    status,
    resultContainer
  ]);
  return { element, focusInput: () => input.focus() };
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
export interface CommandBar {
  element: HTMLElement;
  /** Switches to the AI Prompt tab and focuses its input - the viewport empty-state's "Ask AI to Design" action (see ui/layout.ts). */
  focusAiInput(): void;
}

export function createCommandBar(
  onAddWall: () => void,
  onSubmitAiInstruction: AiInstructionSubmitter,
  onFocusCreated: (objectIds: string[]) => void,
  onSelectObject: (objectId: string) => void,
  onUndo: () => void,
  onSaveProject: () => void
): CommandBar {
  // Built up front (not lazily inside the tab strip's own build()) so
  // its `focusInput()` is available regardless of which tab is active -
  // AI Prompt is the tab strip's first, non-disabled tab, so it's
  // already the active one on load; this only matters once the user has
  // switched away and back.
  const aiPromptTab = buildAiPromptTab(onSubmitAiInstruction, onFocusCreated, onSelectObject, onUndo, onSaveProject);

  const { strip, panel, activate } = createTabStrip(
    [
      { id: "ai-prompt", label: "AI Prompt", build: () => aiPromptTab.element },
      { id: "manual-build", label: "Manual Build", build: () => buildManualBuildTab(onAddWall) },
      { id: "measurements", label: "Measurements", build: () => comingSoon("Measurements"), disabled: true },
      { id: "quotation", label: "Quotation", build: () => comingSoon("Quotation"), disabled: true },
      { id: "design-review", label: "Design Review", build: () => comingSoon("Design review"), disabled: true }
    ],
    "command-bar__tabs",
    "command-bar__tab"
  );

  const element = el("footer", { className: "command-bar" }, [strip, panel]);
  return {
    element,
    focusAiInput: () => {
      activate("ai-prompt");
      aiPromptTab.focusInput();
    }
  };
}
