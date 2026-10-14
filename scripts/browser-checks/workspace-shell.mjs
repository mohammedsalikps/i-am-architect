// The workspace shell in a real (headless) Chrome against the LOCAL stack
// only (the dev server and the in-memory mock backend - see README.md).
// Requests to any hosted backend are blocked in this browser. Every panel
// toggle, edge resize, menu and the account menu - and that nothing
// overlaps, clips or overflows at the desktop sizes the workspace targets.
// Usage: node scripts/browser-checks/workspace-shell.mjs [screenshotDir]
//   APP (default http://localhost:5174/)
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectations, launch, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "iarchitect-browser-checks", "shots");
mkdirSync(outDir, { recursive: true });
const APP = process.env.APP ?? "http://localhost:5174/";
const READY = `!!document.querySelector(".architect__input") && !!document.querySelector(".viewport-container canvas")`;
/** The project browser's icon rail, px - workspaceLayout.ts's RAIL_WIDTH. */
const RAIL = 62;
const b = await launch({ name: "workspace-shell", width: 1440, height: 900, port: 9357, maxSeconds: 540 });
const { expect, finish } = expectations();
const log = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

await b.send("Network.enable");
await b.send("Network.setBlockedURLs", { urls: ["*onrender.com*", "*supabase.co*", "*fly.dev*", "*vercel.app*"] });
const errors = [];
const dialogs = [];
await b.send("Runtime.enable");
b.on("Runtime.exceptionThrown", (p) => errors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "").slice(0, 160)));
b.on("Page.javascriptDialogOpening", (p) => dialogs.push(p.message));

