// Save / reopen of conversational rooms in a real (headless) Chrome
// against the LOCAL stack only: the dev server talking to the in-memory
// mock backend (backend/mockBackend.ts) - see README.md. A throwaway
// account is created on that mock backend with credentials generated at
// runtime (never printed; gone when the mock stops).
// Usage: node scripts/browser-checks/save-reopen.mjs [screenshotDir]
//   APP (default http://localhost:5174/), WIN (default 1440x900)
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectations, launch, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "iarchitect-browser-checks", "shots");
mkdirSync(outDir, { recursive: true });
const [W, H] = (process.env.WIN ?? "1440x900").split("x").map(Number);
const APP = process.env.APP ?? "http://localhost:5174/";
const READY = `!!document.querySelector(".architect__input") && !!document.querySelector(".viewport-container canvas")`;
const b = await launch({ name: "persist", width: W, height: H, port: 9341 });
const log = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
const { expect, finish } = expectations();

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
const saveStatus = () => b.evaluate(`document.querySelector(".app-header__save-status")?.textContent?.trim() ?? ""`);
const save = async () => {
  await clickButton(".app-header__actions", "Save");
  await b.waitFor(`/saved/i.test(document.querySelector(".app-header__save-status")?.textContent ?? "")`, 15000);
  return saveStatus();
};
const reloadAndOpen = async () => {
  await b.send("Page.reload");
  await sleep(1500);
  const ready = await b.waitFor(READY, 60000);
  await sleep(1500);
  const signedIn = await b.waitFor(`!!document.querySelector(".app-header__account-name")?.textContent.trim()`, 15000);
  const fresh = await records();
  await b.evaluate(`[...document.querySelectorAll(".app-header__actions button")].find((button) => button.textContent.trim().startsWith("Open")).click()`);
  await b.waitFor(`!!document.querySelector(".project-chooser__item")`, 15000);
  await b.evaluate(`[...document.querySelectorAll(".project-chooser__item-actions button")].find((button) => button.textContent.trim() === "Open").click()`);
  await sleep(2500);
  return { ready, signedIn, fresh };
};

// --- start, and a throwaway account on the local mock backend ---
log("app loaded", await b.goto(APP, READY));
await sleep(1500);
await b.evaluate(`(() => { const button = document.querySelector(".architect__collapse"); if (button && /Expand/.test(button.getAttribute("aria-label") ?? "")) button.click(); })()`);
await b.evaluate(`document.querySelector(".app-header__account .toolbar-button--primary").click()`);
await b.waitFor(`!!document.querySelector(".auth-dialog__title")?.textContent`);
if ((await b.evaluate(`document.querySelector(".auth-dialog__title").textContent`)) === "Sign in") {
  await b.evaluate(`document.querySelector(".auth-dialog__link").click()`);
  await sleep(300);
}
const email = `persist-${randomUUID().slice(0, 8)}@example.test`;
const password = randomUUID();
await b.evaluate(`(() => {
  const [emailInput, passwordInput] = document.querySelectorAll(".auth-dialog__input");
  emailInput.value = ${JSON.stringify(email)};
  passwordInput.value = ${JSON.stringify(password)};
  document.querySelector(".auth-dialog__form").requestSubmit();
})()`);
expect("a throwaway account is created on the local mock backend and signed in", await b.waitFor(`!!document.querySelector(".app-header__account-name")?.textContent.trim()`, 20000));
await sleep(800);

// --- build two rooms by conversation ---
let r = await say("Create a 4 m by 5 m kitchen, 3 m high, on the ground floor, brick walls, at 0, 0");
r = await say("yes");
expect("kitchen built", /Applied/.test(r.tags), r.text.slice(0, 90));
r = await say("Create a 3 m by 4 m bedroom, 2.7 m high, brick walls, beside the kitchen");
r = await say("east");
r = await say("yes");
expect("bedroom built beside it", /Applied/.test(r.tags), r.text.slice(0, 90));
const built = await records();
log("record book before saving", built);
await b.shot(outDir, "60-built");

// --- save, reload the page, open the saved project ---
log("save status", await save());
const first = await reloadAndOpen();
expect("after a page reload the app is ready and still signed in", first.ready && first.signedIn);
log("record book of the fresh project before opening", first.fresh);
const reopened = await records();
expect("reopened: the record book is identical to the saved scene", JSON.stringify(reopened) === JSON.stringify(built), `${reopened.length} rows vs ${built.length}`);
expect("no duplicate ids after reopening", new Set(reopened.map((row) => row.split(" | ")[0])).size === reopened.length);
await b.shot(outDir, "61-reopened");

// --- edit the reopened rooms ---
// A room row starts "room-2Bedroom | ..." - the id and the room's name side by side.
const roomIdNamed = (label) => reopened.map((row) => new RegExp(`^(room-[0-9]+)${label} `).exec(row)?.[1]).find(Boolean) ?? "(none)";
const bedroomId = roomIdNamed("Bedroom");
const kitchenId = roomIdNamed("Kitchen");
log("rooms", { kitchenId, bedroomId });
r = await say("make the bedroom 3.5 m long");
expect("the reopened bedroom resizes by name, applied", /Applied/.test(r.tags), r.text.slice(0, 200));
const resized = await records();
log("bedroom row after resize", rowFor(resized, bedroomId));
expect("record book: bedroom 3.50 m long, centred at x 3.75", /\b3\.50\b/.test(rowFor(resized, bedroomId)) && /3\.75, /.test(rowFor(resized, bedroomId)));
expect("no objects added by the resize", resized.length === reopened.length);
await b.shot(outDir, "62-resized");

await clickButton(".app-header__actions", "Undo");
await sleep(1200);
expect("Undo (top bar): record book back to the reopened state", JSON.stringify(await records()) === JSON.stringify(reopened));
await clickButton(".app-header__actions", "Redo");
await sleep(1200);
expect("Redo (top bar): record book back to the resized state", JSON.stringify(await records()) === JSON.stringify(resized));

r = await say("move the kitchen 1 m east");
expect("moving the kitchen off its shared wall is refused and explained", /shares with the bedroom/.test(r.text) && !/Applied/.test(r.tags), r.text.slice(0, 160));
expect("the refusal changed nothing", JSON.stringify(await records()) === JSON.stringify(resized));
await b.shot(outDir, "63-refused");

// --- save the edits, reload, reopen ---
log("second save status", await save());
const second = await reloadAndOpen();
const reopenedAgain = await records();
expect("saved again and reopened: the record book matches the edited scene", JSON.stringify(reopenedAgain) === JSON.stringify(resized), `${reopenedAgain.length} rows`);
r = await say("move the bedroom 0.5 m south");
expect("the twice-reopened bedroom still moves with its own walls", /Applied/.test(r.tags) && /changed with it/.test(r.text), r.text.slice(0, 200));
await b.shot(outDir, "64-reopened-again-moved");
log("final bedroom row", rowFor(await records(), bedroomId));

b.close();
finish();
