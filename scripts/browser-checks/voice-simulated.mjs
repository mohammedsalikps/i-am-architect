// SIMULATED SPEECH in a real (headless) Chrome - see README.md.
// The real app, panel, hands-free controller, architect session and 3D
// scene run as usual; only the browser's speech recogniser and speech
// synthesiser are replaced by scripted stand-ins injected before the page
// loads. No microphone is used (the level meter's getUserMedia is refused)
// and no audio is played or heard. This is NOT a real-microphone test and
// NOT a live-Claude test. The AI requests in step 8 are held and answered
// inside this browser (Chrome's Fetch interception) - they never reach a
// backend; the throwaway account is on the LOCAL in-memory mock backend.
// Usage: node scripts/browser-checks/voice-simulated.mjs [screenshotDir]
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
const b = await launch({ name: "voice", width: W, height: H, port: 9342 });
const { expect, finish } = expectations();

const FAKES = `(() => {
  const voice = (window.__voice = { sessions: 0, spoken: [], speaking: null, current: null, cancelledSpeech: 0 });
  class FakeRecognition {
    constructor() { this.lang = ""; this.interimResults = false; this.continuous = false; this.maxAlternatives = 1; this.onresult = null; this.onerror = null; this.onend = null; this.active = false; voice.current = this; }
    start() { this.active = true; voice.sessions += 1; voice.lastContinuous = this.continuous; voice.lastLang = this.lang; }
    stop() { if (!this.active) return; this.active = false; setTimeout(() => this.onend && this.onend(), 30); }
    abort() { if (!this.active) return; this.active = false; setTimeout(() => { this.onerror && this.onerror({ error: "aborted" }); this.onend && this.onend(); }, 30); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  const result = (transcript, isFinal) => ({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] });
  voice.partial = (text) => { const r = voice.current; if (!r || !r.active) return false; r.onresult(result(text, false)); return true; };
  /** A final result that has arrived while the recogniser hasn't ended yet (Chrome ends a moment later). */
  voice.finalOnly = (text) => { const r = voice.current; if (!r || !r.active) return false; r.onresult(result(text, true)); return true; };
  /** Partial words, then the final transcript. A non-continuous session ends by itself, as Chrome's does; a continuous one only ends when the app stops it (its own end-of-turn pause). */
  voice.say = async (partials, final) => {
    const r = voice.current;
    if (!r || !r.active) return "not listening";
    for (const text of partials) { r.onresult(result(text, false)); await new Promise((done) => setTimeout(done, 150)); }
    r.onresult(result(final, true));
    if (r.continuous) return "said";
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
    stopVisible: !document.querySelector(".copilot__stop").hidden,
    chip: document.querySelector(".architect__state")?.textContent ?? "",
    notes: [...document.querySelectorAll(".architect__msg--note")].map((node) => node.textContent)
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

// 1. Hands-free on, default settings: the assistant speaks with the mic closed (interrupting by speaking is opt-in - it needs headphones).
await click(".architect__hands-free");
await sleep(400);
let s = await state();
expect("default: hands-free speaks with the mic closed; Stop is offered; the state says Speaking", s.speaking && !s.listening && s.stopVisible && s.chip === "Speaking", `${s.chip} / ${s.copilot}`);
// Turn "speaking over a reply interrupts it" on, in the Voice settings - saved for next time.
await click(".architect__hands-free");
await sleep(300);
await click(".architect__voice-settings-toggle");
await sleep(300);
await b.evaluate(`(() => { const box = document.querySelector(".architect__voice-settings input[type=checkbox]"); box.checked = true; box.dispatchEvent(new Event("change")); })()`);
await sleep(200);
expect("Voice settings: interrupt-by-speaking turned on and saved", JSON.parse((await b.evaluate(`localStorage.getItem("iarchitect.voice")`)) ?? "{}").bargeIn === true);
await click(".architect__voice-settings-toggle");
await click(".architect__hands-free");
await sleep(400);
s = await state();
expect("with it on: the assistant speaks with the mic held open for interruptions; Stop is offered; the state says Speaking", s.speaking && s.listening && s.stopVisible && s.chip === "Speaking", `${s.chip} / ${s.copilot}`);
expect("recognition is continuous, in English (India) - the app, not the browser, decides when a turn ends", (await b.evaluate("window.__voice.lastContinuous")) === true && (await b.evaluate("window.__voice.lastLang")) === "en-IN", String(await b.evaluate("window.__voice.lastLang")));

// 1b. The greeting read to the end, not interrupted: the session that heard it is dropped and the answer heard afresh - so answering
// with the reply's own words (its "Set up a 30 × 20 m site" choice) is sent in full, never cut down as "echo".
const sessionsBefore = await b.evaluate("window.__voice.sessions");
await b.evaluate("window.__voice.finishSpeaking()");
await sleep(400);
s = await state();
expect("reply finished: a fresh listening session (the one that heard the reply is dropped)", !s.speaking && s.listening && (await b.evaluate("window.__voice.sessions")) === sessionsBefore + 1 && s.chip === "Listening", `${s.chip}, sessions ${sessionsBefore} -> ${await b.evaluate("window.__voice.sessions")}`);
const usersBeforeSite = s.users.length;
await b.evaluate(`window.__voice.say(["set up a thirty"], "set up a thirty by twenty metre site")`);
s = await waitReply(usersBeforeSite);
expect("answering with the reply's own words is sent in full", /set up a 30 by 20 metre site/.test(s.users.at(-1) ?? "") && /Site set: 30 × 20 m/.test(s.last.text), `${s.users.at(-1)} | ${s.last.text.slice(0, 80)}`);

// 2. Interrupt the speech with the mic, then speak a complete room request (partial words first).
await click(".architect__mic");
await sleep(300);
s = await state();
expect("pressing the mic while it speaks cuts the speech at once and listens", !s.speaking && s.listening && s.cancelledSpeech > 0, s.copilot);
await b.evaluate(`window.__voice.partial("create a four by five")`);
await sleep(300);
s = await state();
expect("partial words are shown as heard - nothing sent yet", s.box === "create a four by five" && s.users.length === usersBeforeSite + 1 && /four by five/.test(s.transcript), `box “${s.box}”`);
await sleep(900);
s = await state();
expect("a short pause (0.9 s, under the 1.6 s end-of-turn pause) does not end the turn", s.users.length === usersBeforeSite + 1 && s.listening, `listening ${s.listening}, sent ${s.users.length}`);
const usersBefore = s.users.length;
await b.evaluate(`window.__voice.say(["create a four by five metre kitchen"], "create a four by five metre kitchen three metres high on the ground floor brick walls at zero zero")`);
s = await waitReply(usersBefore);
expect("the final transcript is sent once", s.users.length === usersBefore + 1, JSON.stringify(s.users));
expect("the numbers said as words are shown as read", /→ “create a 4 by 5 metre kitchen 3 metres high on the ground floor brick walls at 0 0”/.test(s.users.at(-1)), s.users.at(-1));
expect("a complete spoken request goes straight to the preview", /Preview/.test(s.last.tags) && /4 m × 5 m kitchen/.test(s.last.text), s.last.text.slice(0, 120));
expect("and the preview is being read out", s.speaking);
await b.shot(outDir, "70-spoken-preview");

// 3. Correct a dimension by TALKING OVER the preview while it is read (no button): its own echo first, then the user's words.
const beforeCorrection = await state();
const echo = (await b.evaluate("window.__voice.speaking ? window.__voice.speaking.text : ''")).split(/\s+/).slice(0, 7).join(" ");
await b.evaluate(`window.__voice.partial(${JSON.stringify(echo)})`);
await sleep(300);
s = await state();
expect(`the reply's own echo (“${echo}”) does not interrupt it`, s.speaking && s.cancelledSpeech === beforeCorrection.cancelledSpeech && s.chip === "Speaking", s.chip);
await b.evaluate(`window.__voice.partial("make it four point five")`);
await sleep(150);
s = await state();
expect("the user's own words stop the speech at once - the state says Listening", !s.speaking && s.cancelledSpeech === beforeCorrection.cancelledSpeech + 1 && s.chip === "Listening", `${s.chip}, cancelled ${s.cancelledSpeech}`);
await b.evaluate(`window.__voice.finalOnly(${JSON.stringify(`${echo} make it four point five metres wide`)})`);
let step = { after: await waitReply(beforeCorrection.users.length) };
expect("the correction (its echoed lead-in removed) is applied to the preview", /4 m × 4\.5 m kitchen/.test(step.after.last.text) && /Preview/.test(step.after.last.tags) && /make it four point five metres wide/.test(step.after.users.at(-1)) && !step.after.users.at(-1).toLowerCase().includes(echo.toLowerCase().split(" ")[0] + " " + echo.toLowerCase().split(" ")[1]), `${step.after.users.at(-1)} | ${step.after.last.text.slice(0, 80)}`);

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