const size = async (width, height) => {
  await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
};
const box = (selector) => b.evaluate(`JSON.stringify((() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; })())`).then(JSON.parse);
const layout = () => b.evaluate(`sessionStorage.getItem("eavara.workspace-layout.v1")`).then((text) => JSON.parse(text ?? "null"));
const click = (selector) => b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const clickText = (selector, text) => b.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}).click()`);
/** Clicks an item of the open menu by its label (a ticked item's text starts with ✓). */
const clickMenuItem = (label) => b.evaluate(`[...document.querySelectorAll(".menu.is-open .menu__item")].find((x) => x.querySelector(".menu__label").textContent === ${JSON.stringify(label)}).click()`);
/** The canvas fills the viewport box, and its drawing buffer has the same aspect - the camera follows every panel change. */
const canvasFits = () =>
  b.evaluate(`(() => {
    const area = document.querySelector(".viewport-container").getBoundingClientRect();
    const canvas = document.querySelector(".viewport-container canvas");
    const r = canvas.getBoundingClientRect();
    return Math.abs(r.width - area.width) < 2 && Math.abs(r.height - area.height) < 2 && Math.abs(canvas.width / canvas.height - area.width / area.height) < 0.01;
  })()`);
const pointerDrag = async (from, to) => {
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 5; step += 1) {
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * step) / 5, y: from.y + ((to.y - from.y) * step) / 5, button: "left", buttons: 1 });
    await sleep(40);
  }
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(400);
};
const key = async (keyName, code = keyName, extra = {}) => {
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: { Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Enter: 13 }[keyName] ?? 0, ...extra });
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, ...extra });
  await sleep(250);
};
const say = async (text) => {
  const count = await b.evaluate(`document.querySelectorAll(".architect__msg--architect").length`);
  await b.evaluate(`(() => { const input = document.querySelector(".architect__input"); input.value = ${JSON.stringify(text)}; input.closest("form").requestSubmit(); })()`);
  await b.waitFor(`document.querySelectorAll(".architect__msg--architect").length > ${count}`, 30000);
  await sleep(700);
};

log("app loaded", await b.goto(APP, READY));
await sleep(1800);

// --- File ▸ New project: the empty project's small card, the assistant from it ---
await b.evaluate(`[...document.querySelectorAll(".menu-bar .menu__button")].find((x) => x.textContent.trim() === "File").click()`);
await clickMenuItem("New project");
await b.waitFor(`!document.querySelector(".empty-state").hidden`, 10000);
expect("an empty project shows a small start card over the viewport, not a welcome screen", await b.evaluate(`(() => { const p = document.querySelector(".empty-state__panel").getBoundingClientRect(), v = document.querySelector(".viewport-area").getBoundingClientRect(); return !document.querySelector(".empty-state").hidden && p.width * p.height < v.width * v.height * 0.25; })()`));
await clickText(".empty-state__button", "Ask AI to Design");
await sleep(600);
expect("its Ask AI to Design opens the assistant drawer with the cursor in its input", await b.evaluate(`!document.querySelector(".assistant-drawer").hidden && document.activeElement === document.querySelector(".architect__input")`));
await click(".assistant-drawer .architect__collapse");
await sleep(500);
expect("the drawer's close button closes it and puts focus back on the assistant button", await b.evaluate(`document.querySelector(".assistant-drawer").hidden && document.activeElement === document.querySelector(".assistant-fab")`));

// --- a real house to work with ---
for (const line of ["Set up a 30 x 20 m site", "Build a house", "3 bedrooms, 12 x 9 m", "Use the site centre", "Clear them and build here", "Build the rest of the house", "Brick"]) await say(line);
await sleep(1200);
const fab = () => b.evaluate(`JSON.stringify({ hidden: document.querySelector(".assistant-fab").hidden, unread: document.querySelector(".assistant-fab").classList.contains("has-unread"), state: document.querySelector(".assistant-fab").dataset.state })`).then(JSON.parse);
expect("replies while the drawer was closed: its button shows a dot", (await fab()).unread, JSON.stringify(await fab()));
const messages = await b.evaluate(`document.querySelectorAll(".architect__msg").length`);
const browserBefore = await box(".sidebar--left");
await click(".assistant-fab");
await sleep(600);
// The whole conversation is there, and the newest reply - the one the dot announced - is in view in the log.
const conversationShown = () => b.evaluate(`(() => { const d = document.querySelector(".assistant-drawer"), m = [...d.querySelectorAll(".architect__msg")], dr = d.getBoundingClientRect(), r = m.at(-1)?.getBoundingClientRect(), lr = d.querySelector(".architect__log").getBoundingClientRect(); return !d.hidden && m.length === ${messages} && dr.width > 300 && !!r && r.width > 0 && r.height > 0 && r.left >= dr.left - 1 && r.right <= dr.right + 1 && r.bottom <= lr.bottom + 1 && r.bottom > lr.top; })()`);
expect("opening the drawer shows the whole conversation inside it, on the newest reply, the dot cleared", (await conversationShown()) && !(await fab()).unread && (await fab()).hidden);
expect("at 1440 the drawer folds the project browser to its rail, keeping the viewport at least 480px", browserBefore.width > 250 && (await box(".sidebar--left")).width <= RAIL + 1 && (await box(".viewport-area")).width >= 480, JSON.stringify({ before: browserBefore.width, now: (await box(".sidebar--left")).width, viewport: (await box(".viewport-area")).width }));
expect("…and the canvas follows the narrower viewport", await canvasFits());
await b.shot(outDir, "s1-assistant-open");
await click(".assistant-drawer .architect__collapse");
await sleep(500);
const closedKeeping = await b.evaluate(`document.querySelector(".assistant-drawer").hidden && document.querySelectorAll(".assistant-drawer .architect__msg").length === ${messages}`);
await click(".assistant-fab");
await sleep(500);
const shownAgain = await conversationShown();
await click(".assistant-drawer .architect__collapse");
await sleep(500);
expect("closing it keeps the conversation - reopened, it is all there", closedKeeping && shownAgain && (await canvasFits()));

// --- the project browser: rail, chevron, resize ---
let left = await box(".sidebar--left");
expect("closing the drawer brings the folded browser back beside its rail", left && left.width > 250, JSON.stringify(left));
await clickText(".sidebar-rail__item", "Project");
await sleep(500);
left = await box(".sidebar--left");
expect("the open rail tab again folds the browser to its rail", left && left.width < 70 && (await canvasFits()), JSON.stringify(left));
await clickText(".sidebar-rail__item", "Assets");
await sleep(500);
expect("another rail tab opens the browser on it", (await box(".sidebar--left")).width > 250 && !!(await box(".sidebar--left .asset-library")));
await clickText(".sidebar-rail__item", "Project");
await sleep(400);
const before = (await box(".sidebar--left")).width;
const edge = await box(".sidebar--left .splitter");
await pointerDrag({ x: edge.left + 3, y: edge.top + 200 }, { x: edge.left + 83, y: edge.top + 200 });
const dragged = (await box(".sidebar--left")).width;
expect("dragging its edge widens the browser", Math.abs(dragged - before - 80) <= 2, `${before} -> ${dragged}`);
await b.evaluate(`document.querySelector(".sidebar--left .splitter").focus()`);
await key("ArrowLeft");
await key("ArrowLeft");
expect("…and the arrow keys narrow it, 16px a step", Math.abs((await box(".sidebar--left")).width - (dragged - 32)) <= 1, String((await box(".sidebar--left")).width));
await key("Home");
expect("Home: its narrowest", (await box(".sidebar--left")).width <= 200 + RAIL + 2, String((await box(".sidebar--left")).width));
expect("the canvas follows", await canvasFits());
await click(".sidebar-rail__toggle");
await sleep(400);
expect("the chevron at the rail's foot folds the browser too", (await box(".sidebar--left")).width < 70);
await click(".sidebar-rail__toggle");
await sleep(400);

// --- the inspector: fold to its tab, select something, reopen ---
await click(".sidebar-tabs__collapse");
await sleep(500);
expect("the inspector folds to a slim tab, the canvas following", (await box(".app-inspector")).width <= 32 && !(await box(".sidebar--right")) && (await canvasFits()), JSON.stringify(await box(".app-inspector")));
await clickText(".command-bar__tab", "Measurements");
await sleep(800);
await b.evaluate(`document.querySelector(".record-book__row").click()`);
await sleep(500);
expect("selecting while it is folded puts a dot on its tab", await b.evaluate(`document.querySelector(".inspector-tab").classList.contains("has-selection")`));
await click(".inspector-tab");
await sleep(500);
expect("the tab opens the inspector on the selection's properties, the canvas following", (await box(".sidebar--right")).width > 240 && (await b.evaluate(`/Duplicate/.test(document.querySelector(".sidebar--right").textContent)`)) && (await canvasFits()));

// --- the records dock ---
let dock = await box(".command-bar");
expect("a dock tab opened the records dock under the viewport", dock.height > 150 && (await b.evaluate(`!!document.querySelector(".record-book__row")`)), JSON.stringify(dock));
await clickText(".command-bar__tab", "Measurements");
await sleep(500);
expect("its open tab clicked again leaves it open", (await box(".command-bar")).height > 150, String((await box(".command-bar")).height));
await click(".command-bar__toggle");
await sleep(500);
expect("its chevron folds it to the tab row", (await box(".command-bar")).height <= 36, String((await box(".command-bar")).height));
await click(".command-bar__toggle");
await sleep(500);
dock = await box(".command-bar");
expect("the chevron opens it again", dock.height > 150);
const dockEdge = await box(".command-bar .splitter");
await pointerDrag({ x: dockEdge.left + 200, y: dockEdge.top + 3 }, { x: dockEdge.left + 200, y: dockEdge.top - 57 });
expect("dragging its top edge makes it taller", Math.abs((await box(".command-bar")).height - dock.height - 60) <= 2, `${dock.height} -> ${(await box(".command-bar")).height}`);
expect("the record book keeps its CSV export", await b.evaluate(`[...document.querySelectorAll(".record-book button")].some((x) => x.textContent.trim() === "Export CSV")`));
expect("the canvas follows the dock", await canvasFits());

// --- the tool palette ---
await clickText(".app-mainnav__item", "Build");
await sleep(400);
expect("the open category again folds the palette away", !(await box(".app-ribbon")) && (await b.evaluate(`document.querySelector(".app-mainnav__toggle").textContent.includes("Show tools")`)));
await clickText(".app-mainnav__item", "Plumbing");
await sleep(400);
expect("another category opens the palette on its tools", (await box(".app-ribbon")) && (await b.evaluate(`document.querySelector(".app-ribbon").dataset.category === "plumbing"`)));
await click(".app-mainnav__toggle");
await sleep(300);
expect("Hide tools folds it", !(await box(".app-ribbon")));
await click(".app-mainnav__toggle");
await sleep(300);
expect("Show tools brings it back", !!(await box(".app-ribbon")) && (await canvasFits()));

// --- menus: mouse, keyboard, Escape, outside click ---
const menuButton = (label) => `[...document.querySelectorAll(".menu-bar .menu__button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)})`;
await b.evaluate(`${menuButton("File")}.focus()`);
await key("Enter");
expect("Enter on File opens it on its first item", await b.evaluate(`!document.querySelector(".menu-bar .menu__list").hidden && document.activeElement?.textContent.trim() === "New project"`));
await key("ArrowDown");
expect("↓ moves to the next item", await b.evaluate(`document.activeElement?.textContent.trim() === "Open…"`));
await key("ArrowRight");
expect("→ moves to the Edit menu", await b.evaluate(`document.querySelectorAll(".menu-bar .menu.is-open").length === 1 && document.querySelector(".menu-bar .menu.is-open .menu__button").textContent.trim() === "Edit"`));
await key("Escape");
expect("Escape closes it and returns focus to its button", await b.evaluate(`!document.querySelector(".menu-bar .menu.is-open") && document.activeElement === ${menuButton("Edit")}`));
await b.evaluate(`${menuButton("View")}.click()`);
await sleep(200);
const viewItems = await b.evaluate(`JSON.stringify([...document.querySelectorAll(".menu.is-open .menu__item")].map((x) => x.textContent.trim()))`).then(JSON.parse);
expect("View lists the presets, Fit / Focus, Interior Explore and every panel", ["Perspective", "Top", "Front", "Side", "Fit house", "Focus selected", "Interior Explore", "Project browser", "Inspector", "AI assistant", "Records dock", "Tool palette", "Dark theme"].every((label) => viewItems.some((item) => item.endsWith(label))), viewItems.join(" | "));
// Outside, on the status bar - a click on the scene would also select or deselect.
const status = await box(".status-bar");
await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: status.left + status.width / 2, y: status.top + status.height / 2, button: "left", buttons: 1, clickCount: 1 });
// (the View menu is closed by this click; below, a menu switched to by hovering)
await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: status.left + status.width / 2, y: status.top + status.height / 2, button: "left", buttons: 0, clickCount: 1 });
await sleep(300);
expect("a click outside closes it", !(await b.evaluate(`!!document.querySelector(".menu-bar .menu.is-open")`)));
const buttonBox = async (label) => JSON.parse(await b.evaluate(`JSON.stringify(${menuButton(label)}.getBoundingClientRect())`));
const fileBox = await buttonBox("File");
const editBox = await buttonBox("Edit");
await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fileBox.x + fileBox.width / 2, y: fileBox.y + fileBox.height / 2, button: "left", buttons: 1, clickCount: 1 });
await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: fileBox.x + fileBox.width / 2, y: fileBox.y + fileBox.height / 2, button: "left", buttons: 0, clickCount: 1 });
await sleep(200);
await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: editBox.x + editBox.width / 2, y: editBox.y + editBox.height / 2 });
await sleep(300);
const hoverSwitched = await b.evaluate(`document.querySelector(".menu-bar .menu.is-open .menu__button")?.textContent.trim() ?? null`);
await key("Escape");
expect("hovering Edit while File is open switches to it, and Escape closes it though focus stayed on File", hoverSwitched === "Edit" && !(await b.evaluate(`!!document.querySelector(".menu-bar .menu.is-open")`)), String(hoverSwitched));
await b.evaluate(`${menuButton("View")}.click()`);
await clickMenuItem("Records dock");
await sleep(400);
expect("View ▸ Records dock folds the dock, the canvas following", (await box(".command-bar")).height <= 36 && (await canvasFits()));
const editItemEnabled = (label) => b.evaluate(`![...document.querySelectorAll(".menu.is-open .menu__item")].find((x) => x.querySelector(".menu__label").textContent === ${JSON.stringify(label)}).disabled`);
await b.evaluate(`${menuButton("Edit")}.click()`);
await sleep(200);
const deleteWithSelection = await editItemEnabled("Delete selected");
await clickMenuItem("Clear selection");
await sleep(300);
await b.evaluate(`${menuButton("Edit")}.click()`);
await sleep(200);
const deleteWithout = await editItemEnabled("Delete selected");
await key("Escape");
expect("Edit ▸ Delete selected is offered with a selection, and not once Edit ▸ Clear selection has cleared it", deleteWithSelection && !deleteWithout, JSON.stringify({ deleteWithSelection, deleteWithout }));
await clickText(".command-bar__tab", "Measurements");
await sleep(700);
const rowCount = () => b.evaluate(`document.querySelectorAll(".record-book__row").length`);
const rowsBeforeDelete = await rowCount();
await b.evaluate(`[...document.querySelectorAll(".record-book__row")].find((row) => row.cells[1]?.textContent.trim() === "Door").click()`);
await sleep(400);
await b.evaluate(`${menuButton("Edit")}.click()`);
await clickMenuItem("Delete selected");
await sleep(800);
const rowsAfterDelete = await rowCount();
await b.evaluate(`${menuButton("Edit")}.click()`);
await clickMenuItem("Undo");
await sleep(800);
expect("Edit ▸ Delete selected deletes the selected door, and Edit ▸ Undo brings it back", rowsAfterDelete < rowsBeforeDelete && (await rowCount()) === rowsBeforeDelete, `${rowsBeforeDelete} -> ${rowsAfterDelete} -> ${await rowCount()}`);
await click(".command-bar__toggle");
await sleep(400);
await b.evaluate(`${menuButton("Build")}.click()`);
await clickMenuItem("Electrical");
await sleep(300);
expect("Build ▸ Electrical shows the electrical tools", await b.evaluate(`document.querySelector(".app-ribbon").dataset.category === "electrical" && document.querySelector(".app-mainnav__item--active").textContent.trim() === "Electrical"`));

