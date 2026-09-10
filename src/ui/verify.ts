/**
 * Layout-contract verification for the application shell - the handful
 * of CSS rules that keep the workspace inside the viewport, so that
 * selecting an object (and filling the Properties panel) can never push
 * the AI command bar or status bar below the fold. Same approach as
 * every other verify.ts in this project: no test framework, plain
 * assertion helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/ui/verify.ts
 *
 * Node has no DOM or layout engine, so these checks read styles.css and
 * layout.ts as source text and assert the structural rules the layout
 * depends on (which element is viewport-bound, which region scrolls,
 * which track flexes) - never pixel positions. Actual rendering at real
 * viewport sizes is verified in the browser as part of each milestone's
 * manual pass.
 */
// "node:fs"/"node:url" below are typed by src/node-builtins.d.ts, a
// minimal shared ambient shim - see that file's own header comment for
// why it exists instead of an @types/node dependency.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** `items[items.length - offset]` - Array.prototype.at() needs ES2022, and tsconfig.json targets ES2020. */
function fromEnd<T>(items: readonly T[], offset: number): T | undefined {
  return items[items.length - offset];
}

interface CssRule {
  /** The enclosing @media condition, or null for a top-level rule. */
  media: string | null;
  selectors: string[];
  declarations: [property: string, value: string][];
}

function parseDeclarations(body: string): [string, string][] {
  return body
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const colon = part.indexOf(":");
      return [part.slice(0, colon).trim(), part.slice(colon + 1).replace(/\s+/g, " ").trim()];
    });
}

/**
 * Just enough of a CSS parser for styles.css: comments stripped, plain
 * rules plus one level of @media nesting. Not a general-purpose parser -
 * it only needs to understand the file it's pointed at.
 */
