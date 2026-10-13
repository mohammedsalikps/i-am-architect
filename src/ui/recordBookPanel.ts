import { el } from "./dom";
import { buildRecordBook, recordBookCsv } from "../engine/records/recordBook.ts";
import type { RecordBook, RecordRow } from "../engine/records/recordBook.ts";
import type { AIContextObject } from "../engine/ai/types.ts";

/**
 * The Measurements tab: the construction record book - every element in
 * the scene with its material, dimensions, position and direction, area
 * and volume where the model defines them, and totals by type and
 * material. Rebuilt from the scene's own objects on every refresh (see
 * engine/records/recordBook.ts) - layout.ts calls refresh() whenever any
 * store changes, so it follows creates, moves, resizes, deletes, undo and
 * redo, and a reopened project, without keeping its own copy of anything.
 */
export interface RecordBookPanel {
  element: HTMLElement;
  refresh(): void;
}

const ALL_TYPES = "";

function meters(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function quantity(value: number | null, basis: string | null, unit: string): HTMLElement {
  return el("td", {
    className: value === null ? "record-book__num record-book__na" : "record-book__num",
    text: value === null ? "—" : value.toFixed(3),
    attrs: { title: value === null ? "Not defined for this element type in this model - not zero, not estimated" : `${basis ?? ""} (${unit})` }
  });
}

function rowElement(row: RecordRow, onSelect: (id: string) => void): HTMLElement {
  const tr = el("tr", { className: "record-book__row", attrs: { tabindex: "0", title: "Select this element in the 3D view" } }, [
    el("td", {}, [el("span", { className: "record-book__id", text: row.id }), ...(row.label ? [el("span", { className: "record-book__name", text: row.label })] : [])]),
    el("td", { text: row.typeLabel }),
    el("td", { text: row.materialLabel }),
    el("td", { className: "record-book__num", text: meters(row.length) }),
    el("td", { className: "record-book__num", text: meters(row.height) }),
    el("td", { className: "record-book__num", text: meters(row.thickness) }),
    el("td", { className: "record-book__other", text: row.otherDimensions.map((entry) => `${entry.name} ${entry.value.toFixed(2)}`).join(", ") || "—" }),
    el("td", { className: "record-book__num", text: `${row.position.x.toFixed(2)}, ${row.position.y.toFixed(2)}, ${row.position.z.toFixed(2)}` }),
    el("td", { text: row.direction }),
    quantity(row.area, row.areaBasis, "m²"),
    quantity(row.volume, row.volumeBasis, "m³")
  ]);
  const select = (): void => onSelect(row.id);
  tr.addEventListener("click", select);
  tr.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  });
  return tr;
}

function headerRow(cells: readonly string[]): HTMLElement {
  return el("tr", {}, cells.map((text) => el("th", { text, attrs: { scope: "col" } })));
}

function download(csv: string): void {
  // A byte-order mark so spreadsheet apps read "m²" and "—" correctly.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { attrs: { href: url, download: `eavara-record-book-${new Date().toISOString().slice(0, 10)}.csv` } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function buildRecordBookTab(getObjects: () => readonly AIContextObject[], onSelect: (objectId: string) => void): RecordBookPanel {
  let filter = ALL_TYPES;
  let book: RecordBook = { rows: [], totals: [], assumptions: [] };

  const summary = el("span", { className: "record-book__summary" });
  const typeSelect = el("select", { className: "record-book__filter", attrs: { "aria-label": "Show element type" } });
  const exportButton = el("button", { className: "toolbar-button toolbar-button--primary", text: "Export CSV", attrs: { type: "button" } });
  const header = el("div", { className: "record-book__header" }, [
    el("h3", { className: "record-book__title", text: "Construction record book" }),
    summary,
    el("span", { className: "record-book__spacer" }),
    typeSelect,
    exportButton
  ]);

  const tableBody = el("tbody");
  const table = el("table", { className: "record-book__table" }, [
    el("thead", {}, [headerRow(["Element", "Type", "Material", "Length m", "Height m", "Thickness m", "Other dims m", "Centre x, y, z m", "Direction", "Area m²", "Volume m³"])]),
    tableBody
  ]);
  const totalsBody = el("tbody");
  const totals = el("table", { className: "record-book__table record-book__totals" }, [
    el("thead", {}, [headerRow(["Type", "Material", "Count", "Length m", "Area m²", "Volume m³"])]),
    totalsBody
  ]);
  const assumptionList = el("ul", { className: "record-book__assumptions" });
  const assumptions = el("details", { className: "record-book__details" }, [el("summary", { text: "Units and assumptions" }), assumptionList]);
  const empty = el("p", { className: "command-bar__note", text: "No construction elements yet — build something (say “add a wall”, or ask for a house) and it appears here with its dimensions." });
  const content = el("div", { className: "record-book__content" }, [
    el("div", { className: "record-book__scroll" }, [table]),
    el("div", { className: "record-book__side" }, [el("h4", { className: "record-book__subtitle", text: "Totals by type and material" }), totals, assumptions])
  ]);
  const root = el("div", { className: "command-bar__column record-book" }, [header, empty, content]);

  exportButton.addEventListener("click", () => download(recordBookCsv(book)));
  typeSelect.addEventListener("change", () => {
    filter = typeSelect.value;
    refresh();
  });

  function refresh(): void {
    const objects = getObjects();
    // The type filter lists the types actually present.
    const present = buildRecordBook(objects).rows;
    const types = [...new Map(present.map((row) => [row.type, row.typeLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (filter !== ALL_TYPES && !types.some(([type]) => type === filter)) filter = ALL_TYPES;
    typeSelect.replaceChildren(
      el("option", { text: `All types (${present.length})`, attrs: { value: ALL_TYPES } }),
      ...types.map(([type, label]) => el("option", { text: `${label} (${present.filter((row) => row.type === type).length})`, attrs: { value: type } }))
    );
    typeSelect.value = filter;

    // What's shown is what's exported: the same filtered book.
    book = buildRecordBook(filter === ALL_TYPES ? objects : objects.filter((object) => (object.type === "element" ? object.kind ?? "element" : object.type) === filter));
    tableBody.replaceChildren(...book.rows.map((row) => rowElement(row, onSelect)));
    totalsBody.replaceChildren(
      ...book.totals.map((total) =>
        el("tr", {}, [
          el("td", { text: total.typeLabel }),
          el("td", { text: total.materialLabel }),
          el("td", { className: "record-book__num", text: String(total.count) }),
          el("td", { className: "record-book__num", text: total.length === null ? "—" : total.length.toFixed(2) }),
          el("td", { className: total.area === null ? "record-book__num record-book__na" : "record-book__num", text: total.area === null ? "—" : total.area.toFixed(3) }),
          el("td", { className: total.volume === null ? "record-book__num record-book__na" : "record-book__num", text: total.volume === null ? "—" : total.volume.toFixed(3) })
        ])
      )
    );
    assumptionList.replaceChildren(...book.assumptions.map((text) => el("li", { text })));

    const volume = book.rows.reduce((sum, row) => sum + (row.volume ?? 0), 0);
    summary.textContent = book.rows.length === 0 ? "" : `${book.rows.length} element${book.rows.length === 1 ? "" : "s"} · ${volume.toFixed(3)} m³ of measured volume`;
    empty.hidden = present.length > 0;
    content.hidden = present.length === 0;
    exportButton.disabled = book.rows.length === 0;
  }

  refresh();
  return { element: root, refresh };
}