// --- the arrangement survives a reload (this browser session) ---
await click(".sidebar-tabs__collapse"); // the inspector folded (its default is open)
await clickText(".command-bar__tab", "Construction Method"); // the dock open on a tab other than its default
await sleep(800);
const saved = await layout();
const dockBefore = (await box(".command-bar")).height;
expect("the arrangement is kept for the session", saved && saved.dock.open === true && saved.dock.tab === "construction-method" && saved.right.open === false, JSON.stringify(saved));
await b.send("Page.reload", { ignoreCache: false });
await sleep(1500);
expect("reload: ready", await b.waitFor(READY, 45000));
await sleep(1200);
const reloaded = {
  inspector: (await box(".app-inspector"))?.width,
  inspectorPanel: await box(".sidebar--right"),
  dock: (await box(".command-bar"))?.height,
  dockTab: await b.evaluate(`document.querySelector(".command-bar__tab--active")?.dataset.tab ?? null`),
  browser: (await box(".sidebar--left"))?.width
};
expect("reload: the same panels on the page - inspector folded, the dock open on Construction Method at its height, the browser at its width", reloaded.inspector <= 32 && !reloaded.inspectorPanel && Math.abs(reloaded.dock - dockBefore) <= 2 && reloaded.dockTab === "construction-method" && Math.abs(reloaded.browser - (RAIL + saved.left.width)) <= 2, JSON.stringify({ reloaded, dockBefore, saved }));
await click(".inspector-tab");
await click(".command-bar__toggle");
await sleep(500);

