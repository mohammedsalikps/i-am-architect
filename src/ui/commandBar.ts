import { el } from "./dom";

/**
 * Bottom command bar. This is where AI prompt-to-build will live in
 * a later milestone - for now the input and button are visual only.
 */
export function createCommandBar(): HTMLElement {
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

  return el("footer", { className: "command-bar" }, [input, aiButton, note]);
}