function parseCss(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];

  function parseBlocks(chunk: string, media: string | null): void {
    let index = 0;
    while (index < chunk.length) {
      const open = chunk.indexOf("{", index);
      if (open === -1) {
        return;
      }
      const prelude = chunk.slice(index, open).trim();

      let depth = 1;
      let cursor = open + 1;
      while (cursor < chunk.length && depth > 0) {
        if (chunk[cursor] === "{") depth += 1;
        else if (chunk[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      const body = chunk.slice(open + 1, cursor - 1);

      if (prelude.startsWith("@media")) {
        parseBlocks(body, prelude.slice("@media".length).trim());
      } else {
        rules.push({
          media,
          selectors: prelude.split(",").map((selector) => selector.trim()),
          declarations: parseDeclarations(body)
        });
      }
      index = cursor;
    }
  }

  parseBlocks(text, null);
  return rules;
}

/** Every value declared for `property` on `selector` within one media context, in source order (the last one wins, as in the cascade). */
function valuesOf(rules: CssRule[], selector: string, property: string, media: string | null = null): string[] {
  return rules
    .filter((rule) => rule.media === media && rule.selectors.includes(selector))
    .flatMap((rule) => rule.declarations.filter(([name]) => name === property).map(([, value]) => value));
}

function lastValueOf(rules: CssRule[], selector: string, property: string, media: string | null = null): string | undefined {
  return fromEnd(valuesOf(rules, selector, property, media), 1);
}

/** Splits a grid track list on top-level whitespace, keeping "minmax(360px, 1fr)" as one track. */
function splitTracks(value: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) tracks.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tracks.push(current);
  return tracks;
}

function run(): void {
  let passed = 0;
  let failed = 0;

  function check(name: string, fn: () => void): void {
    try {
      fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(error);
    }
  }

  const rules = parseCss(readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8"));
  const layoutSource = readFileSync(fileURLToPath(new URL("./layout.ts", import.meta.url)), "utf8");

  const shellTracks = splitTracks(lastValueOf(rules, ".app-shell", "grid-template-rows") ?? "");
  const shellChildrenMatch = layoutSource.match(/el\("div",\s*\{\s*className:\s*"app-shell"\s*\},\s*\[([\s\S]*?)\]\)/);
  const shellChildren = (shellChildrenMatch?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  console.log("Workspace layout verification\n");

  // --- The shell is bound to the viewport ---

  check(".app-shell is exactly one viewport tall (height, not min-height)", () => {
    const heights = valuesOf(rules, ".app-shell", "height");
    assertEqual(fromEnd(heights, 1), "100dvh", "final .app-shell height");
    assertTrue(heights.includes("100vh"), ".app-shell should keep a 100vh fallback for browsers without dvh");
    assertEqual(valuesOf(rules, ".app-shell", "min-height").length, 0, ".app-shell min-height declarations");
  });

  check("no media query lets .app-shell grow past the viewport again", () => {
    const overrides = rules.filter(
      (rule) =>
        rule.media !== null &&
        rule.selectors.includes(".app-shell") &&
        rule.declarations.some(([name]) => name === "height" || name === "min-height")
    );
    assertEqual(overrides.length, 0, "media-query rules overriding .app-shell height/min-height");
  });

  // --- Grid rows: fixed chrome, one flexible body row ---

  check("layout.ts mounts one shell child per grid row, body in the only flexible track", () => {
    assertTrue(shellChildrenMatch, 'could not find the el("div", { className: "app-shell" }, [...]) call in layout.ts');
    assertEqual(shellChildren.length, shellTracks.length, "shell children vs .app-shell grid rows");

    const flexibleTracks = shellTracks.filter((track) => track.includes("fr"));
    assertEqual(flexibleTracks.length, 1, "number of flexible (fr) shell rows");
    assertEqual(shellTracks.indexOf(flexibleTracks[0]), shellChildren.indexOf("body"), "flexible row index vs body index");
    assertTrue(/^minmax\([^,]+,\s*1fr\)$/.test(flexibleTracks[0]), `body row should be minmax(<floor>, 1fr), got "${flexibleTracks[0]}"`);
  });

  check("the command bar and status bar are the last two shell rows, both fixed-height", () => {
    assertEqual(fromEnd(shellChildren, 2), "commandBar", "second-to-last shell child");
    assertEqual(fromEnd(shellChildren, 1), "statusBar", "last shell child");
    for (const track of shellTracks.slice(-2)) {
      assertTrue(/^var\(--[a-z-]+\)$/.test(track), `bottom rows should use a fixed-height variable, got "${track}"`);
    }
  });

  // --- Tall content scrolls inside its own region ---

  check(".app-body caps its row at the body track instead of sizing to sidebar content", () => {
    assertEqual(lastValueOf(rules, ".app-body", "grid-template-rows"), "minmax(0, 1fr)", ".app-body grid-template-rows");
    assertEqual(lastValueOf(rules, ".app-body", "min-height"), "0", ".app-body min-height");
  });

  check("both sidebars can shrink to the body row, and their tab panels scroll internally", () => {
    assertEqual(lastValueOf(rules, ".sidebar--left", "min-height"), "0", ".sidebar--left min-height");
    assertEqual(lastValueOf(rules, ".sidebar--right", "min-height"), "0", ".sidebar--right min-height");
    assertEqual(lastValueOf(rules, ".sidebar--right", "display"), "flex", ".sidebar--right display");
    assertEqual(lastValueOf(rules, ".sidebar--right", "flex-direction"), "column", ".sidebar--right flex-direction");
    assertEqual(lastValueOf(rules, ".tab-strip__panel", "overflow-y"), "auto", ".tab-strip__panel overflow-y");
    assertEqual(lastValueOf(rules, ".tab-strip__panel", "min-height"), "0", ".tab-strip__panel min-height");
    assertEqual(lastValueOf(rules, ".tab-strip__panel", "flex"), "1", ".tab-strip__panel flex");
  });

  check("the 3D viewport can shrink with its track (the renderer's pixel-sized canvas can't hold it open)", () => {
    assertEqual(lastValueOf(rules, ".viewport-area", "min-height"), "0", ".viewport-area min-height");
    assertEqual(lastValueOf(rules, ".viewport-area", "min-width"), "0", ".viewport-area min-width");
    assertEqual(lastValueOf(rules, ".viewport-container", "height"), "100%", ".viewport-container height");
  });

  check("the command bar fits its fixed row, its tab panel scrolling if its content is taller", () => {
    assertEqual(lastValueOf(rules, ".command-bar", "min-height"), "0", ".command-bar min-height");
    assertEqual(lastValueOf(rules, ".command-bar", "display"), "flex", ".command-bar display");
    assertEqual(lastValueOf(rules, ".command-bar", "flex-direction"), "column", ".command-bar flex-direction");
  });

  // --- Narrow (stacked) layout ---

  check("in the stacked narrow layout, .app-body itself is the scroll container", () => {
    const stackedMedia = rules.find(
      (rule) =>
        rule.media !== null &&
        rule.selectors.includes(".app-body") &&
        rule.declarations.some(([name, value]) => name === "display" && value === "flex")
    )?.media;
    assertTrue(stackedMedia, "expected a media query that stacks .app-body with display: flex");
    assertEqual(lastValueOf(rules, ".app-body", "overflow-y", stackedMedia), "auto", "stacked .app-body overflow-y");
    assertEqual(lastValueOf(rules, ".app-body", "min-height", stackedMedia), "0", "stacked .app-body min-height");
    // Inside a scrolling column every child is content-sized, so the
    // viewport needs its own definite height or it would collapse to 0.
    assertTrue(lastValueOf(rules, ".viewport-area", "height", stackedMedia), "stacked .viewport-area needs a definite height");
    assertEqual(lastValueOf(rules, ".viewport-area", "flex-shrink", stackedMedia), "0", "stacked .viewport-area flex-shrink");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
