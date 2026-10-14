import { el } from "./dom";

/**
 * Dropdown menus for the top bar - File, Edit, View, Build and the
 * account menu. One component so they all behave alike:
 *
 * - a button (aria-haspopup="menu", aria-expanded) opens a list of real
 *   actions (role="menu"); its items are rebuilt on every open, so what
 *   is enabled or ticked is always current;
 * - ↓/Enter/Space on the button open it on the first item; ↑/↓, Home and
 *   End move between items; Escape closes it and returns focus to the
 *   button; Tab or a click outside closes it;
 * - within a menu bar (createMenuBar) ←/→ move to the neighbouring menu,
 *   and hovering another menu's button while one is open switches to it;
 * - one menu is open at a time, anywhere in the app.
 *
 * Items run existing actions only - a menu never offers something the
 * workspace cannot do. An item that needs something first (Delete needs
 * a selection) is shown disabled, with a tooltip saying why.
 */

export type MenuItem =
  | { kind?: "action"; label: string; run: () => void; isEnabled?: () => boolean; disabledTitle?: string; hint?: string; title?: string }
  | { kind: "check"; label: string; run: () => void; isChecked: () => boolean; isEnabled?: () => boolean; hint?: string; title?: string }
  | { kind: "separator" }
  /** Non-interactive text - a heading, or the signed-in account. */
  | { kind: "info"; text: string; className?: string; title?: string };

export interface MenuOptions {
  /** The button's visible text (omit for an icon-only button - then give `ariaLabel`). */
  label?: string;
  /** Extra content inside the button, before the label - an avatar, an icon. */
  buttonContent?: (HTMLElement | string)[];
  buttonClassName?: string;
  ariaLabel?: string;
  title?: string;
  /** Which edge of the button the list lines up with. */
  align?: "start" | "end";
  className?: string;
  items: () => MenuItem[];
}

export interface Menu {
  element: HTMLElement;
  button: HTMLButtonElement;
  open(focus?: "first" | "last" | "none"): void;
  close(returnFocus?: boolean): void;
  isOpen(): boolean;
}

let openMenu: Menu | null = null;
let menuCount = 0;

export function createMenu(options: MenuOptions): Menu {
  const id = `menu-${++menuCount}`;
  const button = el(
    "button",
    {
      className: `menu__button${options.buttonClassName ? ` ${options.buttonClassName}` : ""}`,
      attrs: {
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-controls": id,
        ...(options.ariaLabel ? { "aria-label": options.ariaLabel } : {}),
        ...(options.title ? { title: options.title } : {})
      }
    },
    [...(options.buttonContent ?? []), ...(options.label ? [el("span", { className: "menu__button-label", text: options.label })] : [])]
  );
  const list = el("div", { className: `menu__list menu__list--${options.align ?? "start"}`, attrs: { id, role: "menu", "aria-label": options.ariaLabel ?? options.label ?? "Menu" } });
  list.hidden = true;
  const element = el("div", { className: `menu${options.className ? ` ${options.className}` : ""}` }, [button, list]);

  const items = (): HTMLButtonElement[] => [...list.querySelectorAll<HTMLButtonElement>(".menu__item:not(:disabled)")];

  const render = (): void => {
    list.replaceChildren(
      ...options.items().map((item): HTMLElement => {
        if (item.kind === "separator") return el("div", { className: "menu__separator", attrs: { role: "separator" } });
        if (item.kind === "info") return el("div", { className: `menu__info${item.className ? ` ${item.className}` : ""}`, text: item.text, attrs: { role: "presentation", ...(item.title ? { title: item.title } : {}) } });
        const enabled = item.isEnabled ? item.isEnabled() : true;
        const check = item.kind === "check";
        const checked = check && item.isChecked();
        const row = el(
          "button",
          {
            className: `menu__item${check ? " menu__item--check" : ""}`,
            attrs: {
              type: "button",
              role: check ? "menuitemcheckbox" : "menuitem",
              tabindex: "-1",
              ...(check ? { "aria-checked": String(checked) } : {}),
              ...(!enabled && item.kind !== "check" && item.disabledTitle ? { title: item.disabledTitle } : item.title ? { title: item.title } : {})
            }
          },
          [
            el("span", { className: "menu__check", text: checked ? "✓" : "", attrs: { "aria-hidden": "true" } }),
            el("span", { className: "menu__label", text: item.label }),
            ...(item.hint ? [el("span", { className: "menu__hint", text: item.hint, attrs: { "aria-hidden": "true" } })] : [])
          ]
        );
        row.disabled = !enabled;
        row.addEventListener("click", (event) => {
          // From the keyboard (Enter/Space: a click with detail 0) focus goes back to the menu's button, as with
          // Escape, rather than dropping to the page; an action that moves focus on purpose (Open…) still does.
          close(event.detail === 0);
          item.run();
        });
        return row;
      })
    );
  };

  const onOutside = (event: PointerEvent): void => {
    if (!element.contains(event.target as Node)) close(false);
  };
  // While open: Escape closes it (focus on its button) and Tab moves on with it closed - wherever focus is (its
  // button, its list, a neighbour hovered from, or the page after a click that did not focus the button).
  const onKey = (event: KeyboardEvent): void => {
    // A dialog that opened meanwhile (sign-in after an expired session) keeps its own Escape: the menu just closes.
    const inDialog = event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== null;
    if (event.key === "Escape" && inDialog) {
      close(false);
    } else if (event.key === "Escape") {
      // Closing the menu is all this Escape does - not a placement or drag cancel, nor leaving Interior Explore, too.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(false);
  };

  function open(focus: "first" | "last" | "none" = "none"): void {
    if (openMenu && openMenu !== menu) openMenu.close(false);
    render();
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    element.classList.add("is-open");
    openMenu = menu;
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    const all = items();
    if (focus === "first") all[0]?.focus();
    if (focus === "last") all[all.length - 1]?.focus();
  }

  function close(returnFocus = true): void {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    element.classList.remove("is-open");
    if (openMenu === menu) openMenu = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    if (returnFocus) button.focus();
  }

  button.addEventListener("click", () => (list.hidden ? open(button.matches(":focus-visible") ? "first" : "none") : close(false)));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      open("last");
    }
  });
  list.addEventListener("keydown", (event) => {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number): void => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? all.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(all.length - 1);
  });

  const menu: Menu = { element, button, open, close, isOpen: () => !list.hidden };
  return menu;
}

/** Joins menus into a menu bar: ←/→ move between them, and hovering one while another is open switches to it. */
export function createMenuBar(menus: readonly Menu[], label: string): HTMLElement {
  menus.forEach((menu, index) => {
    const neighbour = (step: number): Menu => menus[(index + step + menus.length) % menus.length];
    menu.element.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = neighbour(event.key === "ArrowRight" ? 1 : -1);
      const wasOpen = menu.isOpen();
      menu.close(false);
      if (wasOpen) next.open("first");
      else next.button.focus();
    });
    menu.button.addEventListener("pointerenter", () => {
      if (openMenu && openMenu !== menu && menus.includes(openMenu)) menu.open("none");
    });
  });
  return el("nav", { className: "menu-bar", attrs: { "aria-label": label } }, menus.map((menu) => menu.element));
}
