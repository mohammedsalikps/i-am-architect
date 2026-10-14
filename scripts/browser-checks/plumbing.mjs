// The uPVC plumbing slice and the demo UI in a real (headless) Chrome
// against the LOCAL stack only (dev server + in-memory mock backend) - see
// README.md. Pipe runs are built by conversation; the fittings are checked
// through the record book (they are derived, never stored), across top-bar
// undo/redo and a save / reload / reopen with a throwaway mock account.
// Also checks the ribbon's size presets, the hidden "Coming soon" tabs, the
// top-bar search, and that the AI panel never covers the view controls.
// Usage: node scripts/browser-checks/plumbing.mjs [screenshotDir]
//   APP (default http://localhost:5174/)
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectations, launch, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "iarchitect-browser-checks", "shots");
mkdirSync(outDir, { recursive: true });
const APP = process.env.APP ?? "http://localhost:5174/";
const READY = `!!document.querySelector(".architect__input") && !!document.querySelector(".viewport-container canvas")`;
const b = await launch({ name: "plumbing", width: 1440, height: 900, port: 9344, maxSeconds: 600 });
const { expect, finish } = expectations();
const log = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

const clickButton = (scope, text) =>
  b.evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter((entry) => !entry.disabled && entry.textContent.trim() === ${JSON.stringify(text)}).at(-1); if (!button) return false; button.click(); return true; })()`);
const say = async (text) => {
  const count = await b.evaluate(`document.querySelectorAll(".architect__msg--architect").length`);
  await b.evaluate(`(() => { const input = document.querySelector(".architect__input"); input.value = ${JSON.stringify(text)}; input.closest("form").requestSubmit(); })()`);
  await b.waitFor(`document.querySelectorAll(".architect__msg--architect").length > ${count} && !document.querySelector(".architect--busy")`, 20000);
  await sleep(700);
  return b.evaluate(`(() => { const last = [...document.querySelectorAll(".architect__msg--architect")].at(-1); return JSON.stringify({ tags: last.querySelector(".copilot__tags")?.textContent ?? "", text: last.querySelector(".architect__text")?.textContent ?? "" }); })()`).then(JSON.parse);
};
const records = async () => {
  await clickButton("", "Measurements");
  await sleep(900);
  return JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll(".record-book__row")].map((row) => [...row.cells].map((cell) => cell.textContent.trim()).join(" | ")))`));
};
const fittingRows = (rows) => rows.filter((row) => row.startsWith("joint:")).map((row) => row.split(" | ")[1]).sort();
const view = async (label) => {
  await b.evaluate(`[...document.querySelectorAll(".view-controls__button")].find((button) => button.textContent.trim() === ${JSON.stringify(label)})?.click()`);
  await sleep(500);
  await b.evaluate(`[...document.querySelectorAll(".view-controls__button")].find((button) => button.textContent.trim() === "Fit House")?.click()`);
  await sleep(2500);
};

expect("app loaded", await b.goto(APP, READY));
await sleep(1500);
await b.evaluate(`(() => { const fab = document.querySelector(".assistant-fab"); if (fab && !fab.hidden) fab.click(); })()`);

