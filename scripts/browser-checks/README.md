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
   node scripts/browser-checks/plumbing.mjs
   node scripts/browser-checks/workspace.mjs
   node scripts/browser-checks/coordinates.mjs
   ```

   `WIN=1280x800` (or `1024x768`) changes the window size; an optional first argument is a folder for screenshots (default: `<temp>/iarchitect-browser-checks/shots`).

**Housekeeping.** Each run refuses to start with less than 500 MB free, uses a throwaway Chrome profile under `<temp>/iarchitect-browser-checks/`, keeps Chrome's caches and scratch folders inside it, and deletes it (and kills its own Chrome) on exit - including after a failure or the 8-minute watchdog. `save-reopen.mjs` creates a throwaway account on the mock backend with credentials generated at run time; they are never printed and disappear with the mock.

**`save-reopen.mjs`** builds a kitchen and a bedroom beside it by conversation, saves, reloads the page, opens the project, and checks the record book is identical with no duplicate ids. It then resizes the reopened bedroom by name and checks its own walls follow and the shared wall stays. Undo and Redo from the top bar must restore the record book exactly. Moving the kitchen off its shared wall must be refused with nothing changed. Finally it saves again, reopens, and moves the bedroom once more.

**`plumbing.mjs`** builds uPVC pipe runs by conversation ("Run a 25 mm water pipe from 0, 0 to 4, 0"), then checks:
- the fittings each run creates: a coupler that becomes a 25 × 20 reducing tee when a branch joins, a 90° elbow, a drain 87.5° bend, and an unsupported 30° turn flagged instead of drawn
- the record book: each fitting once, pipe sizes in mm with their sheet source
- clicking a fitting row zooms the camera onto the joint (it takes the close-up screenshots), and clicking the fitting in that close-up selects one of its pipes
- top-bar Undo/Redo
- the ribbon's size presets, and Escape in the empty top-bar search still disarming the armed size
- the hidden "Coming soon" tabs and Annotate
- the top-bar search driving the Project tree
- save, reload and reopen with the record book unchanged
- the AI panel not covering the view controls at 1300, 1366, 1400 and 1440 px

**`workspace.mjs`** blocks every hosted backend (Render, Supabase, Fly.io, Vercel) inside its browser, so it stays local even against a dev server pointed at staging. It checks the light/dark theme:
- the one-click toggle in the top bar switches every main region (top bar, nav, ribbon, both sidebars, AI panel, view controls, command bar, status bar) and the 3D viewport's own rendered pixels
- text on each region meets 4.5:1 contrast in both themes
- the choice is saved, and after a reload the page is already dark when `<body>` is created (before the first paint and before the app starts)
- at 1280, 1366, 1440 and 1920 px the AI panel covers neither the view controls, the inspector nor the bottom panel

**`coordinates.mjs`** (milestone 3) blocks every hosted backend like `workspace.mjs` and uses a throwaway account on the local mock backend. It checks:
- the defaults: "Snap: 0.1 m" on the Snap button, Snap 0.1 m and Grid 1 m in the status bar, a scale bar with a round length that grows when the view zooms out
- the X/Y/Z axes and origin marker in the rendered pixels (hiding them in Grid & plot changes the view)
- "Set the plot to 30 metres by 40 metres." and "Set the grid spacing to half a metre." by conversation; the popover's plot fields and grid select follow; choosing a 0.25 m snap step in the popover updates the Snap button and status bar
- "Create a 4.5 by 5 metre kitchen at X 8, Y 6." (answering its questions): the record book and the inspector (X 8, Z 6, 4.5 × 5 m, 2.7 m ceiling; rotation and height read-only)
- an inspector move (X 9.5) taking all four of the kitchen's walls with it; an impossible width refused with its reason, the field put back, nothing changed; top-bar Undo and Redo
- "Move the kitchen two metres to the right.", "Make the kitchen 4.5 metres wide.", "Move the room to X 10, Y 8." and "Turn snapping off." - each applied and confirmed, nothing duplicated, inspector in agreement
- the dimension labels in the rendered pixels in the light and dark themes, with the summary unchanged and the model untouched by the switch
- the popover's 30 × 40 m preset and a refused 2 m plot, the kitchen untouched
- save, reload (workspace settings kept: Snap Off, Grid 0.5 m) and reopen: the record book identical, the labels back, and the reopened kitchen moving to X 12, Y 8 with its walls

**`voice-simulated.mjs`** replaces only the browser's `SpeechRecognition` and `speechSynthesis` with scripted stand-ins, and refuses `getUserMedia`, so no microphone is involved. Its stand-in recogniser behaves like Chrome's continuous mode: a session never ends by itself, so the app's own end-of-turn pause is what is tested. It checks:
- hands-free speaking with the mic closed by default (interrupting by speaking is opt-in); turning it on in ⚙ Voice (saved), then speaking with the mic held open (recognition continuous, in English (India)), and barge-in with the mic button
- a reply read to the end: the session that heard it is dropped and a fresh one opened, so answering with the reply's own words (its "Set up a 30 × 20 m site" choice) is sent in full
- a short pause (0.9 s) not ending the turn; the 1.6 s pause ending it
- talking over a reply: its own echo does not interrupt it; the user's words stop the speech at once, the state chip says Listening, and the echoed lead-in is not sent
- partial words shown but not sent
- a complete spoken room request reaching the preview, with "four by five" read as "4 by 5"
- a correction mid-speech
- an ambiguous correction being asked about, then answered by voice
- a typed Send while the recogniser holds the same words running exactly once
- the 3D result in the record book
- Stop dropping half-heard words, including after a final result has arrived
- a request still thinking (the AI reply held inside the test browser with Chrome's Fetch interception - it never reaches a backend; a throwaway account on the LOCAL mock backend): the state says Thinking; Stop says Stopped at once and the late reply changes nothing and is never shown; a newer instruction replaces it at once and the old reply arriving later changes nothing

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
- First turn on ⚙ Voice → "Speaking over a reply interrupts it" (off by default) and wear headphones - with speakers the microphone hears the reply itself.
- While it is still speaking, just say *"make it four point five metres wide"* (no button).
- Expect: the speech stops within a word or two, the state chip reads Listening, and the preview becomes 4 m × 4.5 m.
- Repeat with the mic button instead: press 🎤 while it speaks, then say it. Same result.
- Pause mid-sentence for under a second ("make it four… point five metres wide"): expect it to keep listening, not send half a sentence.
- With that setting off (the default), talking over it does nothing; 🎤 Speak or Stop interrupt it at once.

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
- Then ask it again and press **■ Stop** while the state chip reads *Thinking*. Expect: *Stopped* at once, a note that the request was cancelled, and nothing added to the scene or the Measurements tab when Claude's answer arrives a moment later.

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
