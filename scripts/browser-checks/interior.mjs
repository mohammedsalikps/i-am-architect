// Interior Explore in a real (headless) Chrome against the LOCAL stack only
// (the dev server and the in-memory mock backend - see README.md). Requests
// to any hosted backend are blocked in this browser. Builds a real house by
// conversation and walks through it; the model must not change.
// Usage: node scripts/browser-checks/interior.mjs [screenshotDir]
//   APP (default http://localhost:5174/), WIN (default 1440x900)
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, expectations, launch, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "iarchitect-browser-checks", "shots");
mkdirSync(outDir, { recursive: true });
const [W, H] = (process.env.WIN ?? "1440x900").split("x").map(Number);
const APP = process.env.APP ?? "http://localhost:5174/";
const READY = `!!document.querySelector(".architect__input") && !!document.querySelector(".viewport-container canvas")`;
const b = await launch({ name: "interior", width: W, height: H, port: 9352, maxSeconds: 420 });
const { expect, finish } = expectations();
const log = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

await b.send("Network.enable");
await b.send("Network.setBlockedURLs", { urls: ["*onrender.com*", "*supabase.co*", "*fly.dev*", "*vercel.app*"] });
const errors = [];
await b.send("Runtime.enable");
b.on("Runtime.exceptionThrown", (p) => errors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "").slice(0, 160)));

const say = async (text) => {
  const count = await b.evaluate(`document.querySelectorAll(".architect__msg--architect").length`);
  await b.evaluate(`(() => { const input = document.querySelector(".architect__input"); input.value = ${JSON.stringify(text)}; input.closest("form").requestSubmit(); })()`);
  await b.waitFor(`document.querySelectorAll(".architect__msg--architect").length > ${count}`, 30000);
  await sleep(800);
};
const clickButton = (scope, text) =>
  b.evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter((x) => !x.disabled && x.textContent.trim() === ${JSON.stringify(text)}).at(-1); if (!button) return false; button.click(); return true; })()`);
const records = async () => {
  await clickButton(".command-bar", "Measurements");
  await sleep(700);
  return JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll(".record-book__row")].map((row) => [...row.cells].map((cell) => cell.textContent.trim()).join(" | ")).sort())`));
};
const navigator = () =>
  b.evaluate(`JSON.stringify({
    open: !document.querySelector(".interior-explore").hidden,
    rooms: [...document.querySelectorAll(".interior-explore__room-name")].map((x) => x.textContent),
    active: document.querySelector(".interior-explore__room.is-active .interior-explore__room-name")?.textContent ?? null,
    message: document.querySelector(".interior-explore__message").textContent,
    readout: document.querySelector(".interior-explore__readout").textContent,
    x: Number(document.querySelector(".interior-explore__readout").dataset.x),
    y: Number(document.querySelector(".interior-explore__readout").dataset.y),
    z: Number(document.querySelector(".interior-explore__readout").dataset.z)
  })`).then(JSON.parse);
