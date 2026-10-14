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
// Explicit .ts extension: Node runs this file directly (see above).
import { SPLASH_HOLD_MS, SPLASH_REDUCED_HOLD_MS, splashRemainingMs } from "./splash.ts";
import { createHandsFree, isEchoOf, matchSpokenChoice, shortSpoken, spokenNumbers, spokenReply, stripContinuation, wordsAfter } from "./handsFree.ts";
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_KEY, chooseVoice, readVoiceSettings, saveVoiceSettings } from "./voiceSettings.ts";
import { createTurnController } from "./turnController.ts";
import type { HandsFreeStatus } from "./handsFree.ts";
import { COMPANION_STATE_LABEL, COPILOT_STEPS, INITIAL_COPILOT_STATE, companionStateOf, createInputGate, nextCopilotState, stepStatuses } from "./copilotState.ts";
import type { CopilotEvent } from "./copilotState.ts";
import { rmsLevel } from "./levelMeter.ts";
import { createVoiceInput } from "./voiceInput.ts";
import { searchProjectItems } from "./projectSearch.ts";
import { THEME_STORAGE_KEY, createThemeStore, readSavedTheme, themeToggleLabel } from "./theme.ts";
import type { Theme } from "./theme.ts";
import { SCENE_PALETTES } from "../scene/sceneTheme.ts";
import { DEFAULT_WORKSPACE, WORKSPACE_KEY, WorkspaceSettings, formatSpacing, readWorkspace } from "../engine/workspace/workspaceSettings.ts";
import { dimensionSummary, formatLength, plotEdgeText, roomDimensionText, wallDimensionText } from "../engine/workspace/dimensions.ts";
import { metresPerPixelAt, scaleBarFor } from "../engine/workspace/scaleBar.ts";
import { GROUND_SIZE, MAJOR_GRID_SPACING, minorGrid } from "../scene/ground.ts";

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
    // commandBar is now { element, focusAiInput } (see CommandBar in commandBar.ts,
    // the same shape statusBar already has below) - the mounted child is its .element.
    assertEqual(fromEnd(shellChildren, 2), "commandBar.element", "second-to-last shell child");
    // statusBar is { element, setPlacementStatus } (see StatusBar in statusBar.ts) - the mounted child is its .element.
    assertEqual(fromEnd(shellChildren, 1), "statusBar.element", "last shell child");
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

  // --- The Eavara startup screen (index.html + splash.ts) ---

  const indexHtml = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
  const mainSource = readFileSync(fileURLToPath(new URL("../main.ts", import.meta.url)), "utf8");
  const splashStart = indexHtml.indexOf('id="eavara-splash"');
  const appStart = indexHtml.indexOf('<div id="app">');
  const splashMarkup = indexHtml.slice(splashStart, appStart);
  const pageRules = parseCss(indexHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "");
  const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

  check("the startup screen is static markup in index.html, before #app - painted on the first frame, before any script", () => {
    assertTrue(splashStart > 0 && appStart > splashStart, "the #eavara-splash markup must come before <div id=\"app\">");
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assertTrue(scripts.length > 0, "index.html loads the app");
    for (const [, attributes, body] of scripts) {
      assertTrue(/\bsrc=/.test(attributes) && body.trim() === "", "no inline script - the production Content-Security-Policy allows none");
    }
  });

  check("it reads EAVARA - THE SCHOOL OF ARCHITECTURE, never the old \"Eavara Estates\"", () => {
    assertTrue(splashMarkup.includes('aria-label="EAVARA"'), "the wordmark is labelled EAVARA");
    assertTrue(splashMarkup.includes("THE SCHOOL OF ARCHITECTURE"), "the tagline");
    assertTrue(!/estates/i.test(indexHtml), "\"Estates\" must not appear anywhere in index.html");
  });

  check("it is decorative and can't take focus: aria-hidden, nothing focusable, SVGs not focusable", () => {
    assertTrue(/id="eavara-splash"[^>]*aria-hidden="true"/.test(splashMarkup), "#eavara-splash is aria-hidden");
    assertTrue(!/<(a|button|input|select|textarea)\b|tabindex=/i.test(splashMarkup), "no focusable element inside the startup screen");
    const svgs = splashMarkup.match(/<svg\b[^>]*>/g) ?? [];
    assertTrue(svgs.length > 0 && svgs.every((svg) => svg.includes('focusable="false"')), "every SVG is focusable=\"false\"");
  });

  check("it sits above every dialog, never makes the page scroll, and hides itself if the app never starts", () => {
    assertTrue(Number(lastValueOf(pageRules, ".eavara-splash", "z-index")) > 110, "above the auth dialog (z-index 110)");
    assertEqual(lastValueOf(pageRules, ".eavara-splash", "position"), "fixed", ".eavara-splash position");
    assertEqual(lastValueOf(pageRules, ".eavara-splash", "overflow"), "hidden", ".eavara-splash overflow");
    const failsafe = lastValueOf(pageRules, ".eavara-splash", "animation") ?? "";
    assertTrue(failsafe.includes("eavara-failsafe") && failsafe.includes("8s") && failsafe.includes("forwards"), `a CSS failsafe, got "${failsafe}"`);
  });

  check("prefers-reduced-motion turns every startup animation off", () => {
    const animated = [
      ".eavara-splash__guides",
      ".eavara-splash__guides line",
      ".eavara-splash__build",
      ".eavara-splash__ridge",
      ".eavara-splash__pine",
      ".eavara-splash__rule",
      ".eavara-splash__tagline-text"
    ];
    for (const selector of animated) {
      assertTrue(lastValueOf(pageRules, selector, "animation") !== undefined, `${selector} is animated normally`);
      assertEqual(lastValueOf(pageRules, selector, "animation", REDUCED_MOTION), "none", `${selector} with reduced motion`);
    }
    assertEqual(lastValueOf(pageRules, ".eavara-splash", "transition", REDUCED_MOTION), "none", "no fade with reduced motion");
  });

  check("the app releases the startup screen only once the workspace is running, and the hold counts from page load", () => {
    assertTrue(mainSource.includes('import { releaseSplash } from "./ui/splash";'), "main.ts imports releaseSplash");
    const release = mainSource.indexOf("releaseSplash();");
    assertTrue(release > mainSource.indexOf("sceneManager.current.start();"), "released after the 3D workspace starts");
    assertTrue(SPLASH_HOLD_MS >= 1500 && SPLASH_HOLD_MS <= 2000, `the animated screen stays 1.5-2 s, got ${SPLASH_HOLD_MS} ms`);
    assertTrue(SPLASH_REDUCED_HOLD_MS <= 500, "the reduced-motion screen is brief");
    assertEqual(splashRemainingMs(0, false), SPLASH_HOLD_MS, "a fresh page waits the whole hold");
    assertEqual(splashRemainingMs(700, false), SPLASH_HOLD_MS - 700, "time already spent loading counts");
    assertEqual(splashRemainingMs(5000, false), 0, "a slow start never adds waiting");
    assertEqual(splashRemainingMs(0, true), SPLASH_REDUCED_HOLD_MS, "reduced motion: the short hold");
    assertEqual(splashRemainingMs(-10, false), SPLASH_HOLD_MS, "never more than the hold");
  });

  // --- Hosting headers (vercel.json): the deployed site's Permissions-Policy gates voice input ---

  const vercelConfig = JSON.parse(readFileSync(fileURLToPath(new URL("../../vercel.json", import.meta.url)), "utf8")) as {
    headers?: { source: string; headers: { key: string; value: string }[] }[];
    ignoreCommand?: string;
  };

  check("the production CSP lets the inlined furniture models load (data:) and names no other network origin than the backend", () => {
    const viteConfig = readFileSync(fileURLToPath(new URL("../../vite.config.ts", import.meta.url)), "utf8");
    const connect = /`connect-src ('self'[^`]*)`/.exec(viteConfig)?.[1] ?? "";
    assertEqual(connect, "'self' data: ${backendOrigin}", "connect-src: the page itself, its own data: URLs (glTF models and their buffers), and the backend");
    assertTrue(!/\*|https?:(?!\/\/)/.test(connect), "no wildcard or scheme-wide source");
  });

  check("the companion's header: a request waiting on the sign-in dialog says Waiting, never Thinking - and nothing else changes", () => {
    const base = { speaking: false, listening: false, busy: false, waitingForSignIn: false, stopped: false, applied: false };
    const label = (now: Partial<typeof base>) => COMPANION_STATE_LABEL[companionStateOf({ ...base, ...now })];
    assertEqual(label({ busy: true }), "Thinking", "a turn with the model: Thinking");
    assertEqual(label({ busy: true, waitingForSignIn: true }), "Waiting", "the same turn while the sign-in dialog waits: Waiting");
    assertEqual(label({ waitingForSignIn: true }), "Ready", "no turn under way: the flag alone changes nothing");
    assertEqual(label({ speaking: true, busy: true, waitingForSignIn: true }), "Speaking", "speech still comes first");
    assertEqual(label({ listening: true }), "Listening", "listening");
    assertEqual(label({ stopped: true }), "Stopped", "stopped");
    assertEqual(label({ applied: true }), "Applied", "applied");
    assertEqual(label({}), "Ready", "ready");
    assertTrue(/architectPanel\.setWaitingForSignIn\(true\);\s*try \{\s*await authDialog\.open\("Sign in to use the AI assistant for this request\."\);\s*\} finally \{\s*architectPanel\.setWaitingForSignIn\(false\);/.test(mainSource), "main.ts sets it around the sign-in dialog and always clears it");
  });

  check("a [backend-first] release skips only the frontend build, and the skip fails open", () => {
    assertEqual(vercelConfig.ignoreCommand, "node scripts/vercel-ignore-build.mjs", "Vercel's ignored-build step runs the release script");
    const script = readFileSync(fileURLToPath(new URL("../../scripts/vercel-ignore-build.mjs", import.meta.url)), "utf8");
    assertTrue(/const MARKER = "\[backend-first\]";/.test(script), "it looks for the [backend-first] marker");
    assertTrue(/const subject = commitMessage\(\)\.split\("\\n"\)\[0\];\s*if \(subject\.includes\(MARKER\)\) \{[\s\S]*?process\.exit\(0\);[\s\S]*?\}\s*console\.log\("Building the frontend\."\);\s*process\.exit\(1\);/.test(script), "skips (exit 0) only with the marker in the subject line; otherwise builds (exit 1)");
    assertTrue(/catch \{\s*return "";\s*\}/.test(script), "no commit message to read: it builds");
  });
  const permissionsPolicies = (vercelConfig.headers ?? [])
    .filter((entry) => entry.source === "/(.*)")
    .flatMap((entry) => entry.headers)
    .filter((header) => header.key.toLowerCase() === "permissions-policy")
    .map((header) => header.value);
  const policy = new Map(
    permissionsPolicies
      .flatMap((value) => value.split(","))
      .map((directive) => directive.trim())
      .filter((directive) => directive.length > 0)
      .map((directive): [string, string] => [directive.slice(0, directive.indexOf("=")).trim(), directive.slice(directive.indexOf("=") + 1).trim()])
  );
  const sourceOf = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  check("Interior Explore is a view only: its modules never reach the model's commands or stores, and every way out restores the exterior", () => {
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const path of ["../engine/interior/interiorExplore.ts", "../scene/interior/InteriorCamera.ts", "./interiorNavigator.ts"]) {
      const code = strip(sourceOf(path));
      assertTrue(!/commandExecutor|\.execute\(|history\.|Store\.(add|update|remove|delete)\(/.test(code), `${path} never edits the model`);
    }
    assertTrue(/viewportOverlays: \[[^\]]*interiorExplore\.element\]/.test(mainSource), "the Interior Explore button and its room navigator: one overlay over the viewport");
    assertTrue(!/interior/i.test(sourceOf("./layout.ts")), "not a button in the view-preset row - that row keeps its width beside the companion");
    for (const exit of ["onViewChange: \\(preset\\) => \\{\\s*interiorExplore\\.exit\\(\\);", "onFitToScene: \\(\\) => \\{\\s*interiorExplore\\.exit\\(\\);", "onFocusSelected: \\(\\) => \\{\\s*interiorExplore\\.exit\\(\\);", "onNewProject: \\(\\) => \\{\\s*interiorExplore\\.exit\\(\\);", "state\\.status === \"opened\"\\) \\{\\s*interiorExplore\\.exit\\(\\);"]) {
      assertTrue(new RegExp(exit).test(mainSource), `leaves Interior Explore first: ${exit.split(":")[0].replace(/\\/g, "")}`);
    }
    const scene = sourceOf("../scene/SceneManager.ts");
    assertTrue((scene.match(/if \(this\.interior\) return; \/\/ Interior Explore holds the camera/g) ?? []).length === 5, "setView, fitToScene and the three focus moves leave the camera in its room");
    assertTrue(/this\.selectionRaycaster\.setEnabled\(false\);\s*this\.manipulation\.setEnabled\(false\);/.test(scene) && /this\.selectionRaycaster\.setEnabled\(true\);\s*this\.manipulation\.setEnabled\(true\);/.test(scene), "picking and dragging pause inside and resume on leaving");
  });

  check("the deployed site lets its own pages use the microphone - microphone=() would block the Architect's voice input", () => {
    assertEqual(permissionsPolicies.length, 1, "exactly one Permissions-Policy header, applied to every path");
    assertEqual(policy.get("microphone"), "(self)", "microphone=(self): this origin only, never embedded or third-party frames");
  });

  check("camera and geolocation stay disabled, and no allowlist uses a wildcard", () => {
    assertEqual(policy.get("camera"), "()", "camera=()");
    assertEqual(policy.get("geolocation"), "()", "geolocation=()");
    assertTrue(![...policy.values()].some((allowlist) => allowlist.includes("*")), "no * allowlist");
    // If the app ever starts using these, the policy above must change with it.
    const appSources = [sourceOf("./architectPanel.ts"), sourceOf("./voiceInput.ts"), mainSource];
    assertTrue(!appSources.some((source) => /getUserMedia|navigator\.geolocation/.test(source)), "nothing in the app asks for the camera or location");
  });

  check("the voice path is wired: the Architect panel's mic comes from voiceInput.ts, and main.ts mounts the panel", () => {
    const panel = sourceOf("./architectPanel.ts");
    assertTrue(/import \{ createVoiceInput \} from "\.\/voiceInput"/.test(panel) && panel.includes("createVoiceInput({"), "the panel builds its voice input");
    assertTrue(panel.includes("architect__mic"), "and shows a mic button");
    assertTrue(mainSource.includes("createArchitectPanel({") && mainSource.includes("architect: architectPanel"), "main.ts creates the panel and hands it to the shell");
  });

  // --- Install (PWA) basics: what the deployed site already declares ---

  check("the web app manifest is linked and declares what install needs: names, start URL, standalone display, 192 and 512 px icons", () => {
    assertTrue(/<link rel="manifest" href="\/manifest\.webmanifest"/.test(indexHtml), "index.html links the manifest");
    assertTrue(/<meta name="viewport" content="width=device-width, initial-scale=1(\.0)?"/.test(indexHtml), "a mobile viewport");
    const manifest = JSON.parse(sourceOf("../../public/manifest.webmanifest")) as Record<string, unknown> & { icons?: { src: string; sizes: string; type: string }[] };
    for (const field of ["name", "short_name", "start_url", "background_color", "theme_color"]) {
      assertTrue(typeof manifest[field] === "string" && (manifest[field] as string).length > 0, `manifest ${field}`);
    }
    assertEqual(manifest.display, "standalone", "display");
    for (const size of [192, 512]) {
      const icon = (manifest.icons ?? []).find((entry) => entry.sizes === `${size}x${size}` && entry.type === "image/png");
      assertTrue(icon, `a ${size}x${size} PNG icon`);
      // The file's own PNG header must agree with the size the manifest declares.
      const png = readFileSync(fileURLToPath(new URL(`../../public${icon.src}`, import.meta.url)));
      assertEqual(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, `${size}x${size}`, `${icon.src} pixel size`);
    }
  });

  // --- Hands-free voice (handsFree.ts): spoken questions and choices, the mic reopened after each answer ---

  type Spoken = { text: string; choices: { label: string; say: string }[] };
  const fakeListener = (supported = true) => {
    const log: string[] = [];
    return { log, listener: { supported, start: () => void log.push("start"), stop: () => void log.push("stop"), cancel: () => void log.push("cancel") } };
  };
  const fakeSpeech = () => {
    const spoken: string[] = [];
    let pending: (() => void) | null = null;
    let cancelled = 0;
    return {
      spoken,
      finish: () => {
        const done = pending;
        pending = null;
        done?.();
      },
      cancelled: () => cancelled,
      output: {
        speak: (text: string, onDone: () => void) => {
          spoken.push(text);
          pending = onDone;
        },
        cancel: () => {
          cancelled += 1;
        }
      }
    };
  };
  const materialQuestion: Spoken = {
    text: "What should the wall be built of? Brick, Concrete block, Stone masonry.",
    choices: [
      { label: "Brick", say: "brick" },
      { label: "Concrete block", say: "concrete block" },
      { label: "Stone masonry", say: "stone masonry" },
      { label: "Cancel", say: "cancel" }
    ]
  };

  check("hands-free: a reply is spoken without emoji, with units in words and its choices read out", () => {
    const text = spokenReply({
      text: "Ready to build a 5 m long, 230 mm thick brick wall, centred at (2, 3) - 3.105 m³ of masonry. Build it?",
      choices: [
        { label: "Build it", say: "yes" },
        { label: "📍 Pick another spot", say: "pick a location" },
        { label: "Cancel", say: "cancel" }
      ]
    });
    assertTrue(text.includes("5 metres long") && text.includes("230 millimetres thick") && text.includes("3.105 cubic metres"), text);
    assertTrue(text.endsWith("You can say: Build it, Pick another spot, or Cancel."), text);
    assertTrue(!/\p{Extended_Pictographic}/u.test(text), "no emoji read aloud");
  });

  check("hands-free: a spoken answer picks the offered choice it names; anything else is sent as said", () => {
    assertEqual(matchSpokenChoice("Concrete block", materialQuestion.choices)?.say, "concrete block", "exact");
    assertEqual(matchSpokenChoice("concrete", materialQuestion.choices)?.say, "concrete block", "the only choice it starts");
    assertEqual(matchSpokenChoice("stone", materialQuestion.choices)?.say, "stone masonry", "stone");
    const direction = [
      { label: "East–west (along X)", say: "east-west" },
      { label: "North–south (along Z)", say: "north-south" }
    ];
    assertEqual(matchSpokenChoice("east west", direction)?.say, "east-west", "dashes and brackets don't matter");
    assertEqual(matchSpokenChoice("3 m", [{ label: "3 m", say: "3 m" }, { label: "4 m", say: "4 m" }])?.say, "3 m", "a size choice");
    assertEqual(matchSpokenChoice("yes", [{ label: "Build it", say: "yes" }, { label: "Cancel", say: "cancel" }]), null, "not a label: sent as said (the architect understands 'yes')");
    assertEqual(matchSpokenChoice("a 5 metre wall at 2 3", materialQuestion.choices), null, "a new instruction is never squeezed into a choice");
  });

  check("hands-free: each question is read out, then the microphone opens - and again after every reply", () => {
    const speech = fakeSpeech();
    const { log, listener } = fakeListener();
    const statuses: string[] = [];
    const handsFree = createHandsFree({ speech: speech.output, listener, onStatus: (status) => statuses.push(status.kind) });
    assertTrue(handsFree.enableWith(materialQuestion), "turned on");
    assertTrue(speech.spoken[0].startsWith("Hands-free is on.") && speech.spoken[0].includes("What should the wall be built of?"), "reads the waiting question");
    assertTrue(!log.includes("start"), "the mic stays shut while speaking - it mustn't hear itself");
    speech.finish();
    assertEqual(log[log.length - 1], "start", "then listens");
    handsFree.heard();
    handsFree.replied({ text: "How long should the wall be, in metres?", choices: [{ label: "3 m", say: "3 m" }] });
    assertEqual(log[log.length - 1], "stop", "a new reply first closes the mic");
    assertEqual(speech.spoken[1], "How long should the wall be, in metres? You can say: 3 metres.", "reads the next question");
    speech.finish();
    assertEqual(log[log.length - 1], "start", "and listens for that answer");
    assertEqual(statuses.join(" "), "speaking listening speaking listening", "speaking, then listening, each turn");
  });

  check("hands-free: silence gets one more listen, then pauses and says so - it never listens forever", () => {
    const { log, listener } = fakeListener();
    const seen: HandsFreeStatus[] = [];
    const last = (): HandsFreeStatus => seen[seen.length - 1] ?? { kind: "off" };
    const handsFree = createHandsFree({ speech: null, listener, onStatus: (status) => void seen.push(status) });
    handsFree.enableWith(materialQuestion);
    const starts = () => log.filter((entry) => entry === "start").length;
    assertEqual(starts(), 1, "listening (no speech output: straight to the mic)");
    handsFree.listenerError("no-speech", "I didn't hear anything — try again.");
    assertEqual(starts(), 1, "doesn't restart until that session has ended");
    handsFree.listenerEnded();
    assertEqual(starts(), 2, "listens once more");
    handsFree.listenerEnded();
    assertEqual(handsFree.enabled, false, "a second silent turn pauses it");
    const paused = last();
    assertTrue(paused.kind === "stopped" && paused.message.includes("hands-free is paused"), "and says so");
  });

  check("hands-free: a blocked microphone turns it off with the reason; afterwards nothing is spoken or heard", () => {
    const speech = fakeSpeech();
    const { log, listener } = fakeListener();
    const seen: HandsFreeStatus[] = [];
    const last = (): HandsFreeStatus => seen[seen.length - 1] ?? { kind: "off" };
    const handsFree = createHandsFree({ speech: speech.output, listener, onStatus: (status) => void seen.push(status) });
    handsFree.enableWith(null);
    speech.finish();
    handsFree.listenerError("not-allowed", "Microphone access was blocked. Allow it in the browser's site settings to speak commands.");
    assertEqual(handsFree.enabled, false, "off");
    const blocked = last();
    assertTrue(blocked.kind === "stopped" && blocked.message.includes("Microphone access was blocked") && blocked.message.includes("type your answer instead"), "the honest reason, and the text fallback");
    const spokenBefore = speech.spoken.length;
    const startsBefore = log.filter((entry) => entry === "start").length;
    handsFree.replied(materialQuestion);
    assertEqual(speech.spoken.length, spokenBefore, "nothing more is spoken");
    assertEqual(log.filter((entry) => entry === "start").length, startsBefore, "and the mic isn't reopened");
  });

  check("hands-free: without speech recognition it can't be turned on (and says why); turning it off cancels speech and keeps the mic shut", () => {
    const unsupported = createHandsFree({ speech: fakeSpeech().output, listener: fakeListener(false).listener, onStatus: () => undefined });
    assertEqual(unsupported.enableWith(materialQuestion), false, "refused");
    assertEqual(unsupported.enabled, false, "still off");

    const speech = fakeSpeech();
    const { log, listener } = fakeListener();
    const handsFree = createHandsFree({ speech: speech.output, listener, onStatus: () => undefined });
    handsFree.enableWith(materialQuestion);
    handsFree.setEnabled(false);
    assertTrue(speech.cancelled() > 0 && log[log.length - 1] === "cancel", "speech cancelled, mic closed - and anything half-heard dropped, not sent");
    speech.finish();
    assertTrue(!log.includes("start"), "a late “finished speaking” never reopens the mic");
  });

  // --- Copilot interaction state (copilotState.ts), level (levelMeter.ts), interruption (handsFree.ts) ---

  check("copilot: listening → transcribing → understanding → clarifying / previewing / applied, from what really happened", () => {
    let state = INITIAL_COPILOT_STATE;
    const step = (event: CopilotEvent) => (state = nextCopilotState(state, event));
    step({ type: "listening" });
    assertEqual(state.phase, "listening", "listening");
    step({ type: "interim", text: "add a brick" });
    assertEqual(`${state.phase} | ${state.transcript}`, "transcribing | add a brick", "the live words, not sent yet");
    step({ type: "heard", text: "add a brick wall" });
    step({ type: "sent", text: "add a brick wall" });
    assertEqual(state.phase, "understanding", "sent");
    step({ type: "reply", reply: { tone: "question" } });
    assertEqual(state.phase, "clarifying", "a question");
    step({ type: "reply", reply: { tone: "question", preview: true } });
    assertEqual(state.phase, "previewing", "a change laid out");
    assertTrue(state.detail.includes("nothing is built"), "and says nothing is built yet");
    step({ type: "reply", reply: { tone: "success" } });
    assertEqual(state.phase, "idle", "a success that changed nothing is NOT shown as applied");
    step({ type: "reply", reply: { tone: "success", applied: true } });
    assertEqual(state.phase, "applied", "only a measured scene change is applied");
    step({ type: "reply", reply: { tone: "error" } });
    assertEqual(`${state.phase} | ${state.detail}`, "error | Nothing was changed.", "errors say nothing changed");
    step({ type: "voice-error", message: "Microphone access was blocked." });
    assertEqual(`${state.phase} | ${state.detail}`, "error | Microphone access was blocked.", "voice errors are shown");
  });

  check("project search: every word must match a name, id, material or room; an exact id first; empty finds nothing", () => {
    const items = [
      { id: "room-1", label: "Kitchen — 20 m²", detail: "room" },
      { id: "wall-2", label: "Wall", detail: "brick in Kitchen" },
      { id: "wall-3", label: "Wall", detail: "concrete-block in Kitchen" },
      { id: "wall-12", label: "Wall", detail: "brick" },
      { id: "door-1", label: "Door in wall-2", detail: "in Kitchen" }
    ];
    const ids = (query: string) => searchProjectItems(items, query).map((item) => item.id).join(" ");
    assertEqual(ids("kitchen"), "room-1 wall-2 wall-3 door-1", "the room and everything standing in it");
    assertEqual(ids("brick kitchen"), "wall-2", "every word must match, in any order");
    assertEqual(ids("BRICK"), "wall-2 wall-12", "case-insensitive, by material");
    assertEqual(ids("wall-2"), "wall-2 door-1", "an exact id first, then what mentions it (the door in it)");
    assertEqual(ids("garage"), "", "no match");
    assertEqual(ids("   "), "", "an empty search lists nothing (the tree shows instead)");
  });

  check("copilot stepper: a step is done only if it really happened - typed input skips Listening, no question skips Clarifying", () => {
    const run = (events: CopilotEvent[]) => events.reduce((state, event) => nextCopilotState(state, event), INITIAL_COPILOT_STATE);
    const typedToPreview = run([{ type: "sent", text: "add a 5 m brick wall at 2, 3 east-west 2.7 m high 230 mm thick" }, { type: "reply", reply: { tone: "question", preview: true } }]);
    assertEqual(stepStatuses(typedToPreview).join(" "), "skipped done skipped active todo", "typed, straight to a preview: no Listening, no Clarifying");
    const typedApplied = nextCopilotState(typedToPreview, { type: "reply", reply: { tone: "success", applied: true } });
    assertEqual(stepStatuses(typedApplied).join(" "), "skipped done skipped done done", "applied without any question asked");
    const spokenClarified = run([
      { type: "listening" },
      { type: "heard", text: "add a wall" },
      { type: "sent", text: "add a wall" },
      { type: "reply", reply: { tone: "question" } },
      { type: "sent", text: "brick" },
      { type: "reply", reply: { tone: "question", preview: true } }
    ]);
    assertEqual(stepStatuses(spokenClarified).join(" "), "done done done active todo", "spoken, asked, then previewed: every step really happened");
    const nextTask = nextCopilotState(nextCopilotState(spokenClarified, { type: "reply", reply: { tone: "success", applied: true } }), { type: "sent", text: "move it 2 m east" });
    assertEqual(stepStatuses(nextTask).join(" "), "skipped active todo todo todo", "a new typed instruction after Applied starts a fresh task");
    assertEqual(stepStatuses(INITIAL_COPILOT_STATE).join(" "), "todo todo todo todo todo", "idle");
    const undone = run([{ type: "sent", text: "undo" }, { type: "reply", reply: { tone: "success", applied: true, undone: true } }]);
    assertEqual(undone.detail, "Undone - the last change was reversed.", "an undo is reported as an undo, not as a new change applied");
    assertEqual(COPILOT_STEPS.map((stepEntry) => stepEntry.label).join(" → "), "Listening → Understanding → Clarifying → Previewing → Applied", "labels");
  });

  check("copilot input: a repeated final phrase is dropped; while busy only the latest new instruction waits its turn", () => {
    const gate = createInputGate(2500);
    assertEqual(gate.admit("Add a wall", false, 1000), "send", "first");
    assertEqual(gate.admit("add a wall ", false, 1500), "duplicate", "the same words again within 2.5 s (recognition double-fire)");
    assertEqual(gate.admit("brick", true, 1600), "queued", "busy: kept");
    assertEqual(gate.admit("stone masonry", true, 1700), "queued", "a newer instruction replaces it");
    assertEqual(gate.takeQueued(), "stone masonry", "the latest wins");
    assertEqual(gate.takeQueued(), null, "taken once");
    assertEqual(gate.admit("Add a wall", false, 5000), "send", "the same words later are a new instruction");
  });

  check("level meter: RMS of real samples - silence is 0, speech-level signal reads clearly, never above 1", () => {
    assertEqual(rmsLevel([]), 0, "no samples");
    assertEqual(rmsLevel(new Float32Array(512)), 0, "silence");
    const tone = Float32Array.from({ length: 512 }, (_, index) => 0.1 * Math.sin(index / 4));
    const level = rmsLevel(tone);
    assertTrue(level > 0.2 && level < 0.4, `a moderate signal: ${level}`);
    assertEqual(rmsLevel(Float32Array.from({ length: 64 }, () => 1)), 1, "clamped");
  });

  check("interruptions: the mic pressed while a reply is read cuts the speech and listens; Stop silences everything at once", () => {
    const speech = fakeSpeech();
    const { log, listener } = fakeListener();
    const handsFree = createHandsFree({ speech: speech.output, listener, onStatus: () => undefined });
    handsFree.enableWith(materialQuestion);
    assertTrue(handsFree.speaking, "reading the question");
    handsFree.bargeIn();
    assertTrue(!handsFree.speaking && speech.cancelled() > 0, "speech cut immediately");
    assertEqual(log[log.length - 1], "start", "listening straight away");
    const starts = log.filter((entry) => entry === "start").length;
    speech.finish();
    assertEqual(log.filter((entry) => entry === "start").length, starts, "the cancelled speech's late “finished” changes nothing");
    handsFree.replied(materialQuestion);
    handsFree.interrupt();
    assertTrue(!handsFree.enabled && !handsFree.speaking && log[log.length - 1] === "cancel", "Stop: speech and mic off, hands-free off, half-heard words dropped");
  });

  // --- Speech recognition (voiceInput.ts) against a scripted stand-in for the browser's recogniser - no audio ---

  type FakeResult = { isFinal: boolean; 0: { transcript: string } };
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    lang = "";
    interimResults = false;
    continuous = false;
    maxAlternatives = 1;
    onresult: ((event: { resultIndex: number; results: FakeResult[] }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() {
      FakeRecognition.last = this;
    }
    start(): void {}
    stop(): void {
      this.onend?.();
    }
    abort(): void {
      this.onerror?.({ error: "aborted" });
      this.onend?.();
    }
    /** What Chrome sends: every result so far, `resultIndex` the first that changed. */
    results(resultIndex: number, ...entries: [string, boolean][]): void {
      this.onresult?.({ resultIndex, results: entries.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
    }
  }
  const withFakeRecognition = (run: (voice: ReturnType<typeof createVoiceInput>, heard: { interim: string[]; final: string[]; states: string[] }) => void): void => {
    const scope = globalThis as unknown as { window?: unknown };
    const previous = scope.window;
    scope.window = { webkitSpeechRecognition: FakeRecognition };
    try {
      const heard = { interim: [] as string[], final: [] as string[], states: [] as string[] };
      const voice = createVoiceInput({
        onInterim: (text) => void heard.interim.push(text),
        onFinal: (text) => void heard.final.push(text),
        onState: (state) => void heard.states.push(state)
      });
      run(voice, heard);
    } finally {
      scope.window = previous;
    }
  };

  check("speech recognition: interim words show live; the final transcript is sent exactly once, when listening ends - repeated results don't send it twice", () => {
    withFakeRecognition((voice, heard) => {
      voice.start();
      const recogniser = FakeRecognition.last!;
      recogniser.results(0, ["make it", false]);
      recogniser.results(0, ["make it 4.5 metres", false]);
      recogniser.results(0, ["make it 4.5 metres wide", true]);
      // Chrome can deliver another event after the final one; results before resultIndex are already counted.
      recogniser.results(1, ["make it 4.5 metres wide", true]);
      assertEqual(heard.final.length, 0, "nothing is sent while still listening");
      assertEqual(heard.interim.join(" / "), "make it / make it 4.5 metres / make it 4.5 metres wide / make it 4.5 metres wide", "partial words shown as they come");
      recogniser.onend?.();
      assertEqual(heard.final.join(" / "), "make it 4.5 metres wide", "sent once, in full");
      assertEqual(voice.listening, false, "and listening has ended");
    });
  });

  /** Timers the test fires by hand. */
  const fakeTimers = () => {
    let next = 1;
    const live = new Map<number, { fn: () => void; ms: number }>();
    return {
      timers: { set: (fn: () => void, ms: number) => (live.set(next, { fn, ms }), next++), clear: (handle: unknown) => void live.delete(handle as number) },
      pending: () => [...live.values()].map((entry) => entry.ms),
      fire: (ms: number) => {
        for (const [handle, entry] of [...live]) {
          if (entry.ms === ms) {
            live.delete(handle);
            entry.fn();
          }
        }
      }
    };
  };
  const withPausedRecognition = (pauseMs: number, run: (voice: ReturnType<typeof createVoiceInput>, heard: { interim: string[]; final: string[]; ended: number }, clock: ReturnType<typeof fakeTimers>) => void): void => {
    const scope = globalThis as unknown as { window?: unknown };
    const previous = scope.window;
    scope.window = { webkitSpeechRecognition: FakeRecognition };
    try {
      const clock = fakeTimers();
      const heard = { interim: [] as string[], final: [] as string[], ended: 0 };
      const voice = createVoiceInput({ lang: "en-IN", pauseMs, silenceMs: 8000, timers: clock.timers, onInterim: (text) => void heard.interim.push(text), onFinal: (text) => void heard.final.push(text), onState: () => undefined, onEnd: () => void (heard.ended += 1) });
      run(voice, heard, clock);
    } finally {
      scope.window = previous;
    }
  };

  check("end of turn: a short pause mid-sentence keeps listening; only the configured pause after speech ends the turn - continuous recognition, in the chosen language", () => {
    withPausedRecognition(1600, (voice, heard, clock) => {
      voice.start();
      const recogniser = FakeRecognition.last!;
      assertTrue(recogniser.continuous === true && recogniser.lang === "en-IN", "continuous, en-IN");
      assertEqual(clock.pending().join(","), "8000", "before any words: only the silence limit");
      recogniser.results(0, ["make the kitchen", false]);
      assertEqual(clock.pending().join(","), "1600", "words heard: the pause timer replaces it");
      // A short pause, then more words: the timer restarts - the turn isn't over.
      recogniser.results(0, ["make the kitchen", true], ["four point five metres wide", false]);
      assertEqual(clock.pending().join(","), "1600", "still one pause timer, restarted");
      assertEqual(heard.final.length, 0, "nothing sent mid-sentence");
      clock.fire(1600);
      assertEqual(heard.final.join(" / "), "make the kitchen four point five metres wide", "the whole turn, words not yet final included");
      assertEqual(heard.ended, 1, "and it ended on its own (hands-free carries on)");
      assertEqual(clock.pending().length, 0, "no timer left behind");
    });
  });

  check("end of turn: silence with nothing said ends listening after the silence limit; while a reply is read (held open) silence never does", () => {
    withPausedRecognition(1200, (voice, heard, clock) => {
      voice.start();
      clock.fire(8000);
      assertTrue(heard.final.length === 0 && heard.ended === 1 && !voice.listening, "silent turn: ended, nothing sent");
      voice.holdOpen(true);
      voice.start();
      assertEqual(clock.pending().length, 0, "held: no silence limit while a reply is read");
      FakeRecognition.last!.results(0, ["make it wider", false]);
      assertEqual(clock.pending().length, 0, "held: words don't end the turn yet either");
      voice.holdOpen(false);
      assertEqual(clock.pending().join(","), "1200", "released after words: the pause starts now");
      voice.setPauseMs(2500);
      clock.fire(1200);
      assertEqual(heard.final.join(" / "), "make it wider", "delivered");
    });
  });

  check("spoken numbers: words become digits the way a typed instruction has them - and nothing else changes", () => {
    const cases: [string, string][] = [
      ["create a four by five metre kitchen three metres high", "create a 4 by 5 metre kitchen 3 metres high"],
      ["make it four point five metres wide", "make it 4.5 metres wide"],
      ["at two comma zero", "at 2, 0"],
      ["at one comma two", "at 1, 2"],
      ["move it minus three metres", "move it -3 metres"],
      ["twenty five metres long", "25 metres long"],
      ["make it one metre longer", "make it 1 metre longer"],
      ["the one on the left", "the one on the left"],
      ["build it", "build it"],
      ["make it 4.5 metres wide", "make it 4.5 metres wide"],
      ["seventeen", "17"]
    ];
    for (const [said, expected] of cases) assertEqual(spokenNumbers(said), expected, said);
  });

  check("speech recognition: pressing the mic again sends what was said; Stop (cancel) drops it - nothing half-heard ever runs", () => {
    withFakeRecognition((voice, heard) => {
      voice.start();
      FakeRecognition.last!.results(0, ["create a kitchen", true]);
      voice.toggle();
      assertEqual(heard.final.join(" / "), "create a kitchen", "mic pressed to finish: the words are sent");

      voice.start();
      FakeRecognition.last!.results(0, ["move it 2 metres", true], [" east", false]);
      assertTrue(voice.listening, "listening");
      voice.cancel();
      assertEqual(heard.final.join(" / "), "create a kitchen", "Stop: the half-heard “move it 2 metres” is dropped, not sent");
      assertEqual(heard.states[heard.states.length - 1], "idle", "back to idle, with no error shown for our own abort");
      FakeRecognition.last!.results(0, ["late words", true]);
      assertEqual(heard.interim.includes("late words"), false, "a late result after Stop is ignored");
    });
  });

  // --- Light / dark theme (ui/theme.ts, styles.css, scene/sceneTheme.ts) ---
  check("the theme store switches, saves, tells subscribers, and starts from what the page already applied", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
    const root = { dataset: {} as Record<string, string | undefined> };
    const store = createThemeStore({ storage, root });
    assertEqual(store.get(), "light", "light by default");
    assertEqual(root.dataset.theme, "light", "applied to <html>");
    const seen: Theme[] = [];
    store.subscribe((theme) => seen.push(theme));
    assertEqual(store.toggle(), "dark", "toggle");
    assertEqual(root.dataset.theme, "dark", "data-theme follows");
    assertEqual(saved.get(THEME_STORAGE_KEY), "dark", "saved under the shared key");
    assertEqual(seen.join(","), "light,dark", "subscribers get the current theme, then each change");
    // A reload: index.html has already set data-theme from storage; the store starts there.
    const reloaded = createThemeStore({ storage, root: { dataset: { theme: "dark" } } });
    assertEqual(reloaded.get(), "dark", "the choice survives a reload");
    assertEqual(readSavedTheme(storage), "dark", "readSavedTheme");
    saved.set(THEME_STORAGE_KEY, "purple");
    assertEqual(readSavedTheme(storage), "light", "an unknown saved value falls back to light");
  });

  check("a browser that refuses storage still switches themes", () => {
    const refusing = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("denied");
      }
    };
    const root = { dataset: {} as Record<string, string | undefined> };
    const store = createThemeStore({ storage: refusing, root });
    assertEqual(store.get(), "light", "default");
    store.set("dark");
    assertEqual(root.dataset.theme, "dark", "switched anyway");
    assertEqual(themeToggleLabel("dark").text, "Light", "the toggle offers the other theme");
    assertEqual(themeToggleLabel("light").text, "Dark", "and back");
  });

  const themeCss = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
  const tokenBlock = (selector: string): Map<string, string> => {
    const start = themeCss.indexOf(`${selector} {`);
    assertTrue(start >= 0, `${selector} block exists`);
    const body = themeCss.slice(start, themeCss.indexOf("\n}", start));
    return new Map([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((match) => [match[1], match[2].trim()]));
  };

  check("the dark theme redefines every colour, shadow, overlay and scrim token the light theme defines - and to different values", () => {
    const light = tokenBlock(":root");
    const dark = tokenBlock(':root[data-theme="dark"]');
    const themed = [...light.keys()].filter((name) => /^--(color-|shadow-|overlay-|scrim|hatch-)/.test(name) && !/^var\(/.test(light.get(name)!));
    assertTrue(themed.length >= 20, `enough themed tokens found (${themed.length})`);
    const missing = themed.filter((name) => !dark.has(name));
    assertEqual(missing.join(", "), "", "every themed token has a dark value");
    const same = themed.filter((name) => dark.get(name) === light.get(name));
    assertEqual(same.join(", "), "", "and each differs from light");
    assertTrue(/color-scheme:\s*dark/.test(themeCss) && /color-scheme:\s*light/.test(themeCss), "native controls (scrollbars, inputs) follow the theme too");
  });

  check("no rule paints a fixed colour outside the token blocks (a theme switch reaches every surface)", () => {
    const withoutComments = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders = withoutComments
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /#[0-9a-fA-F]{3,8}\b/.test(line) && !/^--[a-z0-9-]+:/.test(line));
    assertEqual(offenders.join(" | "), "", "hex colours only in token definitions");
  });

  check("there is a visible focus ring and a disabled state for every control, from tokens", () => {
    assertTrue(/:where\([^)]*button[^)]*\):focus-visible\s*{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring-color\)/.test(themeCss), "focus-visible ring");
    assertTrue(/:where\(button, input, select, textarea\):disabled\s*{[^}]*cursor:\s*not-allowed/.test(themeCss), "disabled controls say so");
  });

  check("index.html applies the saved theme before the first paint (a same-origin file, so the CSP allows it), with the same storage key", () => {
    const preload = readFileSync(fileURLToPath(new URL("../../public/theme-preload.js", import.meta.url)), "utf8");
    assertTrue(preload.includes(`localStorage.getItem("${THEME_STORAGE_KEY}")`) && preload.includes('setAttribute("data-theme"'), "same key as ui/theme.ts, applied to <html>");
    const tag = indexHtml.indexOf('<script src="/theme-preload.js"></script>');
    assertTrue(tag > 0 && tag < indexHtml.indexOf("</head>") && tag < indexHtml.indexOf('src="/src/main.ts"'), "a classic script in <head>, before the app");
    assertTrue(/html\[data-theme="dark"\][^{]*{\s*background:/.test(indexHtml), "a dark page background before styles.css loads");
  });

  check("the 3D viewport has its own palette per theme - backdrop, fog, ground and grid all change", () => {
    const { light, dark } = SCENE_PALETTES;
    assertTrue(light.fog !== dark.fog && light.ground !== dark.ground && light.gridMajor !== dark.gridMajor && light.sky.horizon !== dark.sky.horizon, "every viewport colour differs");
    const topBar = readFileSync(fileURLToPath(new URL("./topBar.ts", import.meta.url)), "utf8");
    assertTrue(/className: "app-header__theme"/.test(topBar) && /store\.toggle\(\)/.test(topBar), "the top bar has the one-click switch");
    assertTrue(/themeStore\.subscribe\(\(theme\) => sceneManager\.current\?\.setTheme\(theme\)\)/.test(mainSource), "main.ts sends the theme to the viewport");
  });

  // --- The AI companion's voice: settings, cancellable turns, end of turn on a pause, barge-in by voice ---
  check("voice settings: defaults to English (India), saved and read back, anything odd falls back to the default", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
    assertEqual(JSON.stringify(readVoiceSettings(storage)), JSON.stringify(DEFAULT_VOICE_SETTINGS), "defaults");
    assertEqual(DEFAULT_VOICE_SETTINGS.lang, "en-IN", "English (India) first");
    assertEqual(DEFAULT_VOICE_SETTINGS.bargeIn, false, "interrupting by speaking is opt-in (it needs headphones); the mic button and Stop always interrupt");
    saveVoiceSettings(storage, { lang: "en-GB", voiceURI: "voice-7", pauseMs: 2500, bargeIn: false, replyLength: "full" });
    assertEqual(JSON.stringify(readVoiceSettings(storage)), JSON.stringify({ lang: "en-GB", voiceURI: "voice-7", pauseMs: 2500, bargeIn: false, replyLength: "full" }), "round trip");
    saved.set(VOICE_SETTINGS_KEY, JSON.stringify({ lang: "<script>", pauseMs: 99999, bargeIn: "yes", replyLength: "loud" }));
    assertEqual(JSON.stringify(readVoiceSettings(storage)), JSON.stringify(DEFAULT_VOICE_SETTINGS), "invalid values are ignored");
    saved.set(VOICE_SETTINGS_KEY, "{not json");
    assertEqual(readVoiceSettings(storage).lang, "en-IN", "unreadable storage: defaults");
  });

  check("voice choice: an English (India) voice when the browser has one - and, when it doesn't, it says so instead of claiming one", () => {
    const voices = [
      { name: "Google UK English Female", lang: "en-GB", voiceURI: "uk" },
      { name: "Microsoft Heera - English (India)", lang: "en-IN", voiceURI: "heera" },
      { name: "Google US English", lang: "en-US", voiceURI: "us", default: true }
    ];
    const indian = chooseVoice(voices, { lang: "en-IN", voiceURI: null });
    assertEqual(indian.voice?.voiceURI, "heera", "the en-IN voice");
    assertTrue(/Heera/.test(indian.note), indian.note);
    assertEqual(chooseVoice(voices, { lang: "en-IN", voiceURI: "us" }).voice?.voiceURI, "us", "a voice the user picked wins");
    const none = chooseVoice(voices.filter((voice) => voice.lang !== "en-IN"), { lang: "en-IN", voiceURI: null });
    assertTrue(none.voice !== null && /no English \(India\) voice/.test(none.note) && !/Heera/.test(none.note), `honest fallback: ${none.note}`);
    assertEqual(chooseVoice([], { lang: "en-IN", voiceURI: null }).voice, null, "no voices at all: the engine default");
    assertEqual(chooseVoice([{ name: "x", lang: "en_IN", voiceURI: "x" }], { lang: "en-IN", voiceURI: null }).voice?.voiceURI, "x", "en_IN (Android spelling) counts");
  });

  check("turns: Stop cancels the one in flight (its late reply is dropped); a new turn supersedes an old one; replies and failures come through", async () => {
    const pending: Array<{ text: string; signal: AbortSignal; resolve: (value: string) => void }> = [];
    const turns = createTurnController<string>((text, { signal }) => new Promise<string>((resolve) => void pending.push({ text, signal, resolve })));
    const first = turns.send("add a pergola");
    assertTrue(turns.busy, "busy while thinking");
    assertTrue(turns.stop(), "Stop cancels it");
    assertTrue(pending[0].signal.aborted && !turns.busy, "aborted at once, and free for the next turn");
    pending[0].resolve("pergola added");
    assertEqual(JSON.stringify(await first), JSON.stringify({ kind: "cancelled", reason: "stopped" }), "the late reply is dropped");
    const old = turns.send("make it 4 m wide");
    const newer = turns.send("make it 4.5 m wide");
    assertTrue(pending[1].signal.aborted && !pending[2].signal.aborted, "the older turn is cancelled, the newer one runs");
    pending[2].resolve("4.5");
    pending[1].resolve("4");
    assertEqual(JSON.stringify(await newer), JSON.stringify({ kind: "reply", reply: "4.5" }), "the correction's reply");
    assertEqual(JSON.stringify(await old), JSON.stringify({ kind: "cancelled", reason: "superseded" }), "the old reply never lands");
    // A request that never answers (a hung network): Stop still resolves the turn at once.
    const hung = createTurnController<string>(() => new Promise<string>(() => undefined));
    const stuck = hung.send("add a pergola");
    hung.stop();
    assertEqual(JSON.stringify(await stuck), JSON.stringify({ kind: "cancelled", reason: "stopped" }), "Stop doesn't wait for a reply that may never come");
    const failing = createTurnController<string>(() => Promise.reject(new Error("offline")));
    const outcome = await failing.send("x");
    assertTrue(outcome.kind === "failed" && outcome.error instanceof Error, "a failure is reported, not swallowed");
    assertEqual(turns.stop(), false, "Stop with nothing in flight does nothing");
  });

  check("spoken replies: the short form reads the gist and the question, at most three choices - the full text stays on screen", () => {
    const reply = {
      text: "Built room-1: a 4 m × 5 m kitchen (20 m² to wall centrelines), 3 m ceiling, 230 mm brick walls, centred at (8, 6) on the ground floor with 4 walls (wall-1, wall-2, wall-3, wall-4). One undo removes all of it. Shall I add a door?",
      choices: [{ label: "Yes", say: "yes" }, { label: "No", say: "no" }, { label: "Undo", say: "undo" }, { label: "Show me", say: "show" }]
    };
    const short = spokenReply(reply, "short");
    assertTrue(short.startsWith("Built room-1") && short.includes("Shall I add a door?") && !short.includes("One undo removes"), short);
    assertTrue(/You can say: Yes, No, or Undo\.$/.test(short), `three choices: ${short}`);
    assertTrue(spokenReply(reply, "full").includes("One undo removes all of it"), "full reads everything");
    assertTrue(shortSpoken("word ".repeat(120).trim() + ".").length <= 221, "a long first sentence is cut");
  });

  check("echo guard: the reply coming back through the speakers is recognised as such - the user's own words are not; exactly the earlier echo is removed", () => {
    const spoken = "Ready to build a 4 metres by 5 metres kitchen, centred at 8, 6. Build it? You can say: Build it, Pick another spot, or Cancel.";
    assertTrue(isEchoOf("ready to build a 4 metres by 5 metres", spoken), "a stretch of the reply");
    assertTrue(isEchoOf("Build it", spoken), "words the reply itself says");
    assertTrue(!isEchoOf("make it 4.5 metres wide", spoken), "a correction");
    assertTrue(!isEchoOf("no stop put the door on the other wall", spoken), "an interruption");
    assertEqual(wordsAfter("ready to build a 4 metres make it four point five", "ready to build a 4 metres"), "make it four point five", "after the echo heard before the user spoke");
    assertEqual(wordsAfter("ready to build a four metres make it wider", "ready to build a 4 metres"), "make it wider", "a word the recogniser revised in the echo doesn't leak");
    assertEqual(wordsAfter("make it wider", ""), "make it wider", "no echo: unchanged");
    // However the recogniser writes the echo: numbers as words, US spellings.
    assertTrue(isEchoOf("ready to build a four meters by five meters", spoken), "number words and US spelling are still the reply");
    assertTrue(isEchoOf("kitchen centered at eight six", spoken), "centered = centred, eight = 8");
    // The words the reply was saying next, delivered with the user's first words, are left out too.
    assertEqual(stripContinuation("by 5 metres kitchen no make it 6 metres wide", spoken, "ready to build a 4 metres"), "no make it 6 metres wide", "the echo's continuation is removed");
    assertEqual(stripContinuation("by five meters kitchen make it wider", spoken, "ready to build a four meters"), "make it wider", "in any spelling");
    assertEqual(stripContinuation("make it 6 metres wide", spoken, "ready to build a 4 metres"), "make it 6 metres wide", "nothing continuing the echo: unchanged");
    assertEqual(stripContinuation("by the window", spoken, "ready to build a 4 metres"), "by the window", "one shared word may be the user's own");
  });

  check("barge-in by voice: the mic is held open while a reply is read; only two or more words the reply never says interrupt it; exactly the earlier echo is left out", () => {
    const speech = fakeSpeech();
    const log: string[] = [];
    let pending = "";
    const listener = {
      supported: true,
      start: () => void log.push("start"),
      stop: () => void log.push("stop"),
      cancel: () => void log.push("cancel"),
      holdOpen: (on: boolean) => void log.push(`hold:${on}`),
      pendingWords: () => pending
    };
    const statuses: string[] = [];
    const handsFree = createHandsFree({ speech: speech.output, listener, bargeIn: () => true, replyLength: () => "short", onStatus: (status) => void statuses.push(status.kind) });
    handsFree.enableWith(null);
    speech.finish();
    const reply = { text: "Ready to build a 4 m × 5 m kitchen, centred at (8, 6). Build it?", choices: [{ label: "Build it", say: "build it" }, { label: "Cancel", say: "cancel" }] };
    log.length = 0;
    handsFree.replied(reply);
    assertTrue(handsFree.speaking && log.includes("hold:true") && log.includes("start"), `reading, with the mic held open: ${log.join(",")}`);
    assertEqual(handsFree.heardWhileSpeaking("ready to build a 4 metres"), false, "its own echo doesn't interrupt");
    assertEqual(handsFree.heardWhileSpeaking("ready to build a 4 metres sae"), false, "one misheard echo word doesn't either");
    assertEqual(handsFree.heardWhileSpeaking("ready to build a four meters by five meters kitchen centered"), false, "nor the echo written with number words and US spelling");
    assertTrue(handsFree.speaking && speech.cancelled() === 0, "still speaking");
    // "four" is the reply's own "4" however it is written - the user is recognised by words the reply never says.
    assertEqual(handsFree.heardWhileSpeaking("ready to build a 4 metres make it four"), false, "only one word the reply never says (\"make\"): not yet");
    assertEqual(handsFree.heardWhileSpeaking("ready to build a 4 metres make it wider"), true, "two words the reply never says: the user is talking");
    assertTrue(!handsFree.speaking && speech.cancelled() === 1 && log.includes("hold:false"), "speech cancelled at once, the mic no longer held");
    assertEqual(statuses[statuses.length - 1], "listening", "the turn is the user's");
    assertEqual(handsFree.userWords("ready to build a 4 metres make it wider please"), "make it wider please", "the box shows only the user's words");
    assertEqual(handsFree.acceptFinal("ready to build a 4 metres make it wider by half a metre"), "make it wider by half a metre", "sent without the echo heard before");
    const starts = log.filter((entry) => entry === "start").length;
    speech.finish();
    assertEqual(log.filter((entry) => entry === "start").length, starts, "the cancelled speech's late “finished” opens nothing");

    // Read to the end, not interrupted: the session that heard it is dropped, and the answer is heard in a fresh one - quoted choices intact.
    handsFree.replied({ text: "Shall I lay the foundation?", choices: [{ label: "Lay the foundation", say: "lay the foundation" }, { label: "Cancel", say: "cancel" }] });
    log.length = 0;
    speech.finish();
    assertEqual(log.join(","), "hold:false,cancel,start", "echo session dropped, a fresh one opened");
    assertEqual(handsFree.acceptFinal("lay the foundation"), "lay the foundation", "the user's answer goes through as said, though the reply said those words");

    // The browser ends the session mid-reply (or times out with no speech): that's not the user's silence.
    handsFree.replied(reply);
    assertEqual(handsFree.acceptFinal("ready to build a 4 metres by"), null, "a session that ended mid-reply heard only the reply");
    handsFree.listenerError("no-speech", "I didn't hear anything");
    log.length = 0;
    handsFree.listenerEnded();
    assertTrue(handsFree.enabled && handsFree.speaking && log.includes("start"), `still reading, listening again: ${log.join(",")}`);

    // Stop clears it all: a plain mic turn afterwards is sent exactly as heard.
    handsFree.heardWhileSpeaking("make it wider please");
    handsFree.interrupt();
    assertEqual(handsFree.acceptFinal("ready to build make it wider"), "ready to build make it wider", "no stale echo is stripped after Stop");

    // The mic button while a reply is read with the mic held open: the session holding the echo is dropped, a fresh one opened.
    handsFree.enableWith(null);
    speech.finish();
    handsFree.replied(reply);
    log.length = 0;
    handsFree.bargeIn();
    assertTrue(!handsFree.speaking && log.join(",").includes("cancel") && log[log.length - 1] === "start", `fresh session after the press: ${log.join(",")}`);
    assertEqual(handsFree.acceptFinal("make it wider"), "make it wider", "only what was said after the press, as said");

    // A new reply arriving while the previous one is still read (a chip, a ground pick): it is read, in a fresh session - the old echo isn't the user.
    handsFree.replied(reply);
    pending = "ready to build a 4 metres";
    const spokenCount = speech.spoken.length;
    log.length = 0;
    handsFree.replied({ text: "Built room-1. Shall I add a door?", choices: [{ label: "Add a door", say: "add a door" }] });
    assertTrue(speech.spoken.length === spokenCount + 1 && /Built room-1/.test(speech.spoken[speech.spoken.length - 1]), "the new reply is read");
    assertTrue(log.includes("cancel") && log.includes("start"), `in a fresh session: ${log.join(",")}`);
    pending = "";
    handsFree.interrupt();

    // A reply arriving while the user is mid-sentence is not read over them.
    handsFree.enableWith(null);
    speech.finish();
    const spokenBefore = speech.spoken.length;
    pending = "make it four";
    handsFree.replied(reply);
    assertEqual(speech.spoken.length, spokenBefore, "not spoken - the user is still talking");
    pending = "";

    const quiet = createHandsFree({ speech: fakeSpeech().output, listener: fakeListener().listener, bargeIn: () => false, onStatus: () => undefined });
    quiet.enableWith(reply);
    assertEqual(quiet.heardWhileSpeaking("make it four point five metres wide"), false, "with barge-in off, only the mic button or Stop interrupts");
  });

  // --- Milestone 3: coordinates, grid and dimensions ---
  check("workspace settings: defaults, validated, saved and read back - anything odd falls back field by field", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
    assertEqual(JSON.stringify(readWorkspace(null)), JSON.stringify(DEFAULT_WORKSPACE), "no storage: the defaults");
    assertEqual(JSON.stringify(DEFAULT_WORKSPACE), JSON.stringify({ gridSpacing: 1, snapping: true, snapStep: 0.1, showAxes: true, showDimensions: true }), "1 m grid, snapping on every 0.1 m, axes and dimensions shown");
    const settings = new WorkspaceSettings(storage);
    const seen: number[] = [];
    settings.subscribe((state) => seen.push(state.gridSpacing));
    assertEqual(settings.setGridSpacing(0.5), null, "0.5 m is a valid grid");
    assertTrue(settings.setGridSpacing(0.05) !== null && settings.setGridSpacing(Number.NaN) !== null && settings.setGridSpacing(50) !== null, "too fine, not a number, or too coarse: refused with a reason");
    assertEqual(settings.get().gridSpacing, 0.5, "a refused value changes nothing");
    settings.setGridSpacing(0.5);
    assertEqual(seen.join(" "), "1 0.5", "told now, then once per real change - never for a repeat");
    assertTrue(settings.setSnapStep(0) !== null, "a zero snap step is refused");
    assertEqual(settings.setSnapStep(0.25), null, "0.25 m is a valid step");
    settings.setSnapping(false);
    settings.setShowAxes(false);
    assertEqual(saved.get(WORKSPACE_KEY), JSON.stringify({ gridSpacing: 0.5, snapping: false, snapStep: 0.25, showAxes: false, showDimensions: true }), "saved as it changes");
    assertEqual(JSON.stringify(new WorkspaceSettings(storage).get()), saved.get(WORKSPACE_KEY), "a reload reads it back");
    saved.set(WORKSPACE_KEY, JSON.stringify({ gridSpacing: -1, snapping: "yes", snapStep: 99, showAxes: false }));
    assertEqual(JSON.stringify(readWorkspace(storage)), JSON.stringify({ ...DEFAULT_WORKSPACE, showAxes: false }), "each invalid field falls back; the valid one is kept");
    saved.set(WORKSPACE_KEY, "{not json");
    assertEqual(JSON.stringify(readWorkspace(storage)), JSON.stringify(DEFAULT_WORKSPACE), "unreadable: the defaults");
    const refusing = new WorkspaceSettings({ getItem: () => null, setItem: () => { throw new Error("quota"); } });
    refusing.setGridSpacing(0.25);
    assertEqual(refusing.get().gridSpacing, 0.25, "storage that refuses to save: the change still applies");
    assertEqual(`${formatSpacing(0.5)} ${formatSpacing(0.25)} ${formatSpacing(1)}`, "0.5 m 0.25 m 1 m", "spacings read as metres");
  });

  check("dimension labels: one rounding rule (1 cm, trailing zeros dropped), length east-west by width north-south", () => {
    assertEqual(`${formatLength(4.5)} | ${formatLength(4.7349)} | ${formatLength(3)} | ${formatLength(0.005)}`, "4.5 m | 4.73 m | 3 m | 0.01 m", "metres to the centimetre");
    assertEqual(roomDimensionText("Kitchen", 4.5, 5), "Kitchen 4.5 × 5 m", "a room: name, length × width");
    assertEqual(roomDimensionText(undefined, 3.333, 4), "3.33 × 4 m", "unnamed: the size alone");
    assertEqual(`${wallDimensionText(4.73)} ${plotEdgeText(30)}`, "4.73 m 30 m", "walls and plot edges the same way");
    assertEqual(dimensionSummary(1, 4), "Dimensions shown: 1 room, 4 walls.", "the summary counts what is labelled");
    assertEqual(dimensionSummary(2, 1), "Dimensions shown: 2 rooms, 1 wall.", "singular and plural");
    assertEqual(dimensionSummary(0, 0), "No dimensions to show.", "nothing to label");
    assertEqual(
      dimensionSummary(0, 0, { rooms: 6, walls: 9 }),
      "No dimensions shown. 6 rooms and 9 walls are under the roof - hide the roof to label them.",
      "a roofed house: what's under the roof, and how to see it"
    );
    assertEqual(dimensionSummary(1, 4, { rooms: 0, walls: 0 }), "Dimensions shown: 1 room, 4 walls.", "nothing covered: as before");
  });

  check("scale bar: the longest 1-2-5 length that fits, drawn to the zoom at the view's centre", () => {
    const bar = scaleBarFor(0.05, 120)!;
    assertEqual(`${bar.label} ${bar.pixels}`, "5 m 100", "6 m fit in 120 px at 5 cm a pixel: a 5 m bar, 100 px long");
    assertEqual(scaleBarFor(0.001, 120)!.label, "0.1 m", "zoomed right in: 0.1 m");
    assertEqual(scaleBarFor(0.004, 120)!.label, "0.2 m", "0.48 m fit: 0.2 m (never 0.5)");
    assertEqual(scaleBarFor(1, 120)!.label, "100 m", "zoomed right out: 100 m");
    assertTrue(scaleBarFor(0, 120) === null && scaleBarFor(Number.NaN, 120) === null && scaleBarFor(-1, 120) === null, "no zoom to measure: no bar");
    const perPixel = metresPerPixelAt(10, 45, 800);
    assertTrue(Math.abs(perPixel - (2 * 10 * Math.tan(Math.PI / 8)) / 800) < 1e-12, "10 m away with a 45° view 800 px tall: the visible height over the pixels");
    assertTrue(Number.isNaN(metresPerPixelAt(0, 45, 800)) && Number.isNaN(metresPerPixelAt(10, 45, 0)), "a degenerate view has no scale");
  });

  check("the workspace grid keeps a line on every multiple of any allowed spacing, the origin included", () => {
    for (const spacing of [0.1, 0.25, 0.3, 0.5, 0.75, 1, 2, 5, 7, 10]) {
      const { size, divisions } = minorGrid(spacing);
      assertTrue(divisions % 2 === 0, `${spacing} m: an even number of cells, so a line runs through 0, 0`);
      assertTrue(Math.abs(size / divisions - spacing) < 1e-9, `${spacing} m: each cell exactly ${spacing} m (got ${size / divisions})`);
      assertTrue(size >= 20 && size <= GROUND_SIZE, `${spacing} m: drawn over ${size} m - within the ground`);
    }
    assertEqual(MAJOR_GRID_SPACING, 5, "major lines every 5 m");
  });

  check("the axes, origin, plot and labels have their own colours in each theme", () => {
    const { light, dark } = SCENE_PALETTES;
    for (const palette of [light, dark]) {
      assertTrue([palette.axisX, palette.axisY, palette.axisZ, palette.origin, palette.plot].every((color) => typeof color === "number"), "every guide colour is set");
      assertTrue(new Set([palette.axisX, palette.axisY, palette.axisZ]).size === 3, "the three axes are told apart by colour");
      assertTrue(palette.labelText !== palette.labelBackground, "label text stands out from its background");
    }
    assertTrue(light.axisX !== dark.axisX && light.origin !== dark.origin && light.labelBackground !== dark.labelBackground && light.labelText !== dark.labelText, "and they change with the theme");
  });

  check("one coordinate convention everywhere: X east, Y up, Z south (the plan's Y)", () => {
    const overlay = sourceOf("../scene/coordinateOverlay.ts");
    assertTrue(/x: "X {2}east"/.test(overlay) && /y: "Y {2}up"/.test(overlay) && /z: "Z {2}south \(plan Y\)"/.test(overlay), "the axis labels drawn in the scene");
    assertTrue(/X runs east, Z south \(the plan's Y\), Y up\. 0, 0 is the world centre\. Metres\./.test(sourceOf("./workspacePanel.ts")), "the Grid & plot popover states it");
    assertTrue(/"X \(east\)"/.test(sourceOf("./rightSidebar.ts")) && /"Z \(south · plan Y\)"/.test(sourceOf("./rightSidebar.ts")), "the inspector's room position rows name the same axes");
    assertTrue(/world x 10, z 8 \(the plan's Y is the world Z axis\)/.test(sourceOf("../engine/architect/adjust.ts")), "and the conversation's 'to X 10, Y 8' means world x 10, z 8");
  });

  check("main.ts wires one workspace: snapping both ways, the scene, the status bar, the popover, the inspector and the conversation", () => {
    assertTrue(/const workspace = new WorkspaceSettings\(sessionStore\(\)\);/.test(mainSource), "one settings object, remembered per browser");
    assertTrue(/fallback: submitArchitectFallback,\s*workspace\s*}\);/.test(mainSource), "the conversation changes it");
    assertTrue(/snapSettings\.setStep\(state\.snapStep\);\s*snapSettings\.setEnabled\(state\.snapping\);/.test(mainSource) && /snapSettings\.subscribe\(\(enabled\) => workspace\.setSnapping\(enabled\)\);/.test(mainSource), "SnapSettings and the workspace kept in step both ways");
    assertTrue(/workspace\.subscribe\(\(state\) => sceneManager\.current\?\.setWorkspace\(state\)\);/.test(mainSource), "the scene follows it (grid, axes, labels)");
    assertTrue(/onRoomEdit: \(roomId, edit\) => architect\.editRoom\(roomId, edit\)/.test(mainSource), "the inspector's room rows go through editRoom");
    assertTrue(/onSetPlot: \(length, width\) => architect\.setPlot\(length, width\)/.test(mainSource), "the plot controls go through setPlot");
    assertTrue(/snapStep: \(\) => snapSettings\.getStep\(\)/.test(mainSource), "the Measure tool snaps to the same step");
    assertTrue(/workspace: options\.workspace/.test(layoutSource) && /`Snap: \$\{step\}`/.test(layoutSource), "the status bar and the Snap button show the live step");
  });

  check("the Grid & plot popover and the scale bar use theme tokens only", () => {
    const css = sourceOf("./styles.css");
    for (const selector of [".workspace-panel {", ".scale-bar {", ".scale-bar__bar {"]) {
      const start = css.indexOf(`\n${selector}`);
      assertTrue(start >= 0, `${selector} is styled`);
      const body = css.slice(start, css.indexOf("}", start));
      assertTrue(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(body), `${selector} has no hard-coded colour`);
    }
  });

  check("the inspector redraws when any store it counts changes - furniture included - but never under a field being typed in", () => {
    const sidebar = sourceOf("./rightSidebar.ts");
    const counted = /const allObjects = \(\): ListedObject\[\] => \[([\s\S]*?)\];/.exec(sidebar);
    assertTrue(counted !== null, "allObjects() lists the stores the summary counts");
    const stores = [...counted[1].matchAll(/options\.(\w+)\.getAll\(\)/g)].map((match) => match[1]);
    assertTrue(stores.includes("assetStore"), `furniture is counted (${stores.join(", ")})`);
    for (const store of [...stores, "selectionStore"]) {
      assertTrue(new RegExp(`options\\.${store}\\.subscribe\\(render\\);`).test(sidebar), `render follows ${store}`);
    }
    assertTrue(/!committing && active instanceof HTMLInputElement && properties\.contains\(active\) && active\.value !== active\.defaultValue/.test(sidebar), "a field holding typed, uncommitted text is recognised - not while it commits");
    assertTrue(/const render = \(\): void => \{\s*if \(holdsEdit\(\)\) \{\s*redrawOnBlur = true;\s*return;\s*\}\s*draw\(\);/.test(sidebar), "a change from elsewhere while one is typed in waits");
    assertTrue(/properties\.addEventListener\("change", \(\) => \{\s*committing = true;\s*\}, true\);\s*properties\.addEventListener\("change", \(\) => \{\s*committing = false;\s*\}\);/.test(sidebar), "the field's own commit is marked around its change handler, so it redraws at once");
    assertTrue(/properties\.addEventListener\("focusout", \(\) => \{\s*if \(redrawOnBlur && !holdsEdit\(\)\) \{\s*draw\(\);/.test(sidebar), "and a held change is drawn as soon as focus leaves the field");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
