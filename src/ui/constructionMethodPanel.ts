import { el } from "./dom";
import { generateConstructionSequence } from "../engine/construction/generateConstructionSequence.ts";
import type { ConstructionSequence } from "../engine/construction/types.ts";
import type { AIContextObject } from "../engine/ai/types.ts";

/** What clicking a step (or Previous/Next/Show All) does to the 3D viewport - SceneManager.highlightConstructionObjects(). `null` restores every object's real material color. */
export type HighlightConstructionObjects = (objectIds: readonly string[] | null) => { resolved: number; unresolved: number };

export interface ConstructionMethodPanel {
  element: HTMLElement;
  /** Clears any active step highlight in the viewport - called when the user switches away from this tab (task section 6: "restore normal appearance when...the Construction Method view is closed"). */
  clearHighlight: () => void;
}

/**
 * "Construction Method" - a dedicated, professional workflow surface
 * (task section 5) turning the deterministic ConstructionSequence
 * (generateConstructionSequence.ts) into: a Generate action, a numbered
 * step list, the selected step's description/components/linked-object
 * count, Previous/Next navigation with "Step X / N", and Show All. Pure
 * presentation of data the generator already computed from real project
 * objects - this module invents nothing of its own.
 */
export function buildConstructionMethodTab(getObjects: () => readonly AIContextObject[], getProjectId: () => string | null, highlight: HighlightConstructionObjects): ConstructionMethodPanel {
  let sequence: ConstructionSequence | null = null;
  let activeIndex = 0;

  const generateButton = el("button", {
    className: "toolbar-button toolbar-button--primary",
    text: "Generate Construction Sequence",
    attrs: { type: "button" }
  });
  const note = el("span", {
    className: "command-bar__note",
    text: "Builds a step-by-step construction sequence from the objects currently in this project - a planning visualization, not an engineering or cost estimate."
  });

  const stepIndicator = el("span", { className: "construction-method__step-indicator" });
  const prevButton = el("button", { className: "toolbar-button", text: "Previous", attrs: { type: "button" } });
  const nextButton = el("button", { className: "toolbar-button", text: "Next", attrs: { type: "button" } });
  const showAllButton = el("button", { className: "toolbar-button", text: "Show All", attrs: { type: "button" } });
  const nav = el("div", { className: "construction-method__nav" }, [prevButton, stepIndicator, nextButton, showAllButton]);
  const unresolvedNote = el("p", { className: "construction-method__unresolved" });

  const stepList = el("div", { className: "construction-method__list" });
  const detail = el("div", { className: "construction-method__detail" });
  const body = el("div", { className: "construction-method__body" }, [stepList, detail]);

  const root = el("div", { className: "command-bar__column construction-method" }, [
    el("div", { className: "command-bar__row" }, [generateButton, note]),
    nav,
    unresolvedNote,
    body
  ]);

  function applyHighlightForActiveStep(): void {
    if (!sequence || sequence.steps.length === 0) {
      unresolvedNote.hidden = true;
      return;
    }
    const step = sequence.steps[activeIndex];
    const result = highlight(step.objectIds);
    unresolvedNote.hidden = result.unresolved === 0;
    unresolvedNote.textContent = result.unresolved > 0 ? `${result.unresolved} linked object(s) from this step could not be found in the current model.` : "";
  }

  function renderStepList(): void {
    stepList.replaceChildren(
      ...(sequence?.steps ?? []).map((step, index) => {
        const button = el(
          "button",
          {
            className: `construction-method__step${index === activeIndex ? " construction-method__step--active" : ""}`,
            attrs: { type: "button" }
          },
          [
            el("span", { className: "construction-method__step-number", text: String(step.order).padStart(2, "0") }),
            el("span", { className: "construction-method__step-title", text: step.title })
          ]
        );
        button.addEventListener("click", () => {
          activeIndex = index;
          render();
          applyHighlightForActiveStep();
        });
        return button;
      })
    );
  }

  function renderDetail(): void {
    if (!sequence || sequence.steps.length === 0) {
      detail.replaceChildren();
      return;
    }
    const step = sequence.steps[activeIndex];
    detail.replaceChildren(
      el("h3", { className: "construction-method__detail-title", text: `${String(step.order).padStart(2, "0")} ${step.title}` }),
      el("p", { className: "construction-method__detail-description", text: step.description }),
      el("p", { className: "construction-method__detail-meta", text: `${step.objectIds.length} linked object${step.objectIds.length === 1 ? "" : "s"}` }),
      el(
        "div",
        { className: "construction-method__components" },
        step.requiredComponents.map((requiredComponent) =>
          el("div", { className: "construction-method__component" }, [
            el("span", { className: "construction-method__component-name", text: requiredComponent.name }),
            el("span", { className: "construction-method__component-quantity", text: `${requiredComponent.quantity} ${requiredComponent.unit}` })
          ])
        )
      )
    );
  }

  function render(): void {
    const hasSteps = !!sequence && sequence.steps.length > 0;
    nav.hidden = !hasSteps;
    if (hasSteps) {
      stepIndicator.textContent = `Step ${activeIndex + 1} / ${sequence!.steps.length}`;
      prevButton.toggleAttribute("disabled", activeIndex === 0);
      nextButton.toggleAttribute("disabled", activeIndex === sequence!.steps.length - 1);
    }
    renderStepList();
    renderDetail();
    if (sequence && sequence.steps.length === 0) {
      stepList.replaceChildren(el("p", { className: "command-bar__note", text: "This project has no construction elements yet - add walls, structure, or other objects, then generate again." }));
    } else if (!sequence) {
      stepList.replaceChildren(el("p", { className: "command-bar__note", text: "Not generated yet." }));
    }
  }

  generateButton.addEventListener("click", () => {
    sequence = generateConstructionSequence(getObjects(), { projectId: getProjectId() });
    activeIndex = 0;
    render();
    applyHighlightForActiveStep();
  });
  prevButton.addEventListener("click", () => {
    if (sequence && activeIndex > 0) {
      activeIndex -= 1;
      render();
      applyHighlightForActiveStep();
    }
  });
  nextButton.addEventListener("click", () => {
    if (sequence && activeIndex < sequence.steps.length - 1) {
      activeIndex += 1;
      render();
      applyHighlightForActiveStep();
    }
  });
  showAllButton.addEventListener("click", () => {
    highlight(null);
  });

  unresolvedNote.hidden = true;
  render();

  return {
    element: root,
    clearHighlight: () => highlight(null)
  };
}
