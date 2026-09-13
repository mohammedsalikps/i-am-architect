import { el } from "./dom";
import type { RibbonTab, RibbonTool } from "./ribbonTabs";

export interface ConstructionRibbon {
  element: HTMLElement;
  /** Shows a tab's tools - called by the main nav. */
  show(tabId: string): void;
  /** Re-checks which tools are usable right now (e.g. Paint needs a selection). */
  refresh(): void;
}

/**
 * The construction ribbon: the active tab's tools, in labelled groups -
 * see ribbonTabs.ts for which tools each tab holds. Every button runs a
 * real tool; one that needs something first (Paint needs a selected wall
 * or element) is disabled with a tooltip saying why, and re-enabled by
 * refresh(). Nothing here is a placeholder.
 */
export function createConstructionRibbon(tabs: readonly RibbonTab[], initialTabId: string): ConstructionRibbon {
  const element = el("div", { className: "app-ribbon", attrs: { role: "toolbar" } });
  let current = tabs.find((tab) => tab.id === initialTabId) ?? tabs[0];
  let rendered: { tool: RibbonTool; button: HTMLButtonElement }[] = [];
  // A picked color survives switching tabs and back.
  const colorValues = new Map<string, string>();

  const refresh = (): void => {
    for (const { tool, button } of rendered) {
      const enabled = tool.isEnabled ? tool.isEnabled() : true;
      button.disabled = !enabled;
      const title = enabled || !tool.disabledTitle ? tool.title : tool.disabledTitle;
      button.title = title;
      button.setAttribute("aria-label", title);
      const active = tool.isActive ? tool.isActive() : false;
      button.classList.toggle("app-ribbon__item--active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  };

  const renderTool = (tool: RibbonTool): HTMLElement[] => {
    // tool.icon is either real SVG markup (constructionIconSvg()) or a
    // plain 1-2 letter iconFor() fallback - innerHTML renders both
    // correctly (plain text with no markup characters displays exactly
    // as textContent would), so every tool goes through the same path.
    const icon = el("span", { className: "app-ribbon__icon" });
    icon.innerHTML = tool.icon;
    const button = el("button", { className: "app-ribbon__item", attrs: { type: "button", "data-tool": tool.id } }, [
      icon,
      el("span", { className: "app-ribbon__label", text: tool.label })
    ]);
    rendered.push({ tool, button });

    if (!tool.colorInput) {
      button.addEventListener("click", () => tool.run());
      return [button];
    }
    const picker = el("input", {
      className: "app-ribbon__color",
      attrs: {
        type: "color",
        value: colorValues.get(tool.id) ?? tool.colorInput.initial,
        title: tool.colorInput.label,
        "aria-label": tool.colorInput.label
      }
    });
    picker.addEventListener("input", () => colorValues.set(tool.id, picker.value));
    button.addEventListener("click", () => tool.run(picker.value));
    return [button, picker];
  };

  const render = (): void => {
    const groups = new Map<string, RibbonTool[]>();
    for (const tool of current.tools) {
      const list = groups.get(tool.group);
      if (list) {
        list.push(tool);
      } else {
        groups.set(tool.group, [tool]);
      }
    }

    rendered = [];
    element.dataset.category = current.id;
    element.setAttribute("aria-label", `${current.label} tools`);
    element.replaceChildren(
      ...Array.from(groups, ([group, tools]) =>
        el("div", { className: "app-ribbon__group", attrs: { role: "group", "aria-label": group } }, [
          el("div", { className: "app-ribbon__group-items" }, tools.flatMap(renderTool)),
          el("span", { className: "app-ribbon__group-label", text: group })
        ])
      )
    );
    refresh();
  };

  render();

  return {
    element,
    show(tabId: string): void {
      const next = tabs.find((tab) => tab.id === tabId);
      if (next && next !== current) {
        current = next;
        render();
      }
    },
    refresh
  };
}