const roofHidden = () => b.evaluate(`[...document.querySelectorAll(".hierarchy-objects__item")].find((x) => /^Roof/.test(x.textContent))?.classList.contains("hierarchy-objects__item--hidden") ?? null`);
const selectedText = () => b.evaluate(`document.querySelector(".status-bar").innerText.split(String.fromCharCode(10))[0]`);
/** A room's plan rectangle from its record-book row: centre x, z and length (X) by width (Z). */
const roomBox = (rows, name) => {
  const row = rows.find((entry) => new RegExp(`^room-\\d+${name} `).test(entry)) ?? "";
  const cells = row.split(" | ");
  const [x, , z] = (cells[7] ?? "").split(",").map((value) => Number(value.trim()));
  const width = Number(/Width ([\d.]+)/.exec(cells[6] ?? "")?.[1]);
  return { x, z, length: Number(cells[3]), width };
};
const inside = (box, point) => Math.abs(point.x - box.x) <= box.length / 2 + 1e-6 && Math.abs(point.z - box.z) <= box.width / 2 + 1e-6;
const viewportPixels = async () => {
  await sleep(1200);
  const rect = JSON.parse(await b.evaluate(`JSON.stringify(document.querySelector(".viewport-container").getBoundingClientRect())`));
  const clip = { x: Math.round(rect.x + rect.width * 0.4), y: Math.round(rect.y + rect.height * 0.25), width: Math.round(rect.width * 0.5), height: Math.round(rect.height * 0.6), scale: 1 };
  const { result } = await b.send("Page.captureScreenshot", { format: "png", clip });
  return decodePng(Buffer.from(result.data, "base64"));
};
const changed = (a, c) => {
  let count = 0;
  for (let index = 0; index < a.data.length; index += a.bpp) {
    if (Math.abs(a.data[index] - c.data[index]) + Math.abs(a.data[index + 1] - c.data[index + 1]) + Math.abs(a.data[index + 2] - c.data[index + 2]) > 30) count += 1;
  }
  return count / (a.data.length / a.bpp);
};
/** A point on the 3D canvas itself - not under the navigator or another overlay. */
const canvasPoint = async () =>
  JSON.parse(await b.evaluate(`JSON.stringify((() => {
    const canvas = document.querySelector(".viewport-container canvas");
    const r = canvas.getBoundingClientRect();
    for (const [fx, fy] of [[0.35, 0.55], [0.3, 0.6], [0.45, 0.5], [0.25, 0.45]]) {
      const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
      if (document.elementFromPoint(x, y) === canvas) return { x, y };
    }
    return null;
  })())`));
