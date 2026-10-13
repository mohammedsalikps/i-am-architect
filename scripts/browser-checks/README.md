# Browser checks

Two kinds of check live here, and they prove different things:

| | What runs | What it proves | What it does **not** prove |
|---|---|---|---|
| **Automated, simulated** (`voice-simulated.mjs`, `save-reopen.mjs`) | The real app in headless Chrome against the **local** dev server and the in-memory mock backend | The panel, hands-free controller, architect session, commands, record book, save/open and 3D scene work together | Anything about a real microphone, real speech recognition accuracy, real speech output, or the live backend / Claude |
| **Manual** (the procedure below) | A person, desktop Chrome, a real microphone and speakers/headset; optionally the real backend | Real voice behaviour, and (test V8 only) a live Claude answer | — |

Never record a manual test as passed from an automated run, or the other way round.

## Automated checks (local stack only)

Needs Node 22+ and desktop Chrome (`CHROME_PATH` overrides the default location).

1. Start the in-memory mock backend (no keys, no external calls; accounts and projects vanish when it stops):

   ```bash
   cd backend && FRONTEND_ORIGIN=http://localhost:5174 node mockBackend.ts
   ```

2. In another terminal, start a dev server pointed at it:

   ```bash
   VITE_AI_BACKEND_URL=http://localhost:8787 npx vite --port 5174 --strictPort
   ```

3. Run the checks (each prints `PASS`/`FAIL` lines and exits non-zero on any failure):

   ```bash
   node scripts/browser-checks/save-reopen.mjs
   node scripts/browser-checks/voice-simulated.mjs
   ```

   `WIN=1280x800` (or `1024x768`) changes the window size; an optional first argument is a folder for screenshots (default: `<temp>/iarchitect-browser-checks/shots`).

**Housekeeping.** Each run refuses to start with less than 500 MB free, uses a throwaway Chrome profile under `<temp>/iarchitect-browser-checks/`, keeps Chrome's caches and scratch folders inside it, and deletes it (and kills its own Chrome) on exit - including after a failure or the 8-minute watchdog. `save-reopen.mjs` creates a throwaway account on the mock backend with credentials generated at run time; they are never printed and disappear with the mock.

**`save-reopen.mjs`** builds a kitchen and a bedroom beside it by conversation, saves, reloads the page, opens the project, and checks the record book is identical with no duplicate ids. It then resizes the reopened bedroom by name and checks its own walls follow and the shared wall stays. Undo and Redo from the top bar must restore the record book exactly. Moving the kitchen off its shared wall must be refused with nothing changed. Finally it saves again, reopens, and moves the bedroom once more.

**`voice-simulated.mjs`** replaces only the browser's `SpeechRecognition` and `speechSynthesis` with scripted stand-ins, and refuses `getUserMedia`, so no microphone is involved. It checks:
- hands-free speaking, and barge-in with the mic
- partial words shown but not sent
- a complete spoken room request reaching the preview, with "four by five" read as "4 by 5"
- a correction mid-speech
- an ambiguous correction being asked about, then answered by voice
- a typed Send while the recogniser holds the same words running exactly once
- the 3D result in the record book
- Stop dropping half-heard words, including after a final result has arrived

## Manual procedure: real microphone (and, in V8 only, live Claude)

**Setup.** Desktop Chrome (note the version), a working microphone, and a headset or speakers. Run the app locally (`npm run dev`) or on staging. Speak at a normal pace in a quiet room. Speech recognition uses the browser's language (`navigator.language`). Chrome's own recogniser may process audio on Google's servers; that is browser behaviour, not this app's code. The first press of 🎤 makes Chrome ask for the microphone: the person testing allows it in Chrome's own prompt.

Copy the table at the end and fill it in for every run.

**V1 - Listening.** Press 🎤.
- Expect: the copilot shows *Listening…*, the level bars move while you talk, and ■ Stop is shown.
- Say nothing for a few seconds. Expect: listening ends with "I didn't hear anything" and nothing is sent.

**V2 - A complete room request by voice.** Press 🎤 and say: *"Create a four by five metre kitchen, three metres high, on the ground floor, with brick walls, at zero comma zero."*
- Expect, while speaking: your words appear in the box and transcript line as you speak.
- Expect, after you pause: **one** message "🎤 *(as heard)*", followed by "→ *(as read)*" if any numbers were said as words.
- Expect a reply tagged **Preview**: "Ready to build a 4 m × 5 m kitchen … centred at (0, 0)".
- Expect a translucent blue box in the 3D view with 4 m / 5 m / ↕ 3 m labels, framed by the camera.
- Expect the stepper to show Listening and Understanding done, Clarifying skipped (no question was needed) and Previewing active.
- If the recogniser mishears a number, the architect must ask; it must never build a guessed size. Note what was heard.

**V3 - Correcting a dimension while the assistant is speaking.** Turn on 🔊 hands-free; it starts reading the preview.
- While it is still speaking, press 🎤 and say *"make it four point five metres wide"*.
- Expect: the speech stops immediately, and you're listening.
- Expect: the preview becomes 4 m × 4.5 m and is read out again.
- (Talking over the assistant *without* pressing 🎤 is not supported: the mic is closed while it speaks.)

**V4 - An ambiguous correction.** While it reads, press 🎤 and say *"make it five metres"*.
- Expect the question "Is 5 m the room's length (east–west), width (north–south) or ceiling height?" with nothing built.
- Say *"length"*. Expect the preview to become 5 m × 4.5 m.

**V5 - Interrupting.**
- While it speaks, press 🎤. Expect: it stops at once and listens.
- Start saying *"move it two metres…"* and press **■ Stop** before you finish.
- Expect: no message is sent, nothing changes, hands-free is off, and the copilot reads *Stopped.*

**V6 - No duplicate execution.** Throughout V2–V7, count: exactly one 🎤 message per utterance and at most one **Applied ✓** per change.
- Also press 🎤, say *"build it"* and press **Send** before pausing. Expect one *"build it"* message only.

**V7 - Confirm the actual 3D result.** Say *"build it"* (or press Build it).
- Expect **Applied ✓** and a 5 m × 4.5 m room with four brick walls in the 3D view.
- Measurements tab: the room 5.00 m long, *Width 4.50*, 22.5 m². Front and back walls 5.23 m; left and right walls 4.27 m, all 3.00 m high and 0.23 m thick.
- Say *"undo"*. Expect the room and all four walls removed, with an **Undone ✓** tag.

**V8 - Live Claude (backend required).** Only with the app pointed at the real backend and signed in. Room building above is handled by the app's own rules and does **not** call Claude.
- Say something the app doesn't handle itself, e.g. *"add a garden pergola by the gate"*.
- Passes only if the reply carries the **AI model** tag. Record the reply.
- A sign-in, timeout or "unable to connect" message is a fail for V8 (note it), never a pass.

### Results record

| Test | Date | Chrome version | Mic / headset | Backend (local / staging) | Heard as | Result (pass / fail) | Notes |
|---|---|---|---|---|---|---|---|
| V1 | | | | | | | |
| V2 | | | | | | | |
| V3 | | | | | | | |
| V4 | | | | | | | |
| V5 | | | | | | | |
| V6 | | | | | | | |
| V7 | | | | | | | |
| V8 | | | | | | | |
