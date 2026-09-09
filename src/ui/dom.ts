/**
 * Small DOM-creation helper so UI components stay readable without
 * pulling in a framework. Plain TypeScript + DOM APIs only.
 */

type ElementOptions = {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: (HTMLElement | string)[] = []
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (options.className) {
    element.className = options.className;
  }
  if (options.text !== undefined) {
    element.textContent = options.text;
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      element.setAttribute(key, value);
    }
  }

  for (const child of children) {
    element.append(child);
  }

  return element;
}
