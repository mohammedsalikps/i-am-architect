// Milestone 3 - coordinates, grid and dimensions - in a real (headless)
// Chrome against the LOCAL stack only: the dev server talking to the
// in-memory mock backend (backend/mockBackend.ts) - see README.md. Requests
// to any hosted backend are BLOCKED in this browser. A throwaway account is
// created on the mock backend with credentials generated at run time (never
// printed; gone when the mock stops).
//
// Checks the plot, grid and snapping by conversation and by the Grid & plot
// popover; the Snap button and status bar; a kitchen placed at X 8, Y 6 and
// its inspector values; inspector moves and resizes taking the walls along
// (record book), refused values, top-bar Undo/Redo; the seven milestone
// phrases; the axes and dimension labels in the rendered pixels in both
// themes; the scale bar following the zoom; and save, reload and reopen
// keeping coordinates and workspace settings.
// Usage: node scripts/browser-checks/coordinates.mjs [screenshotDir]
//   APP (default http://localhost:5174/), WIN (default 1440x900)
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, expectations, launch, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "iarchitect-browser-checks", "shots");
mkdirSync(outDir, { recursive: true });
const [W, H] = (process.env.WIN ?? "1440x900").split("x").map(Number);
const APP = process.env.APP ?? "http://localhost:5174/";
const READY = `!!document.querySelector(".architect__input") && !!document.querySelector(".viewport-container canvas")`;
const b = await launch({ name: "coordinates", width: W, height: H, port: 9346, maxSeconds: 600 });
const log = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
const { expect, finish } = expectations();

await b.send("Network.enable");
await b.send("Network.setBlockedURLs", { urls: ["*onrender.com*", "*supabase.co*", "*fly.dev*", "*vercel.app*"] });