// 8. A request still THINKING (the AI reply held in this browser): Stop cancels it, and a newer correction replaces it - the late reply changes nothing.
await click(".copilot__stop");
await sleep(500);
await b.evaluate(`document.querySelector(".app-header__account .toolbar-button--primary").click()`);
await b.waitFor(`!!document.querySelector(".auth-dialog__title")?.textContent`);
if ((await b.evaluate(`document.querySelector(".auth-dialog__title").textContent`)) === "Sign in") {
  await b.evaluate(`document.querySelector(".auth-dialog__link").click()`);
  await sleep(300);
}
const email = `voice-${randomUUID().slice(0, 8)}@example.test`;
const password = randomUUID();
await b.evaluate(`(() => { const [emailInput, passwordInput] = document.querySelectorAll(".auth-dialog__input"); emailInput.value = ${JSON.stringify(email)}; passwordInput.value = ${JSON.stringify(password)}; document.querySelector(".auth-dialog__form").requestSubmit(); })()`);
expect("a throwaway account on the local mock backend", await b.waitFor(`!!document.querySelector(".app-header__account-name")?.textContent.trim()`, 20000));
const held = [];
b.on("Fetch.requestPaused", (params) => {
  // Preflights go on to the local mock backend; the POST itself is held here.
  if (params.request.method === "OPTIONS") void b.send("Fetch.continueRequest", { requestId: params.requestId });
  else held.push(params);
});
await b.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/ai/interpret*", requestStage: "Request" }] });
const origin = new URL(APP).origin;
/** The held AI request answered at last - with a real command, so an applied reply would add a wall at (20, 20). */
const answerLate = (request) =>
  b.send("Fetch.fulfillRequest", {
    requestId: request.requestId,
    responseCode: 200,
    responseHeaders: [
      { name: "Content-Type", value: "application/json" },
      { name: "Access-Control-Allow-Origin", value: origin },
      { name: "Vary", value: "Origin" }
    ],
    body: Buffer.from(JSON.stringify({ commands: [{ type: "wall.add", wall: { position: { x: 20, z: 20 } } }], notes: "late reply" })).toString("base64")
  });