// --- the account: Sign in, then an avatar with a menu ---
await b.evaluate(`document.querySelector(".app-header__account .toolbar-button--primary").click()`);
await b.waitFor(`!!document.querySelector(".auth-dialog__title")?.textContent`);
if ((await b.evaluate(`document.querySelector(".auth-dialog__title").textContent`)) === "Sign in") {
  await b.evaluate(`document.querySelector(".auth-dialog__link").click()`);
  await sleep(300);
}
const email = `shell-${randomUUID().slice(0, 8)}@example.test`;
await b.evaluate(`(() => {
  const [emailInput, passwordInput] = document.querySelectorAll(".auth-dialog__input");
  emailInput.value = ${JSON.stringify(email)};
  passwordInput.value = ${JSON.stringify(randomUUID())};
  document.querySelector(".auth-dialog__form").requestSubmit();
})()`);
expect("a throwaway account on the local mock backend", await b.waitFor(`document.querySelector(".app-header__account-name")?.textContent.trim() === ${JSON.stringify(email)}`, 20000));
await sleep(500);
const avatar = await box(".app-header__avatar");
const initial = await b.evaluate(`document.querySelector(".app-header__avatar-initial").textContent`);
const emailOnBar = await box(".app-header__account-name");
expect("signed in, the bar shows a round avatar with the email's initial - the email itself only for assistive technology", !!avatar && Math.abs(avatar.width - avatar.height) < 1 && initial === "S" && (!emailOnBar || emailOnBar.width <= 1), JSON.stringify({ avatar, initial, emailOnBar }));
await click(".app-header__avatar");
await sleep(300);
expect("its menu shows the email and Sign out", await b.evaluate(`(() => { const list = document.querySelector(".app-header__account-menu .menu__list"); return !list.hidden && list.textContent.includes(${JSON.stringify(email)}) && [...list.querySelectorAll(".menu__item")].some((x) => x.textContent.trim() === "Sign out…"); })()`));
await b.shot(outDir, "s2-account-menu");
await clickText(".app-header__account-menu .menu__item", "Sign out…");
await sleep(1500);
expect("Sign out with a model in the workspace asks first", dialogs.some((message) => /^Sign out\?/.test(message)), dialogs.join(" | "));
expect("…and, confirmed, signs out: Sign in is back", await b.waitFor(`!document.querySelector(".app-header__sign-in").hidden && document.querySelector(".app-header__account-menu").hidden`, 10000));