const clickButton = (scope, text) =>
  b.evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter((entry) => !entry.disabled && entry.textContent.trim() === ${JSON.stringify(text)}).at(-1); if (!button) return false; button.click(); return true; })()`);
const say = async (text) => {
  const count = await b.evaluate(`document.querySelectorAll(".architect__msg--architect").length`);
  await b.evaluate(`(() => { const input = document.querySelector(".architect__input"); input.value = ${JSON.stringify(text)}; input.closest("form").requestSubmit(); })()`);
  await b.waitFor(`document.querySelectorAll(".architect__msg--architect").length > ${count}`);
  await sleep(700);
  return b.evaluate(`(() => { const last = [...document.querySelectorAll(".architect__msg--architect")].at(-1); return JSON.stringify({ tags: last.querySelector(".copilot__tags")?.textContent ?? "", text: last.querySelector(".architect__text")?.textContent ?? "" }); })()`).then(JSON.parse);
};
const records = async () => {
  await clickButton("", "Measurements");
  await sleep(900);
  return JSON.parse(
    await b.evaluate(`JSON.stringify([...document.querySelectorAll(".record-book__row")].map((row) => [...row.cells].map((cell) => cell.textContent.trim()).join(" | ")).sort())`)
  );
};
const rowFor = (rows, id) => rows.find((row) => new RegExp(`^${id}[^0-9]`).test(row)) ?? "(missing)";
/** "x, y, z" from a record-book row's position column, as numbers. */
const positionOf = (row) => {
  const match = /\| (-?\d+\.\d{2}), (-?\d+\.\d{2}), (-?\d+\.\d{2}) \|/.exec(row);
  return match ? { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) } : null;
};
/** The kitchen's own walls - every wall row but the startup wall(s) recorded before it was built. */
let startupIds = new Set();
const wallRows = (rows) => rows.filter((row) => /^wall-\d+[^0-9]/.test(row) && !startupIds.has(/^(wall-\d+)/.exec(row)[1]));
const statusValue = (label) => b.evaluate(`[...document.querySelectorAll(".status-bar__item")].find((item) => item.querySelector(".status-bar__item-label")?.textContent === ${JSON.stringify(`${label}:`)})?.querySelector(".status-bar__item-value")?.textContent ?? "(none)"`);
const snapButton = () => b.evaluate(`document.querySelector(".snap-toggle")?.textContent ?? "(none)"`);
const openPanel = async (open) => {
  const isOpen = await b.evaluate(`!document.querySelector(".workspace-panel").hidden`);
  if (isOpen !== open) await b.evaluate(`document.querySelector(".workspace-panel__toggle").click()`);
  await sleep(200);
};
const panelState = () =>
  b.evaluate(`JSON.stringify({
    grid: document.querySelector('.workspace-panel select[aria-label="Grid spacing"]').value,
    snapping: document.querySelector('.workspace-panel__check input').checked,
    step: document.querySelector('.workspace-panel select[aria-label="Snap every"]').value,
    plotLength: document.querySelector('.workspace-panel input[aria-label="Plot length X (m)"]').value,
    plotWidth: document.querySelector('.workspace-panel input[aria-label="Plot width Z (m)"]').value,
    summary: document.querySelector("[data-dimension-summary]").textContent
  })`).then(JSON.parse);
const setPanelControl = (selector, value) =>
  b.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (input.type === "checkbox") input.checked = ${JSON.stringify(value)}; else input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
const inspectorValue = (label) => b.evaluate(`document.querySelector(${JSON.stringify(`.property-row__input[aria-label="${label}"]`)})?.value ?? "(none)"`);
const setInspector = async (label, value) => {
  await b.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(`.property-row__input[aria-label="${label}"]`)}); input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(700);
};
/** Selects `id` the way a user would: its row in the record book (Measurements tab). */
const select = async (id) => {
  await clickButton("", "Measurements");
  await sleep(500);
  await b.evaluate(`[...document.querySelectorAll(".record-book__row")].find((row) => row.querySelector(".record-book__id")?.textContent === ${JSON.stringify(id)})?.click()`);
  await sleep(700);
};
/** The 3D viewport's rendered pixels (the part no panel covers). */
const viewportPixels = async () => {
  await sleep(900); // let damping and the label rebuild settle
  const rect = JSON.parse(await b.evaluate(`JSON.stringify(document.querySelector(".viewport-container").getBoundingClientRect())`));
  const clip = { x: Math.round(rect.x + rect.width * 0.35), y: Math.round(rect.y + rect.height * 0.15), width: Math.round(rect.width * 0.6), height: Math.round(rect.height * 0.7), scale: 1 };
  const { result } = await b.send("Page.captureScreenshot", { format: "png", clip });
  return decodePng(Buffer.from(result.data, "base64"));
};
/** Share of pixels that changed noticeably between two captures of the same region. */
const changed = (a, c) => {
  let count = 0;
  for (let index = 0; index < a.data.length; index += a.bpp) {
    if (Math.abs(a.data[index] - c.data[index]) + Math.abs(a.data[index + 1] - c.data[index + 1]) + Math.abs(a.data[index + 2] - c.data[index + 2]) > 30) count += 1;
  }
  return count / (a.data.length / a.bpp);
};
const scaleBar = () => b.evaluate(`JSON.stringify({ hidden: document.querySelector(".scale-bar").hidden, metres: document.querySelector(".scale-bar").dataset.metres, label: document.querySelector(".scale-bar__label").textContent, width: document.querySelector(".scale-bar__bar").style.width })`).then(JSON.parse);

// --- start, and a throwaway account on the local mock backend ---
log("app loaded", await b.goto(APP, READY));
await sleep(1500);
await b.evaluate(`(() => { const fab = document.querySelector(".assistant-fab"); if (fab && !fab.hidden) fab.click(); })()`);
await b.evaluate(`document.querySelector(".app-header__account .toolbar-button--primary").click()`);
await b.waitFor(`!!document.querySelector(".auth-dialog__title")?.textContent`);
if ((await b.evaluate(`document.querySelector(".auth-dialog__title").textContent`)) === "Sign in") {
  await b.evaluate(`document.querySelector(".auth-dialog__link").click()`);
  await sleep(300);
}
const email = `coords-${randomUUID().slice(0, 8)}@example.test`;
const password = randomUUID();
await b.evaluate(`(() => {
  const [emailInput, passwordInput] = document.querySelectorAll(".auth-dialog__input");
  emailInput.value = ${JSON.stringify(email)};
  passwordInput.value = ${JSON.stringify(password)};
  document.querySelector(".auth-dialog__form").requestSubmit();
})()`);
expect("a throwaway account is created on the local mock backend and signed in", await b.waitFor(`!!document.querySelector(".app-header__account-name")?.textContent.trim()`, 20000));
await sleep(800);

// --- the defaults: snap step, grid, scale bar ---
expect("the Snap button shows the step: Snap: 0.1 m", (await snapButton()) === "Snap: 0.1 m", await snapButton());
expect("the status bar shows Snap 0.1 m and Grid 1 m", (await statusValue("Snap")) === "0.1 m" && (await statusValue("Grid")) === "1 m", `${await statusValue("Snap")} / ${await statusValue("Grid")}`);
const bar = await scaleBar();
log("scale bar", bar);
expect("a scale bar is shown with a round length", !bar.hidden && /^\d+(\.\d+)? m$/.test(bar.label) && Number.parseFloat(bar.width) > 20, bar.label);

// The axes and origin are drawn: hiding them changes the rendered view.
await b.evaluate(`(() => { const ring = document.querySelector('[aria-label="Top view"], .view-controls__button[title="Top view"]'); ring?.click(); })()`);
await sleep(1500);
await openPanel(true);
const withAxes = await viewportPixels();
await b.evaluate(`(() => { const box = [...document.querySelectorAll(".workspace-panel__check")].find((row) => row.textContent.includes("Axes and origin")).querySelector("input"); box.checked = false; box.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await openPanel(false);
const withoutAxes = await viewportPixels();
expect("the X/Y/Z axes and origin marker are drawn (hiding them changes the view)", changed(withAxes, withoutAxes) > 0.0005, `${(changed(withAxes, withoutAxes) * 100).toFixed(2)}% of pixels`);
await openPanel(true);
await b.evaluate(`(() => { const box = [...document.querySelectorAll(".workspace-panel__check")].find((row) => row.textContent.includes("Axes and origin")).querySelector("input"); box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await openPanel(false);
await b.shot(outDir, "70-axes-origin");

// Zooming changes the scale bar.
const before = await scaleBar();
const rect = JSON.parse(await b.evaluate(`JSON.stringify(document.querySelector(".viewport-container").getBoundingClientRect())`));
for (let i = 0; i < 6; i += 1) {
  await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(rect.x + rect.width * 0.7), y: Math.round(rect.y + rect.height * 0.5), deltaX: 0, deltaY: 400 });
  await sleep(150);
}
await sleep(1200);
const after = await scaleBar();
log("scale bar after zooming out", after);
expect("zooming out lengthens the scale bar's round length", Number(after.metres) > Number(before.metres), `${before.label} -> ${after.label}`);

// --- plot and grid by conversation ---
let r = await say("Set the plot to 30 metres by 40 metres.");
expect("'Set the plot to 30 metres by 40 metres.' lays out the plot", /Applied/.test(r.tags) && /30 × 40 m/.test(r.text), r.text.slice(0, 120));
await openPanel(true);
let panel = await panelState();
expect("the Grid & plot popover shows the plot: 30 by 40", panel.plotLength === "30" && panel.plotWidth === "40", JSON.stringify(panel));
await openPanel(false);
r = await say("Set the grid spacing to half a metre.");
expect("'Set the grid spacing to half a metre.' sets the grid to 0.5 m - a view setting, nothing applied to the model", /Grid spacing: 0\.5 m/.test(r.text) && !/Applied/.test(r.tags), r.text.slice(0, 120));
expect("the status bar shows Grid 0.5 m", (await statusValue("Grid")) === "0.5 m", await statusValue("Grid"));

// --- snap step by the popover ---
await openPanel(true);
await setPanelControl('.workspace-panel select[aria-label="Snap every"]', 0.25);
await sleep(300);
expect("choosing 0.25 m in the popover: Snap: 0.25 m on the button and in the status bar", (await snapButton()) === "Snap: 0.25 m" && (await statusValue("Snap")) === "0.25 m", `${await snapButton()} / ${await statusValue("Snap")}`);
panel = await panelState();
expect("the popover's grid select follows the spoken 0.5 m", panel.grid === "0.5", panel.grid);
await openPanel(false);

// --- the kitchen at X 8, Y 6 ---
// A fresh project starts with one wall (main.ts's startup wall); the kitchen's own walls are the ones it adds.
const startupWalls = new Set((await records()).filter((row) => /^wall-\d+[^0-9]/.test(row)).map((row) => /^(wall-\d+)/.exec(row)[1]));
startupIds = startupWalls;
const labelled = `Dimensions shown: 1 room, ${startupWalls.size + 4} walls.`;
r = await say("Create a 4.5 by 5 metre kitchen at X 8, Y 6.");
for (const answer of ["2.7 m", "ground floor", "brick", "yes"]) r = await say(answer);
expect("'Create a 4.5 by 5 metre kitchen at X 8, Y 6.' builds it (after its questions)", /Applied/.test(r.tags) && /centred at \(8, 6\)/.test(r.text), r.text.slice(0, 160));
let rows = await records();
const kitchenId = rows.map((row) => /^(room-\d+)Kitchen /.exec(row)?.[1]).find(Boolean) ?? "(none)";
const kitchenRow = rowFor(rows, kitchenId);
log("kitchen row", kitchenRow);
expect("record book: the kitchen at x 8, z 6, 4.50 m long", positionOf(kitchenRow)?.x === 8 && positionOf(kitchenRow)?.z === 6 && /\| 4\.50 \|/.test(kitchenRow));
const walls0 = wallRows(rows).map(positionOf);
expect("four walls around it", walls0.length === 4, String(walls0.length));
await openPanel(true);
panel = await panelState();
expect("the dimension summary: the room and every wall labelled", panel.summary === labelled, panel.summary);
await openPanel(false);

// --- the inspector ---
await select(kitchenId);
const inspector = {
  x: await inspectorValue("X (east)"),
  z: await inspectorValue("Z (south · plan Y)"),
  length: await inspectorValue("Length"),
  width: await inspectorValue("Width"),
  height: await inspectorValue("Ceiling height")
};
log("inspector", inspector);
expect("the inspector shows X 8, Z (plan Y) 6, 4.5 × 5 m, 2.7 m ceiling", JSON.stringify(inspector) === JSON.stringify({ x: "8", z: "6", length: "4.5", width: "5", height: "2.7" }));
expect("room rotation and height above ground are read-only", !(await b.evaluate(`!!document.querySelector('.property-row__input[aria-label="Rotation Y"]') || !!document.querySelector('.property-row__input[aria-label="Position Y"]')`)));
await b.shot(outDir, "71-kitchen-inspector");

await setInspector("X (east)", 9.5);
rows = await records();
const movedRow = rowFor(rows, kitchenId);
const walls1 = wallRows(rows).map(positionOf);
expect("inspector X 9.5: the kitchen moves to x 9.5", positionOf(movedRow)?.x === 9.5 && positionOf(movedRow)?.z === 6, movedRow);
expect("and each of its four walls moved 1.5 m east with it", walls1.length === 4 && walls1.every((wall, index) => Math.abs(wall.x - walls0[index].x - 1.5) < 0.011 && Math.abs(wall.z - walls0[index].z) < 0.011));
const afterMove = rows;

await select(kitchenId);
await setInspector("Width", 0.5);
const note = await b.evaluate(`[...document.querySelectorAll(".relation-note")].map((entry) => entry.textContent).join(" ")`);
expect("an impossible width (0.5 m) is refused with the reason shown", /Nothing was changed/.test(note), note.slice(0, 140));
expect("the field is put back to 5", (await inspectorValue("Width")) === "5", await inspectorValue("Width"));
expect("and nothing changed", JSON.stringify(await records()) === JSON.stringify(afterMove));

await clickButton(".app-header__actions", "Undo");
await sleep(1200);
expect("top-bar Undo puts the kitchen and its walls back at x 8", positionOf(rowFor(await records(), kitchenId))?.x === 8 && JSON.stringify(wallRows(await records()).map(positionOf)) === JSON.stringify(walls0));
await clickButton(".app-header__actions", "Redo");
await sleep(1200);
expect("Redo moves them to x 9.5 again", JSON.stringify(await records()) === JSON.stringify(afterMove));

// --- the rest of the milestone's phrases ---
await say("Move the kitchen to X 8, Y 6.");
r = await say("Move the kitchen two metres to the right.");
expect("'Move the kitchen two metres to the right.' - moved 2 m right, applied", /Applied/.test(r.tags) && /moved 2 m right/.test(r.text), r.text.slice(0, 140));
expect("record book: x 10", positionOf(rowFor(await records(), kitchenId))?.x === 10);
r = await say("Make the kitchen 4.5 metres wide.");
expect("'Make the kitchen 4.5 metres wide.' - width 5 → 4.5 m, applied", /Applied/.test(r.tags) && /width 5 m → 4\.5 m/.test(r.text), r.text.slice(0, 140));
r = await say("Move the room to X 10, Y 8.");
expect("'Move the room to X 10, Y 8.' - moved to X 10, Y 8, applied", /Applied/.test(r.tags) && /moved to X 10, Y 8/.test(r.text), r.text.slice(0, 140));
rows = await records();
expect("record book: the kitchen at x 10, z 8, nothing duplicated", positionOf(rowFor(rows, kitchenId))?.x === 10 && positionOf(rowFor(rows, kitchenId))?.z === 8 && rows.filter((row) => /^room-/.test(row)).length === 1 && wallRows(rows).length === 4);
await select(kitchenId);
expect("the inspector agrees: X 10, Z 8, width 4.5", (await inspectorValue("X (east)")) === "10" && (await inspectorValue("Z (south · plan Y)")) === "8" && (await inspectorValue("Width")) === "4.5");
r = await say("Turn snapping off.");
expect("'Turn snapping off.' - Snap: Off on the button and status bar", /Snapping is off/.test(r.text) && (await snapButton()) === "Snap: Off" && (await statusValue("Snap")) === "Off", `${await snapButton()} / ${await statusValue("Snap")}`);
const finalRows = await records();

// --- dimension labels and themes ---
await b.evaluate(`[...document.querySelectorAll(".view-controls__button")].find((button) => button.textContent.trim() === "Fit House")?.click()`);
await sleep(1500);
const labelsOn = await viewportPixels();
await openPanel(true);
await b.evaluate(`(() => { const box = [...document.querySelectorAll(".workspace-panel__check")].find((row) => row.textContent.includes("Dimension labels")).querySelector("input"); box.checked = false; box.dispatchEvent(new Event("change", { bubbles: true })); })()`);
panel = await panelState();
expect("hiding the dimension labels says so", panel.summary === "Dimensions hidden.", panel.summary);
await openPanel(false);
const labelsOff = await viewportPixels();
expect("the dimension labels are drawn (hiding them changes the view)", changed(labelsOn, labelsOff) > 0.0005, `${(changed(labelsOn, labelsOff) * 100).toFixed(2)}% of pixels`);
await openPanel(true);
await b.evaluate(`(() => { const box = [...document.querySelectorAll(".workspace-panel__check")].find((row) => row.textContent.includes("Dimension labels")).querySelector("input"); box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await openPanel(false);
await b.shot(outDir, "72-labels-light");

await b.evaluate(`document.querySelector(".app-header__theme").click()`);
await sleep(1200);
expect("dark theme on", (await b.evaluate(`document.documentElement.dataset.theme`)) === "dark");
await openPanel(true);
panel = await panelState();
expect("in the dark theme the same room and walls are labelled", panel.summary === labelled, panel.summary);
await openPanel(false);
const darkOn = await viewportPixels();
await openPanel(true);
await b.evaluate(`(() => { const box = [...document.querySelectorAll(".workspace-panel__check")].find((row) => row.textContent.includes("Dimension labels")).querySelector("input"); box.checked = false; box.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await openPanel(false);
const darkOff = await viewportPixels();
expect("and drawn in the dark theme", changed(darkOn, darkOff) > 0.0005, `${(changed(darkOn, darkOff) * 100).toFixed(2)}% of pixels`);
await openPanel(true);
await b.evaluate(`(() => { const box = [...document.querySelectorAll(".workspace-panel__check")].find((row) => row.textContent.includes("Dimension labels")).querySelector("input"); box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await openPanel(false);
await b.shot(outDir, "73-labels-dark");
expect("switching theme changed nothing in the model", JSON.stringify(await records()) === JSON.stringify(finalRows));
await b.evaluate(`document.querySelector(".app-header__theme").click()`);
await sleep(800);

// --- the plot by the popover ---
await openPanel(true);
await b.evaluate(`[...document.querySelectorAll(".workspace-panel button")].find((button) => button.textContent.trim() === "30 × 40 m").click()`);
await sleep(600);
const plotNote = await b.evaluate(`document.querySelector(".workspace-panel__note").textContent`);
expect("the popover's 30 × 40 m preset re-lays the plot and says nothing built changed", /Nothing already built moved or changed size/.test(plotNote), plotNote.slice(0, 140));
await setPanelControl('.workspace-panel input[aria-label="Plot length X (m)"]', 2);
await b.evaluate(`[...document.querySelectorAll(".workspace-panel button")].find((button) => button.textContent.trim() === "Apply plot").click()`);
await sleep(600);
const refusal = await b.evaluate(`JSON.stringify({ text: document.querySelector(".workspace-panel__note").textContent, tone: document.querySelector(".workspace-panel__note").dataset.tone })`).then(JSON.parse);
expect("a 2 m plot is refused in the popover, with no question left hanging", refusal.tone === "error" && /outside what I can lay out/.test(refusal.text) && /The plot is unchanged\./.test(refusal.text) && !/\?/.test(refusal.text), refusal.text.slice(0, 120));
await openPanel(false);
const kitchenAfterPlot = rowFor(await records(), kitchenId);
expect("the kitchen is untouched by the plot changes", kitchenAfterPlot === rowFor(finalRows, kitchenId));

// --- save, reload, reopen ---
await clickButton(".app-header__actions", "Save");
expect("saved", await b.waitFor(`/saved/i.test(document.querySelector(".app-header__save-status")?.textContent ?? "")`, 15000));
const saved = await records();
await b.send("Page.reload");
await sleep(1500);
expect("after a reload the app is ready and still signed in", (await b.waitFor(READY, 60000)) && (await b.waitFor(`!!document.querySelector(".app-header__account-name")?.textContent.trim()`, 15000)));
await sleep(1200);
expect("the workspace settings survived the reload: Snap: Off, Grid 0.5 m", (await snapButton()) === "Snap: Off" && (await statusValue("Grid")) === "0.5 m", `${await snapButton()} / ${await statusValue("Grid")}`);
await b.evaluate(`(() => { [...document.querySelectorAll(".menu-bar .menu__button")].find((button) => button.textContent.trim() === "File").click(); [...document.querySelectorAll(".menu__item")].find((item) => item.textContent.trim().startsWith("Open")).click(); })()`);
await b.waitFor(`!!document.querySelector(".project-chooser__item")`, 15000);
await b.evaluate(`[...document.querySelectorAll(".project-chooser__item-actions button")].find((button) => button.textContent.trim() === "Open").click()`);
await sleep(2500);
const reopened = await records();
expect("reopened: the record book is identical - the kitchen at x 10, z 8 with its walls", JSON.stringify(reopened) === JSON.stringify(saved), `${reopened.length} rows`);
await openPanel(true);
panel = await panelState();
expect("reopened: the dimension labels are back", panel.summary === labelled, panel.summary);
await openPanel(false);
r = await say("Move the kitchen to X 12, Y 8.");
rows = await records();
expect("the reopened kitchen moves to X 12, Y 8 with its walls", /Applied/.test(r.tags) && positionOf(rowFor(rows, kitchenId))?.x === 12 && wallRows(rows).length === 4, r.text.slice(0, 140));
await b.shot(outDir, "74-reopened-moved");

b.close();
finish();