// --- demo UI ---
const visibleTabs = JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll(".sidebar-rail__item, .sidebar-tabs__item, .command-bar__tab, .viewport-tool")].filter((node) => node.offsetParent !== null).map((node) => (node.getAttribute("aria-label") || node.textContent).trim()))`));
log("visible tabs and tools", visibleTabs);
expect("no 'Coming soon' tabs or Annotate in the demo UI", !visibleTabs.some((label) => /^(Layers|Views|Documents|Blocks|Colors|Quotation|Design Review|Annotate)$/.test(label)) && visibleTabs.includes("Measurements") && visibleTabs.includes("Measure"));
expect("no disabled 'Coming soon' buttons anywhere", (await b.evaluate(`[...document.querySelectorAll("button[title='Coming soon']")].length`)) === 0);

// --- pipe runs by conversation ---
let r = await say("Run a 25 mm water pipe from 0, 0 to 4, 0");
expect("a 25 mm run is built", /Applied/.test(r.tags), r.text.slice(0, 120));
r = await say("Run a 25 mm water pipe from 4, 0 to 8, 0");
expect("a straight continuation takes a 25 mm coupler", /1 × 25 mm coupler/.test(r.text), r.text.slice(0, 220));
r = await say("Run a 20 mm water pipe from 4, 0 to 4, 2");
expect("a 20 mm branch at that joint makes a 25 × 20 reducing tee", /25 × 20 mm reducing tee/.test(r.text), r.text.slice(0, 260));
r = await say("Run a 25 mm water pipe from 8, 0 to 8, 3");
expect("a corner takes a 25 mm 90° elbow", /25 mm 90° elbow/.test(r.text), r.text.slice(0, 220));
r = await say("Lay a drain pipe from 0, 5 to 4, 5 then 4, 8");
expect("a drain corner takes the 110 mm 87.5° bend, with the fall note", /110 mm 87\.5° elbow/.test(r.text) && /2\.5°/.test(r.text), r.text.slice(0, 220));
r = await say("Run a 25 mm water pipe from 8, 3 to 9, 4.732");
expect("a 30° turn has no sheet part: flagged, not drawn as an elbow", /Needs attention/.test(r.text) && /turn 30° here/.test(r.text), r.text.slice(0, 260));
await b.evaluate(`(() => { const drawer = document.querySelector(".assistant-drawer"); if (drawer && !drawer.hidden) drawer.querySelector(".architect__collapse")?.click(); })()`);
await view("Top");
await b.shot(outDir, "90-plumbing-top");
await view("Perspective");
await b.shot(outDir, "91-plumbing-perspective");

const built = await records();
log("fittings in the record book", fittingRows(built));
expect(
  "the record book lists each fitting once (the coupler became the reducing tee when the branch joined), plus the unresolved joint",
  JSON.stringify(fittingRows(built)) === JSON.stringify(["110 mm 87.5° elbow", "25 mm 90° elbow", "25 × 20 mm reducing tee", "Unresolved joint"].sort())
);
const pipeRow = built.find((row) => row.startsWith("water-pipe-1"));
expect("a pipe row shows its size in mm and its sheet source", /Diameter 33\.4 mm/.test(pipeRow ?? "") && /Sheet p\.5/.test(pipeRow ?? ""), pipeRow);
const drainRow = built.find((row) => row.startsWith("drain-pipe-1"));
expect("a drain row reads Diameter 110 mm", /Diameter 110 mm/.test(drainRow ?? ""), drainRow);
await b.shot(outDir, "92-plumbing-records");

// A fitting row closes in on its joint (fittings are centimetres across). Clear the selection first: a selected pipe's handles would cover it.
await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
for (const [index, name] of ["25 mm 90° elbow", "25 × 20 mm reducing tee", "110 mm 87.5° elbow", "Unresolved joint"].entries()) {
  const clicked = await b.evaluate(`(() => { const row = [...document.querySelectorAll(".record-book__row--derived")].find((tr) => tr.cells[1]?.textContent.trim() === ${JSON.stringify(name)}); if (!row) return false; row.click(); return true; })()`);
  await sleep(2500);
  expect(`clicking the ${name} row zooms to its joint`, clicked);
  await b.shot(outDir, `9${4 + index}-closeup-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`);
}

// --- undo / redo from the top bar ---
await clickButton(".app-header__actions", "Undo");
await sleep(1200);
const afterUndo = fittingRows(await records());
expect("Undo: the last run and its unresolved joint are gone, the rest stay", !afterUndo.includes("Unresolved joint") && afterUndo.includes("25 mm 90° elbow"), JSON.stringify(afterUndo));
await clickButton(".app-header__actions", "Redo");
await sleep(1200);
expect("Redo: identical record book again", JSON.stringify(await records()) === JSON.stringify(built));

// --- ribbon size presets ---
await clickButton(".app-mainnav", "Plumbing");
await sleep(500);
const ribbon = JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll(".app-ribbon__item")].map((button) => button.textContent.trim()))`));
log("plumbing ribbon", ribbon);
expect("the Plumbing ribbon offers the sheet sizes", ["Water Pipe", "Water 20 mm", "Water 15 mm", "Drain Pipe", "Drain 75 mm"].every((name) => ribbon.includes(name)));
await clickButton(".app-ribbon", "Water 20 mm");
await sleep(400);
const status = await b.evaluate(`document.querySelector(".status-bar").innerText.split(String.fromCharCode(10))[0]`);
expect("arming a size shows it in the status bar", /Water 20 mm pipe/.test(status), status);
// Escape in the EMPTY top-bar search still reaches the placement tool - the box only keeps the Escape that clears a search.
await b.evaluate(`document.querySelector(".app-header__search").focus()`);
await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
const disarmed = await b.evaluate(`document.querySelector(".status-bar").innerText.split(String.fromCharCode(10))[0]`);
expect("Escape in the empty top-bar search still disarms the placement tool", !/Placement mode/.test(disarmed), disarmed);

// --- top-bar search (shown above 1365 px) ---
await b.evaluate(`(() => { const input = document.querySelector(".app-header__search"); input.focus(); input.value = "drain"; input.dispatchEvent(new Event("input")); })()`);
await sleep(400);
const tree = await b.evaluate(`document.querySelector(".hierarchy-objects")?.innerText.replace(/\\s+/g, " ") ?? ""`);
expect("typing in the top-bar search filters the Project tree", /MATCHES/.test(tree) && /drain-pipe/.test(tree), tree.slice(0, 120));
await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(800);
const selected = await b.evaluate(`document.querySelector(".status-bar").innerText.split(String.fromCharCode(10))[0]`);
expect("Enter selects the first match", /1 object selected/.test(selected), selected);