// --- nothing overlaps, clips or overflows at the desktop sizes ---
await click(".assistant-fab");
await sleep(500);
for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 800], [1024, 768]]) {
  await size(width, height);
  const report = JSON.parse(
    await b.evaluate(`JSON.stringify((() => {
      const rect = (el) => { const r = el?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 ? r : null; };
      const hits = (a, c) => !!a && !!c && a.left < c.right - 0.5 && a.right > c.left + 0.5 && a.top < c.bottom - 0.5 && a.bottom > c.top + 0.5;
      const regions = [".app-header", ".app-toolbar", ".sidebar--left", ".viewport-area", ".command-bar", ".assistant-drawer", ".app-inspector", ".status-bar"].map((s) => [s, rect(document.querySelector(s))]).filter(([, r]) => r);
      const overlaps = [];
      for (let i = 0; i < regions.length; i += 1) for (let j = i + 1; j < regions.length; j += 1) if (hits(regions[i][1], regions[j][1])) overlaps.push(regions[i][0] + "/" + regions[j][0]);
      // Every top-bar control on screen, whole, and not covered by anything.
      const header = [...document.querySelectorAll(".app-header button:not([hidden]):not(.menu__item), .app-header input")].filter((el) => el.offsetParent !== null);
      const clipped = header.filter((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.left < 0 || r.right > innerWidth + 0.5 || !(hit === el || el.contains(hit)); }).map((el) => el.textContent.trim() || el.getAttribute("aria-label") || el.className);
      const clickable = (el) => { const r = el?.getBoundingClientRect(); if (!r) return false; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === el || el.contains(hit); };
      const perspective = [...document.querySelectorAll(".view-controls__button")].find((x) => x.textContent.trim() === "Perspective");
      const gizmo = rect(document.querySelector(".axis-gizmo")), scale = rect(document.querySelector(".scale-bar")), interior = rect(document.querySelector(".interior-explore__bar")), controls = rect(document.querySelector(".viewport-area__controls"));
      return {
        overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
        overlaps,
        clipped,
        viewport: Math.round(rect(document.querySelector(".viewport-area")).width),
        perspective: clickable(perspective),
        toolTabsScroll: document.querySelector(".app-mainnav__tabs").scrollWidth <= document.querySelector(".app-mainnav__tabs").clientWidth + 1 || getComputedStyle(document.querySelector(".app-mainnav__tabs")).overflowX === "auto",
        interiorClear: !hits(interior, controls),
        overlaysClear: !hits(gizmo, scale)
      };
    })())`)
  );
  log(`${width}x${height}`, report);
  expect(`${width}x${height}: no page overflow, no overlapping regions, every top-bar control whole and clickable, the view presets clickable, the viewport at least 480px`, !report.overflow && report.overlaps.length === 0 && report.clipped.length === 0 && report.perspective && report.viewport >= 480 && report.toolTabsScroll && report.interiorClear && report.overlaysClear, JSON.stringify(report));
  expect(`${width}x${height}: the canvas fits its viewport`, await canvasFits());
  await b.shot(outDir, `s3-${width}x${height}`);
}

