// SIMULATED SPEECH in a real (headless) Chrome - see README.md.
// The real app, panel, hands-free controller, architect session and 3D
// scene run as usual; only the browser's speech recogniser and speech
// synthesiser are replaced by scripted stand-ins injected before the page
// loads. No microphone is used (the level meter's getUserMedia is refused)
// and no audio is played or heard. This is NOT a real-microphone test and
// NOT a live-Claude test.
// Usage: node scripts/browser-checks/voice-simulated.mjs [screenshotDir]
//   APP (default http://localhost:5174/), WIN (default 1440x900)
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectations, launch, sleep } from "./cdp.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "iarchitect-browser-checks", "shots");
mkdirSync(outDir, { recursive: true });
const [W, H] = (process.env.WIN ?? "1440x900").split("x").map(Number);
const APP = process.env.APP ?? "http://localhost:5174/";
const READY = `!!document.querySelector(".architect__input") && !!document.querySelector(".viewport-container canvas")`;
const b = await launch({ name: "voice", width: W, height: H, port: 9342 });
const { expect, finish } = expectations();

const FAKES = `(() => {
  const voice = (window.__voice = { sessions: 0, spoken: [], speaking: null, current: null, cancelledSpeech: 0 });
  class FakeRecognition {
    constructor() { this.lang = ""; this.interimResults = false; this.continuous = false; this.maxAlternatives = 1; this.onresult = null; this.onerror = null; this.onend = null; this.active = false; voice.current = this; }
    start() { this.active = true; voice.sessions += 1; }
    stop() { if (!this.active) return; this.active = false; setTimeout(() => this.onend && this.onend(), 30); }
    abort() { if (!this.active) return; this.active = false; setTimeout(() => { this.onerror && this.onerror({ error: "aborted" }); this.onend && this.onend(); }, 30); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  const result = (transcript, isFinal) => ({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] });
  voice.partial = (text) => { const r = voice.current; if (!r || !r.active) return false; r.onresult(result(text, false)); return true; };
  /** A final result that has arrived while the recogniser hasn't ended yet (Chrome ends a moment later). */
  voice.finalOnly = (text) => { const r = voice.current; if (!r || !r.active) return false; r.onresult(result(text, true)); return true; };
  /** Partial words, the final transcript, then the recogniser ends after a pause - as Chrome does. */
  voice.say = async (partials, final) => {
    const r = voice.current;
    if (!r || !r.active) return "not listening";
    for (const text of partials) { r.onresult(result(text, false)); await new Promise((done) => setTimeout(done, 150)); }
    r.onresult(result(final, true));
    await new Promise((done) => setTimeout(done, 80));
    r.active = false;
    r.onend && r.onend();
    return "said";
  };
  class FakeUtterance { constructor(text) { this.text = text; this.lang = ""; this.onend = null; this.onerror = null; } }
  const synth = {
    speak(utterance) { voice.spoken.push(utterance.text); voice.speaking = utterance; },
    cancel() { const utterance = voice.speaking; voice.speaking = null; if (utterance) { voice.cancelledSpeech += 1; utterance.onerror && utterance.onerror({ error: "interrupted" }); } }
  };
  voice.finishSpeaking = () => { const utterance = voice.speaking; voice.speaking = null; if (utterance && utterance.onend) utterance.onend(); };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = FakeUtterance;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("simulated speech test - no microphone", "NotAllowedError"));
})();`;
await b.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKES });

const state = () =>
  b.evaluate(`JSON.stringify({
    users: [...document.querySelectorAll(".architect__msg--user")].map((node) => node.textContent),
    last: (() => { const last = [...document.querySelectorAll(".architect__msg--architect")].at(-1); return { tags: last?.querySelector(".copilot__tags")?.textContent ?? "", text: last?.querySelector(".architect__text")?.textContent ?? "" }; })(),
    copilot: document.querySelector(".copilot__state")?.textContent ?? "",
    transcript: document.querySelector(".copilot__transcript")?.textContent ?? "",
    box: document.querySelector(".architect__input").value,
    speaking: !!window.__voice.speaking,
    listening: !!(window.__voice.current && window.__voice.current.active),
    cancelledSpeech: window.__voice.cancelledSpeech,
    stopVisible: !document.querySelector(".copilot__stop").hidden
  })`).then(JSON.parse);