// --- a click on a fitting selects the pipe it's on (fittings are pickable; the click isn't passed to whatever is behind) ---
await b.evaluate(`(() => { const input = document.querySelector(".app-header__search"); input.value = "water-pipe"; input.dispatchEvent(new Event("input")); input.blur(); })()`);
await b.evaluate(`[...document.querySelectorAll(".record-book__row--derived")].find((tr) => tr.cells[1]?.textContent.trim() === "25 mm 90° elbow")?.click()`);
await sleep(2500);
const centre = JSON.parse(await b.evaluate(`JSON.stringify((() => { const rect = document.querySelector(".viewport-container canvas").getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })())`));
for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
  await b.send("Input.dispatchMouseEvent", { type, x: centre.x, y: centre.y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
}
await sleep(600);
const picked = await b.evaluate(`document.querySelector(".hierarchy-objects__item--selected")?.textContent ?? ""`);
expect("clicking the 25 mm 90° elbow in its close-up selects one of the two pipes it joins", /water-pipe-(2|4)\b/.test(picked), picked);
await b.shot(outDir, "98-fitting-picked");

// --- save, reload, reopen ---
await b.evaluate(`document.querySelector(".app-header__account .toolbar-button--primary").click()`);
await b.waitFor(`!!document.querySelector(".auth-dialog__title")?.textContent`);
if ((await b.evaluate(`document.querySelector(".auth-dialog__title").textContent`)) === "Sign in") {
  await b.evaluate(`document.querySelector(".auth-dialog__link").click()`);
  await sleep(300);
}
const email = `plumbing-${randomUUID().slice(0, 8)}@example.test`;
const password = randomUUID();
await b.evaluate(`(() => { const [emailInput, passwordInput] = document.querySelectorAll(".auth-dialog__input"); emailInput.value = ${JSON.stringify(email)}; passwordInput.value = ${JSON.stringify(password)}; document.querySelector(".auth-dialog__form").requestSubmit(); })()`);
expect("a throwaway account on the local mock backend", await b.waitFor(`!!document.querySelector(".app-header__account-name")?.textContent.trim()`, 20000));
await sleep(600);
await clickButton(".app-header__actions", "Save");
await b.waitFor(`/saved/i.test(document.querySelector(".app-header__save-status")?.textContent ?? "")`, 15000);
await b.send("Page.reload");
await sleep(1500);
await b.waitFor(READY, 60000);
await sleep(1500);
await b.evaluate(`(() => { [...document.querySelectorAll(".menu-bar .menu__button")].find((button) => button.textContent.trim() === "File").click(); [...document.querySelectorAll(".menu__item")].find((item) => item.textContent.trim().startsWith("Open")).click(); })()`);
await b.waitFor(`!!document.querySelector(".project-chooser__item")`, 15000);
await b.evaluate(`[...document.querySelectorAll(".project-chooser__item-actions button")].find((button) => button.textContent.trim() === "Open").click()`);
await sleep(2500);
expect("saved, reloaded and reopened: the record book - pipes and fittings - is identical", JSON.stringify(await records()) === JSON.stringify(built));
await b.shot(outDir, "93-plumbing-reopened");

// --- the AI panel never covers the view controls ---
for (const width of [1300, 1366, 1400, 1440]) {
  await b.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await b.evaluate(`(() => { const fab = document.querySelector(".assistant-fab"); if (fab && !fab.hidden) fab.click(); })()`);
  await sleep(500);
  const layout = JSON.parse(
    await b.evaluate(`(() => {
      const panel = document.querySelector(".architect").getBoundingClientRect();
      const controls = document.querySelector(".viewport-area__controls").getBoundingClientRect();
      const perspective = [...document.querySelectorAll(".view-controls__button")].find((button) => button.textContent.trim() === "Perspective").getBoundingClientRect();
      const hit = document.elementFromPoint(perspective.x + perspective.width / 2, perspective.y + perspective.height / 2);
      const overlap = panel.left < controls.right && panel.right > controls.left && panel.top < controls.bottom && panel.bottom > controls.top;
      const drawerOpen = !document.querySelector(".assistant-drawer").hidden && panel.width > 0;
      return JSON.stringify({ drawerOpen, overlap, perspectiveClickable: hit?.textContent?.trim() === "Perspective" });
    })()`)
  );
  expect(`${width} px: the open AI assistant drawer doesn't cover the view controls`, layout.drawerOpen && !layout.overlap && layout.perspectiveClickable, JSON.stringify(layout));
}

b.close();
finish();
