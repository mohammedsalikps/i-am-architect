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
import { createHandsFree, matchSpokenChoice, spokenReply } from "./handsFree.ts";
import type { HandsFreeStatus } from "./handsFree.ts";

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
    return { log, listener: { supported, start: () => void log.push("start"), stop: () => void log.push("stop") } };
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
    assertTrue(speech.cancelled() > 0 && log[log.length - 1] === "stop", "speech cancelled, mic closed");
    speech.finish();
    assertTrue(!log.includes("start"), "a late “finished speaking” never reopens the mic");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
