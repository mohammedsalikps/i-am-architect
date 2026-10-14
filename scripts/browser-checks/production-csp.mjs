// The PRODUCTION build under its own Content-Security-Policy (vite.config.ts),
// served locally by `vite preview` - the dev server has no CSP, so the other
// checks can't see a policy problem. Builds a furnished 3-bedroom house by
// conversation (the deterministic Architect - no backend involved) and fails
// on any CSP violation or blocked fetch: the furniture's glTF models are
// inlined as data: URLs, which a too-strict connect-src silently refused on
// the hosted site (every piece drew as its failure placeholder).
// Usage: npm run build && npx vite preview --port 5175 --strictPort
//        node scripts/browser-checks/production-csp.mjs [screenshotDir]
//   APP (default http://localhost:5175/)
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectations, launch, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "iarchitect-browser-checks", "shots");
mkdirSync(outDir, { recursive: true });
const APP = process.env.APP ?? "http://localhost:5175/";
const READY = `!!document.querySelector(".architect__input") && !!document.querySelector(".viewport-container canvas")`;
const b = await launch({ name: "csp", width: 1440, height: 900, port: 9349, maxSeconds: 300 });
const { expect, finish } = expectations();

const blocked = [];
await b.send("Log.enable");
await b.send("Runtime.enable");
b.on("Log.entryAdded", (p) => {
  if (/Content Security Policy|Fetch API cannot load/i.test(p.entry.text)) blocked.push(p.entry.text.slice(0, 140));
});
b.on("Runtime.consoleAPICalled", (p) => {
  const text = p.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
  if (/Content Security Policy|Failed to load asset|Fetch API cannot load/i.test(text)) blocked.push(text.slice(0, 140));
});
const say = async (text) => {
  const count = await b.evaluate(`document.querySelectorAll(".architect__msg--architect").length`);
  await b.evaluate(`(() => { const input = document.querySelector(".architect__input"); input.value = ${JSON.stringify(text)}; input.closest("form").requestSubmit(); })()`);
  await b.waitFor(`document.querySelectorAll(".architect__msg--architect").length > ${count}`, 30000);
  await sleep(800);
};

expect("the production build loads", await b.goto(APP, READY));
const csp = await b.evaluate(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ""`);
expect("it carries its Content-Security-Policy", /connect-src 'self' data: /.test(csp), csp.slice(0, 120));
for (const line of ["Set up a 30 x 20 m site", "Build a house", "3 bedrooms, 12 x 9 m", "Use the site centre", "Clear them and build here", "Build the rest of the house", "Brick"]) await say(line);
await say("Show me the living room");
await sleep(4000); // every furniture model loaded (or refused) by now
const furnished = await b.evaluate(`[...document.querySelectorAll(".architect__msg--architect")].some((msg) => /Interiors furnished/.test(msg.textContent))`);
expect("a furnished house was built", furnished);
expect("no CSP violation or blocked fetch - the furniture models loaded", blocked.length === 0, blocked.slice(0, 2).join(" | "));
await b.shot(outDir, "80-production-csp-furniture");

b.close();
finish();