const typeAndSend = (text) => b.evaluate(`(() => { const input = document.querySelector(".architect__input"); input.value = ${JSON.stringify(text)}; input.closest("form").requestSubmit(); })()`);
const strayWall = (rows) => rows.some((row) => /^wall-\d+/.test(row) && /20\.00, [\d.]+, 20\.00/.test(row));
const beforeThinking = await records();
const replies = () => b.evaluate(`document.querySelectorAll(".architect__msg--architect").length`);
const repliesBeforeStop = await replies();

await typeAndSend("add a garden pergola by the gate");
expect("an unrecognised request goes to the AI (request held)", await b.waitFor(`true`, 100).then(async () => { for (let i = 0; i < 40 && held.length === 0; i += 1) await sleep(250); return held.length === 1; }));
s = await state();
expect("while it waits: the state says Thinking, Stop is offered, the box stays usable", s.chip === "Thinking" && s.stopVisible && !(await b.evaluate(`document.querySelector(".architect__input").disabled`)), s.chip);
await click(".copilot__stop");
await sleep(400);
s = await state();
expect("Stop while thinking: the state says Stopped and the conversation says it was cancelled", s.chip === "Stopped" && s.notes.some((note) => /Stopped - “add a garden pergola by the gate” was cancelled/.test(note)), `${s.chip} | ${s.notes.at(-1)}`);
await answerLate(held.shift());
await sleep(1500);
const afterStop = await records();
expect("the late AI reply arrives after Stop: nothing is applied or shown - no wall at (20, 20), the record book unchanged, no new reply", !strayWall(afterStop) && JSON.stringify(afterStop) === JSON.stringify(beforeThinking) && (await replies()) === repliesBeforeStop, `${afterStop.length} rows, replies ${repliesBeforeStop} -> ${await replies()}`);

await typeAndSend("add a garden pergola by the gate");
for (let i = 0; i < 40 && held.length === 0; i += 1) await sleep(250);
expect("asked again: held again", held.length === 1);
await typeAndSend("Create a 3 by 3 metre store at 12, 0, 3 metres high, brick walls, on the ground floor");
await b.waitFor(`/3 m × 3 m store/.test([...document.querySelectorAll(".architect__msg--architect .architect__text")].at(-1)?.textContent ?? "")`, 15000);
s = await state();
expect("a newer instruction while it thinks replaces the old request at once", /Replaced - “add a garden pergola by the gate”/.test(s.notes.at(-1) ?? "") && /3 m × 3 m store/.test(s.last.text), s.notes.at(-1));
await answerLate(held.shift());
await sleep(1500);
await typeAndSend("build it");
await b.waitFor(`/Built room-/.test([...document.querySelectorAll(".architect__msg--architect .architect__text")].at(-1)?.textContent ?? "")`, 15000);
const afterSupersede = await records();
expect("the old reply arriving later changes nothing: the store and its four walls are built, no wall at (20, 20)", !strayWall(afterSupersede) && afterSupersede.filter((row) => /^room-\d+Store/.test(row)).length === 1 && afterSupersede.filter((row) => row.startsWith("wall-")).length === beforeThinking.filter((row) => row.startsWith("wall-")).length + 4, `${afterSupersede.length} rows`);
await b.shot(outDir, "73-cancelled-turns");

console.log(`\nspoken by the assistant (simulated synthesiser), ${await b.evaluate("window.__voice.spoken.length")} utterances; first: ${JSON.stringify((await b.evaluate("window.__voice.spoken[0]")).slice(0, 90))}`);
b.close();
finish();