// --- a compact window: panels draw over the viewport, Escape closes them ---
await size(800, 800);
await clickText(".sidebar-rail__item", "Project");
await sleep(500);
const overlay = await b.evaluate(`JSON.stringify({ position: getComputedStyle(document.querySelector(".sidebar--left > .tab-strip__panel")).position, viewport: Math.round(document.querySelector(".viewport-area").getBoundingClientRect().width) })`).then(JSON.parse);
const opened = await layout();
const panelBox = await box(".sidebar--left > .tab-strip__panel");
const viewBox = await box(".viewport-area");
expect("800px: the rail opens the browser alone, drawn over the viewport rather than squeezing it", opened.left.open && !opened.assistant.open && !opened.right.open && !!panelBox && !!viewBox && panelBox.right > viewBox.left + 1 && overlay.position === "absolute" && overlay.viewport > 650, JSON.stringify({ overlay, opened, panelBox, viewBox }));
await b.evaluate(`document.querySelector(".hierarchy-search__input").focus()`);
expect("…with focus in its search box", await b.evaluate(`document.activeElement === document.querySelector(".hierarchy-search__input")`));
await key("Escape");
expect("…and Escape closes it, focus on the rail's chevron", (await layout()).left.open === false && !(await box(".sidebar--left > .tab-strip__panel")) && (await b.evaluate(`document.activeElement === document.querySelector(".sidebar-rail__toggle")`)));
await clickText(".sidebar-rail__item", "Project");
await sleep(300);
await b.evaluate(`[...document.querySelectorAll(".menu-bar .menu__button")].find((x) => x.textContent.trim() === "View").click()`);
await sleep(300);
const menuOnTop = await b.evaluate(`(() => { const items = [...document.querySelectorAll(".menu.is-open .menu__item")]; const last = items[items.length - 1].getBoundingClientRect(); const hit = document.elementFromPoint(last.left + 20, last.top + last.height / 2); return !!hit?.closest(".menu.is-open"); })()`);
await key("Escape");
expect("…and a top-bar menu opens over that overlay, not under it - Escape closing it with focus back on its button", menuOnTop && (await b.evaluate(`!document.querySelector(".menu-bar .menu.is-open") && document.activeElement === [...document.querySelectorAll(".menu-bar .menu__button")].find((x) => x.textContent.trim() === "View")`)));
for (const [width, height] of [[800, 800], [390, 844]]) {
  await size(width, height);
  await click(".assistant-fab");
  await sleep(500);
  const drawer = await box(".assistant-drawer");
  const tab = await box(".inspector-tab");
  expect(`${width}px: the assistant drawer opens over the viewport, whole on screen and flush against the inspector's tab`, !!drawer && !!tab && drawer.left >= 0 && Math.abs(drawer.right - tab.left) <= 1 && (await layout()).left.open === false, JSON.stringify({ drawer, tab }));
  await click(".assistant-drawer .architect__collapse");
  await sleep(400);
}
await size(1440, 900);

expect("no uncaught errors", errors.length === 0, errors.slice(0, 3).join(" | "));
b.close();
finish();
