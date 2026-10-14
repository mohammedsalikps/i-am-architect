// The professional-workspace milestone in a real (headless) Chrome, LOCAL only:
// a dev server serving this working tree (APP, default http://localhost:5174/).
// Requests to any hosted backend (Render, Supabase) are BLOCKED in this browser,
// so nothing here can reach staging even when APP's dev server points there.
//
// Theme: every main region (top bar, nav, ribbon, sidebars, AI panel, view
// controls, command bar, status bar) and the 3D viewport's own pixels change
// when the one-click toggle is pressed; text stays readable (WCAG contrast);
// the choice survives a reload; the panel never covers the view controls.
// Usage: node scripts/browser-checks/workspace.mjs [screenshotDir]
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, expectations, launch, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "iarchitect-browser-checks", "shots");
mkdirSync(outDir, { recursive: true });
const APP = process.env.APP ?? "http://localhost:5174/";
const READY = `!!document.querySelector(".architect__input") && !!document.querySelector(".viewport-container canvas")`;
const b = await launch({ name: "workspace", width: 1440, height: 900, port: 9345, maxSeconds: 420 });
const { expect, finish } = expectations();
const log = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

await b.send("Network.enable");
await b.send("Network.setBlockedURLs", { urls: ["*onrender.com*", "*supabase.co*", "*fly.dev*", "*vercel.app*"] });

/** Mean luminance (0-255) of the open sky/ground part of the 3D viewport - real rendered pixels. */
async function viewportLuminance() {
  const rect = JSON.parse(await b.evaluate(`JSON.stringify(document.querySelector(".viewport-container").getBoundingClientRect())`));
  const clip = { x: Math.round(rect.x + rect.width * 0.55), y: Math.round(rect.y + rect.height * 0.12), width: Math.round(rect.width * 0.2), height: Math.round(rect.height * 0.12), scale: 1 };
  const { result } = await b.send("Page.captureScreenshot", { format: "png", clip });
  const image = decodePng(Buffer.from(result.data, "base64"));
  let sum = 0;
  let count = 0;
  for (let index = 0; index < image.data.length; index += image.bpp) {
    sum += 0.2126 * image.data[index] + 0.7152 * image.data[index + 1] + 0.0722 * image.data[index + 2];
    count += 1;
  }
  return Math.round(sum / count);
}

const REGIONS = [".app-header", ".app-mainnav", ".app-ribbon", ".sidebar--left", ".sidebar--right", ".architect", ".view-controls", ".command-bar", ".status-bar"];
/** Each region's own background (the first non-transparent one up its ancestors) and text colour. */
const readRegions = async () =>
  JSON.parse(
    await b.evaluate(`JSON.stringify(Object.fromEntries(${JSON.stringify(REGIONS)}.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      let node = element;
      let background = "rgba(0, 0, 0, 0)";
      while (node && /rgba\\(0, 0, 0, 0\\)|transparent/.test(background)) { background = getComputedStyle(node).backgroundColor; node = node.parentElement; }
      return [selector, { background, color: getComputedStyle(element).color }];
    })))`)
  );

const channels = (css) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const relative = ([r, g, bl]) => {
  const linear = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(bl);
};
const contrast = (a, b2) => {
  const [l1, l2] = [relative(channels(a)), relative(channels(b2))].sort((x, y) => y - x);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 10) / 10;
};
const themeNow = () => b.evaluate(`document.documentElement.dataset.theme`);
const toggleText = () => b.evaluate(`document.querySelector(".app-header__theme")?.textContent.trim() ?? ""`);

expect("app loaded", await b.goto(APP, READY));
await sleep(2500);
await b.evaluate(`(() => { const button = document.querySelector(".architect__collapse"); if (button && /Expand/.test(button.getAttribute("aria-label") ?? "")) button.click(); })()`);
await sleep(500);

// --- light, as a first visit gets it ---
expect("a first visit starts in the light theme", (await themeNow()) === "light", await themeNow());
expect("the toggle is in the top bar, labelled with what it switches to", /Dark/.test(await toggleText()), await toggleText());
const light = await readRegions();
const lightLuma = await viewportLuminance();
log("light regions", light);
log("light viewport luminance", lightLuma);
await b.shot(outDir, "w1-theme-light");

