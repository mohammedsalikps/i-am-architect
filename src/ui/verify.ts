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
import { createHandsFree, matchSpokenChoice, spokenNumbers, spokenReply } from "./handsFree.ts";
import type { HandsFreeStatus } from "./handsFree.ts";
import { COPILOT_STEPS, INITIAL_COPILOT_STATE, createInputGate, nextCopilotState, stepStatuses } from "./copilotState.ts";
import type { CopilotEvent } from "./copilotState.ts";
import { rmsLevel } from "./levelMeter.ts";
import { createVoiceInput } from "./voiceInput.ts";
import { searchProjectItems } from "./projectSearch.ts";

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
  };
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

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