/** A real mouse click on an element's centre, as a person would - focus moves with it. */
const clickOn = async (expression) => {
  // Scrolled into view first, as a person would on a short viewport (the room list scrolls).
  const point = JSON.parse(await b.evaluate(`JSON.stringify((() => { const target = ${expression}; target.scrollIntoView({ block: "nearest" }); const r = target.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })())`));
  for (const type of ["mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
};
const roomButton = (name) => `[...document.querySelectorAll(".interior-explore__room")].find((x) => x.querySelector(".interior-explore__room-name").textContent === ${JSON.stringify(name)})`;
const key = async (code, ms) => {
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", code, key: code === "KeyW" ? "w" : code, windowsVirtualKeyCode: code === "KeyW" ? 87 : 0 });
  await sleep(ms);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", code, key: code === "KeyW" ? "w" : code, windowsVirtualKeyCode: code === "KeyW" ? 87 : 0 });
  await sleep(300);
};

log("app loaded", await b.goto(APP, READY));
await sleep(1500);

// --- an empty project: a clear message, nothing changed ---
await b.evaluate(`document.querySelector(".interior-explore__toggle").click()`);
await sleep(500);
let nav = await navigator();
expect("with no rooms, Interior Explore says so and changes nothing", nav.open && /no rooms to explore/i.test(nav.message) && nav.rooms.length === 0, nav.message.slice(0, 80));
await clickButton(".interior-explore", "Exit interior");
await sleep(300);
expect("…and Exit closes it", !(await navigator()).open);

// --- a real house ---
for (const line of ["Set up a 30 x 20 m site", "Build a house", "3 bedrooms, 12 x 9 m", "Use the site centre", "Clear them and build here", "Build the rest of the house", "Brick"]) await say(line);
const rowsBefore = await records();
const door = rowsBefore.map((row) => /^(door-\d+)/.exec(row)?.[1]).find(Boolean);
await b.evaluate(`[...document.querySelectorAll(".record-book__row")].find((row) => row.querySelector(".record-book__id")?.textContent === ${JSON.stringify(door)})?.click()`);
await sleep(500);
const selectedBefore = await selectedText();
const undoBefore = await b.evaluate(`[...document.querySelectorAll(".app-header__actions button")].find((x) => x.textContent.trim() === "Undo").disabled`);
expect("a house was built, a door selected and the roof drawn", rowsBefore.length > 40 && /1 object selected/.test(selectedBefore) && (await roofHidden()) === false, `${rowsBefore.length} rows; ${selectedBefore}`);
const exteriorBefore = await viewportPixels();
await b.shot(outDir, "90-interior-exterior-before");

// --- enter ---
await clickOn(`document.querySelector(".interior-explore__toggle")`);
await sleep(1500);
nav = await navigator();
log("navigator", nav);
expect("the navigator lists the house's own six rooms", nav.rooms.join(", ") === "Living Room, Kitchen, Bedroom 1, Bedroom 2, Bedroom 3, Bathroom", nav.rooms.join(", "));
expect("it stands you in the first room at eye height: 1.6 m above the 0.2 m floor slab", nav.active === "Living Room" && Math.abs(nav.y - 1.8) < 1e-6, `${nav.active} y=${nav.y}`);
expect("inside the Living Room", inside(roomBox(rowsBefore, "Living Room"), nav), JSON.stringify(roomBox(rowsBefore, "Living Room")));
expect("the roof is hidden while exploring", (await roofHidden()) === true);
expect("the selection is set aside - nothing picked or dragged by accident", /Ready|0 objects selected|No selection/i.test(await selectedText()) || !/1 object selected/.test(await selectedText()), await selectedText());
const living = await viewportPixels();
expect("the view is now inside (different from the exterior view)", changed(exteriorBefore, living) > 0.2, `${(changed(exteriorBefore, living) * 100).toFixed(0)}% changed`);
await b.shot(outDir, "91-interior-living-room");

// --- typing to the companion is never walking ---
const typingFrom = await navigator();
await b.evaluate(`document.querySelector(".assistant-fab").click()`); // the companion's input is in the assistant drawer
await sleep(600);
await b.evaluate(`document.querySelector(".architect__input").focus()`);
const typingFocused = await b.evaluate(`document.activeElement === document.querySelector(".architect__input")`);
await key("KeyW", 800);
nav = await navigator();
expect("W typed into the companion's input does not walk", typingFocused && nav.x === typingFrom.x && nav.z === typingFrom.z, `focused ${typingFocused}; ${nav.x}, ${nav.z}`);
await b.evaluate(`(() => { const input = document.querySelector(".architect__input"); input.value = ""; input.blur(); })()`);
await b.evaluate(`document.querySelector(".assistant-drawer .architect__collapse").click()`);
await sleep(600);

// --- another room ---
await clickOn(roomButton("Kitchen"));
await sleep(1500);
nav = await navigator();
const kitchen = roomBox(rowsBefore, "Kitchen");
expect("Kitchen: moved into it, eye height kept", nav.active === "Kitchen" && inside(kitchen, nav) && Math.abs(nav.y - 1.8) < 1e-6, nav.readout);
await b.shot(outDir, "92-interior-kitchen");
const start = { x: nav.x, z: nav.z };

// --- walking, looking, clicking ---
const centre = await canvasPoint();
expect("a free spot on the canvas to drag and click", centre !== null);
await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: centre.x, y: centre.y });
await key("KeyW", 1500);
nav = await navigator();
// 1.4 m/s, but at most 0.1 s per frame (never a jump across the room) - a slow headless frame rate walks less far.
expect("holding W walks forward", Math.hypot(nav.x - start.x, nav.z - start.z) > 0.1, `${Math.hypot(nav.x - start.x, nav.z - start.z).toFixed(2)} m`);
await key("KeyW", 6000);
nav = await navigator();
expect("…and stops at the room's walls - still inside the kitchen, at eye height", inside(kitchen, nav) && Math.abs(nav.y - 1.8) < 1e-6, nav.readout);
const facingBefore = nav.readout.split("facing ")[1];
for (const type of ["mousePressed", "mouseMoved", "mouseMoved", "mouseReleased"]) {
  await b.send("Input.dispatchMouseEvent", { type, x: type === "mousePressed" ? centre.x : centre.x + (type === "mouseReleased" ? 260 : 130), y: centre.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  await sleep(120);
}
await sleep(400);
nav = await navigator();
expect("dragging turns the view", nav.readout.split("facing ")[1] !== facingBefore, `${facingBefore} -> ${nav.readout.split("facing ")[1]}`);
for (const type of ["mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type, x: centre.x, y: centre.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
await sleep(500);
expect("a click while exploring selects nothing", !/1 object selected/.test(await selectedText()), await selectedText());
await clickButton(".interior-explore", "Fit room");
await sleep(800);
nav = await navigator();
expect("Fit room returns to the kitchen's starting view", Math.abs(nav.x - start.x) < 1e-6 && Math.abs(nav.z - start.z) < 1e-6, nav.readout);
await clickOn(roomButton("Bedroom 1"));
await sleep(1200);
nav = await navigator();
expect("Bedroom 1: inside it, the roof still hidden", nav.active === "Bedroom 1" && inside(roomBox(rowsBefore, "Bedroom 1"), nav) && (await roofHidden()) === true, nav.readout);
await b.shot(outDir, "93-interior-bedroom");
expect("exploring changed nothing in the model (record book)", JSON.stringify(await records()) === JSON.stringify(rowsBefore));

// --- leave with Escape ---
await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(1500);
expect("Escape leaves Interior Explore", !(await navigator()).open);
expect("the roof is back", (await roofHidden()) === false);
expect("the door is selected again", (await selectedText()) === selectedBefore, await selectedText());
const exteriorAfter = await viewportPixels();
expect("the exterior view is back exactly where it was", changed(exteriorBefore, exteriorAfter) < 0.02, `${(changed(exteriorBefore, exteriorAfter) * 100).toFixed(2)}% differs`);
await b.shot(outDir, "94-interior-exterior-after");
const rowsAfter = await records();
expect("the record book is identical - nothing created, moved or resized", JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore));
const undoAfter = await b.evaluate(`[...document.querySelectorAll(".app-header__actions button")].find((x) => x.textContent.trim() === "Undo").disabled`);
expect("the undo history is as it was", undoAfter === undoBefore);
await clickButton(".app-header__actions", "Undo");
await sleep(1200);
const undone = await records();
await clickButton(".app-header__actions", "Redo");
await sleep(1200);
expect("Undo and Redo still work after exploring", JSON.stringify(undone) !== JSON.stringify(rowsBefore) && JSON.stringify(await records()) === JSON.stringify(rowsBefore));

// --- the button and the open navigator cover neither the view controls nor the companion ---
await clickOn(`document.querySelector(".interior-explore__toggle")`);
await sleep(1200);
for (const [width, height] of [[1024, 900], [1100, 900], [1180, 900], [1280, 900], [1366, 900], [1440, 900], [1920, 900], [1366, 650]]) {
  await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  const layout = JSON.parse(
    await b.evaluate(`(() => {
      const box = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const hits = (a, c) => !!a && !!c && a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top;
      const toggle = box(".interior-explore__bar"), panel = box(".interior-explore"), controls = box(".viewport-area__controls"), assistant = box(".assistant-fab");
      const clickable = (selector, text) => { const r = [...document.querySelectorAll(selector)].find((x) => x.textContent.trim() === text)?.getBoundingClientRect(); return !!r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.textContent?.trim() === text; };
      const assistantClickable = !!assistant && assistant.width > 0 && !!document.elementFromPoint(assistant.x + assistant.width / 2, assistant.y + assistant.height / 2)?.closest(".assistant-fab");
      return JSON.stringify({ overControls: hits(toggle, controls) || hits(panel, controls), overAssistant: hits(toggle, assistant) || hits(panel, assistant), assistantClickable, toggleClickable: clickable(".interior-explore__toggle", "Interior Explore"), perspectiveClickable: clickable(".view-controls__button", "Perspective"), exitClickable: clickable(".interior-explore button", "Exit interior") });
    })()`)
  );
  expect(`${width}x${height}: the Interior Explore button and navigator cover neither the view controls nor the assistant's button, and Exit interior is in reach`, !layout.overControls && !layout.overAssistant && layout.assistantClickable && layout.toggleClickable && layout.perspectiveClickable && layout.exitClickable, JSON.stringify(layout));
}
await b.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await sleep(600);
await clickButton(".interior-explore", "Exit interior");
await sleep(600);
expect("…and it closes again", !(await navigator()).open && (await roofHidden()) === false);
expect("no uncaught errors", errors.length === 0, errors.slice(0, 2).join(" | "));

b.close();
finish();