const click = (selector) => b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const waitReply = async (usersBefore) => {
  await b.waitFor(`document.querySelectorAll(".architect__msg--architect").length > 0 && !document.querySelector(".architect--busy") && document.querySelectorAll(".architect__msg--user").length > ${usersBefore}`, 15000);
  await sleep(500);
  return state();
};
/** Barge in: press the mic while the reply is being read, then speak. */
const bargeInAndSay = async (partials, final) => {
  const before = await state();
  await click(".architect__mic");
  await sleep(300);
  const listening = await state();
  await b.evaluate(`window.__voice.say(${JSON.stringify(partials)}, ${JSON.stringify(final)})`);
  const after = await waitReply(before.users.length);
  return { before, listening, after };
};
const records = async () => {
  await b.evaluate(`[...document.querySelectorAll("button")].filter((button) => !button.disabled && button.textContent.trim() === "Measurements").at(-1).click()`);
  await sleep(800);
  return JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll(".record-book__row")].map((row) => [...row.cells].map((cell) => cell.textContent.trim()).join(" | ")).sort())`));
};

console.log("SIMULATED speech (scripted recogniser and synthesiser) in headless Chrome - no microphone, no audio, no live Claude.\n");
expect("app loaded with the simulated speech APIs", await b.goto(APP, READY));
await sleep(1500);
await b.evaluate(`(() => { const button = document.querySelector(".architect__collapse"); if (button && /Expand/.test(button.getAttribute("aria-label") ?? "")) button.click(); })()`);
expect("mic and hands-free are enabled (speech recognition detected)", await b.evaluate(`!document.querySelector(".architect__mic").disabled && !document.querySelector(".architect__hands-free").disabled`));

// 1. Hands-free on: the assistant speaks; the mic is closed while it does.
await click(".architect__hands-free");
await sleep(400);
let s = await state();
expect("hands-free on: the assistant is speaking, the mic is closed, Stop is offered", s.speaking && !s.listening && s.stopVisible, s.copilot);

// 2. Interrupt the speech with the mic, then speak a complete room request (partial words first).
await click(".architect__mic");
await sleep(300);
s = await state();
expect("pressing the mic while it speaks cuts the speech at once and listens", !s.speaking && s.listening && s.cancelledSpeech > 0, s.copilot);
await b.evaluate(`window.__voice.partial("create a four by five")`);
await sleep(300);
s = await state();
expect("partial words are shown as heard - nothing sent yet", s.box === "create a four by five" && s.users.length === 0 && /four by five/.test(s.transcript), `box “${s.box}”`);
const usersBefore = s.users.length;
await b.evaluate(`window.__voice.say(["create a four by five metre kitchen"], "create a four by five metre kitchen three metres high on the ground floor brick walls at zero zero")`);
s = await waitReply(usersBefore);
expect("the final transcript is sent once", s.users.length === usersBefore + 1, JSON.stringify(s.users));
expect("the numbers said as words are shown as read", /→ “create a 4 by 5 metre kitchen 3 metres high on the ground floor brick walls at 0 0”/.test(s.users.at(-1)), s.users.at(-1));
expect("a complete spoken request goes straight to the preview", /Preview/.test(s.last.tags) && /4 m × 5 m kitchen/.test(s.last.text), s.last.text.slice(0, 120));
expect("and the preview is being read out", s.speaking);
await b.shot(outDir, "70-spoken-preview");

// 3. Correct a dimension while the assistant is still reading the preview.
let step = await bargeInAndSay(["make it four point five"], "make it four point five metres wide");
expect("correction mid-speech: the speech stopped and the mic opened", step.listening.listening && !step.listening.speaking);
expect("the correction is applied to the preview", /4 m × 4\.5 m kitchen/.test(step.after.last.text) && /Preview/.test(step.after.last.tags), step.after.last.text.slice(0, 100));

// 4. An ambiguous correction is asked about, not guessed.
step = await bargeInAndSay([], "make it five metres");
expect("“make it five metres”: asked which dimension", /length \(east–west\), width \(north–south\) or ceiling height/.test(step.after.last.text) && !/Applied/.test(step.after.last.tags), step.after.last.text.slice(0, 120));
step = await bargeInAndSay([], "length");
expect("answered “length” by voice: the matching choice is taken", /5 m × 4\.5 m kitchen/.test(step.after.last.text), step.after.last.text.slice(0, 100));

// 5. Typed Send while the recogniser still holds the same words: executed once.
const beforeBuild = await state();
await click(".architect__mic");
await sleep(300);
await b.evaluate(`window.__voice.partial("build it")`);
await sleep(200);
await b.evaluate(`document.querySelector(".architect__input").closest("form").requestSubmit()`);
s = await waitReply(beforeBuild.users.length);
await sleep(600);
s = await state();
const builds = s.users.slice(beforeBuild.users.length);
expect("typed Send while listening: “build it” runs exactly once, the speech session is dropped", builds.length === 1 && /Applied/.test(s.last.tags), JSON.stringify(builds));
const built = await records();
const roomRow = built.find((row) => /^room-\d+Kitchen/.test(row)) ?? "(missing)";
expect("the 3D result: one 5 m × 4.5 m kitchen in the record book", /\| 5\.00 \|/.test(roomRow) && /Width 4\.50/.test(roomRow), roomRow);
expect("with its four walls (plus the startup wall) - nothing built twice", built.filter((row) => row.startsWith("wall-")).length === 5, `${built.length} rows`);
await b.shot(outDir, "71-built");

// 6. Stop while half-way through speaking: nothing is sent, nothing changes.
const beforeStop = await state();
if (!beforeStop.speaking && !beforeStop.listening) await click(".architect__mic");
else await click(".architect__mic");
await sleep(300);
await b.evaluate(`window.__voice.partial("move it two metres")`);
await sleep(200);
await click(".copilot__stop");
await sleep(800);
s = await state();
expect("Stop with half-heard words: nothing sent", s.users.length === beforeStop.users.length, JSON.stringify(s.users.slice(beforeStop.users.length)));
expect("Stop: no speech, no listening, hands-free off", !s.speaking && !s.listening && !(await b.evaluate(`document.querySelector(".architect__hands-free").getAttribute("aria-pressed") === "true"`)));
expect("Stop: the scene is unchanged", JSON.stringify(await records()) === JSON.stringify(built));
await b.shot(outDir, "72-stopped");

// 7. Stop after a FINAL result has arrived but before the recogniser ended: still nothing is sent.
await click(".architect__mic");
await sleep(300);
const beforeFinalStop = await state();
expect("listening again (mic pressed)", beforeFinalStop.listening);
await b.evaluate(`window.__voice.finalOnly("move it two metres east")`);
await sleep(100);
await click(".copilot__stop");
await sleep(800);
s = await state();
expect(
  "Stop after a final result, before the recogniser ended: the words are dropped, not executed",
  s.users.length === beforeFinalStop.users.length && JSON.stringify(await records()) === JSON.stringify(built),
  JSON.stringify(s.users.slice(beforeFinalStop.users.length))
);

console.log(`\nspoken by the assistant (simulated synthesiser), ${await b.evaluate("window.__voice.spoken.length")} utterances; first: ${JSON.stringify((await b.evaluate("window.__voice.spoken[0]")).slice(0, 90))}`);
b.close();
finish();