// --- one click: dark ---
await b.evaluate(`document.querySelector(".app-header__theme").click()`);
await sleep(1200);
expect("one click switches to dark", (await themeNow()) === "dark", await themeNow());
const dark = await readRegions();
const darkLuma = await viewportLuminance();
log("dark regions", dark);
log("dark viewport luminance", darkLuma);
await b.shot(outDir, "w2-theme-dark");
const unchanged = REGIONS.filter((selector) => !light[selector] || !dark[selector] || light[selector].background === dark[selector].background);
expect("every main region changes background (header, nav, ribbon, both sidebars, AI panel, view controls, command bar, status bar)", unchanged.length === 0, unchanged.join(", ") || "all changed");
expect("the 3D viewport itself goes dark (backdrop, ground and grid - not just the page)", darkLuma < lightLuma - 80, `${lightLuma} -> ${darkLuma}`);
for (const [name, regions] of [["light", light], ["dark", dark]]) {
  const weak = REGIONS.filter((selector) => regions[selector] && contrast(regions[selector].color, regions[selector].background) < 4.5).map((selector) => `${selector} ${contrast(regions[selector].color, regions[selector].background)}`);
  expect(`${name}: text on every main region is readable (contrast >= 4.5:1)`, weak.length === 0, weak.join(", ") || "all >= 4.5");
}
expect("the choice is saved", (await b.evaluate(`localStorage.getItem("iarchitect.theme")`)) === "dark");

// --- reload: still dark, from the first paint ---
// Recorded by a probe that runs before any page script: the theme when <body> is created -
// after <head>'s scripts, before anything is painted and before the app has started.
await b.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `new MutationObserver((records, observer) => { if (document.body) { window.__themeAtBody = { theme: document.documentElement.getAttribute("data-theme"), appStarted: !!document.querySelector(".app-shell") }; observer.disconnect(); } }).observe(document, { childList: true, subtree: true });`
});
await b.send("Page.reload", { ignoreCache: false });
await sleep(1500);
expect("reload: app ready", await b.waitFor(READY, 45000));
const early = JSON.parse(await b.evaluate(`JSON.stringify(window.__themeAtBody ?? null)`));
expect("reload: already dark when <body> is created - before the first paint and before the app starts", early?.theme === "dark" && early.appStarted === false, JSON.stringify(early));
await sleep(2000);
expect("reload: still dark, toggle offers Light", (await themeNow()) === "dark" && /Light/.test(await toggleText()), `${await themeNow()} / ${await toggleText()}`);
const reloadedLuma = await viewportLuminance();
expect("reload: the viewport is dark too", reloadedLuma < lightLuma - 80, String(reloadedLuma));

// --- no overlap in dark at common desktop widths ---
for (const width of [1280, 1366, 1440, 1920]) {
  await b.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await b.evaluate(`(() => { const button = document.querySelector(".architect__collapse"); if (button && /Expand/.test(button.getAttribute("aria-label") ?? "")) button.click(); })()`);
  await sleep(500);
  const layout = JSON.parse(
    await b.evaluate(`(() => {
      const box = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const panel = box(".architect");
      const controls = box(".viewport-area__controls");
      const inspector = box(".sidebar--right");
      const bottom = box(".command-bar");
      const hits = (a, c) => !!a && !!c && a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top;
      const perspective = [...document.querySelectorAll(".view-controls__button")].find((button) => button.textContent.trim() === "Perspective")?.getBoundingClientRect();
      const hit = perspective ? document.elementFromPoint(perspective.x + perspective.width / 2, perspective.y + perspective.height / 2) : null;
      const toggle = box(".app-header__theme");
      return JSON.stringify({ panelOverControls: hits(panel, controls), panelOverInspector: hits(panel, inspector), panelOverBottom: hits(panel, bottom), perspectiveClickable: hit?.textContent?.trim() === "Perspective", toggleVisible: !!toggle && toggle.width > 0 && toggle.right <= window.innerWidth });
    })()`)
  );
  expect(`${width} px (dark): the AI panel covers neither the view controls, the inspector nor the bottom panel; the theme toggle is visible`, !layout.panelOverControls && !layout.panelOverInspector && !layout.panelOverBottom && layout.perspectiveClickable && layout.toggleVisible, JSON.stringify(layout));
}
await b.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(800);

// --- and back ---
await b.evaluate(`document.querySelector(".app-header__theme").click()`);
await sleep(1000);
expect("one click back to light", (await themeNow()) === "light" && (await b.evaluate(`localStorage.getItem("iarchitect.theme")`)) === "light");
const back = await readRegions();
expect("light again matches the first light exactly", REGIONS.every((selector) => back[selector]?.background === light[selector]?.background), JSON.stringify(back[".app-header"]));
await b.shot(outDir, "w3-theme-light-again");

b.close();
finish();
