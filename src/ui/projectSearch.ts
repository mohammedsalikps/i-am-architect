/**
 * The Project tree's search (leftSidebar.ts): which of the project's
 * objects match what was typed. Pure - no DOM - so ui/verify.ts can run
 * it under Node.
 *
 * Every word typed must appear somewhere in an object's name, id or
 * details (its material, its catalog kind, the room it stands in), in
 * any order and case: "brick kitchen" finds the brick walls in the
 * kitchen. An exact id comes first, then names that start with the first
 * word, then the rest in tree order.
 */
export interface SearchableItem {
  id: string;
  label: string;
  /** Extra words to match: material, kind, "in Kitchen". */
  detail?: string;
}

export function searchProjectItems<T extends SearchableItem>(items: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];
  const exact = query.trim().toLowerCase();
  const rank = (item: T): number => (item.id.toLowerCase() === exact ? 0 : item.label.toLowerCase().startsWith(words[0]) ? 1 : 2);
  return items
    .map((item, index) => ({ item, index, text: `${item.label} ${item.id} ${item.detail ?? ""}`.toLowerCase() }))
    .filter(({ text }) => words.every((word) => text.includes(word)))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}
