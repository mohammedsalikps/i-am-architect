// A small headless-Chrome harness for the browser checks in this folder,
// over the DevTools protocol (Node 22+, no dependencies).
//
// - Refuses to start when the temp drive has less than 500 MB free.
// - Every run gets its own throwaway profile under
//   <os temp>/iarchitect-browser-checks/; on exit the run kills its own
//   Chrome process tree and deletes only the profile it created.
// - Chrome's disk and media caches are capped at 1 MB.
// - The app's own confirm() prompts are logged and accepted.
// - A watchdog ends a hung run through the same cleanup.
//
// CHROME_PATH overrides the Chrome executable.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

export const PROFILE_ROOT = join(tmpdir(), "iarchitect-browser-checks");
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const DEFAULT_CHROME =
  platform() === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : platform() === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "google-chrome";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(pid) {
  if (platform() === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/** Starts headless Chrome on `port` with a fresh profile and connects to its page. */
export async function launch({ name, width = 1440, height = 900, port = 9340, maxSeconds = 480 }) {
  mkdirSync(PROFILE_ROOT, { recursive: true });
  const stats = statfsSync(PROFILE_ROOT);
  const free = stats.bavail * stats.bsize;
  if (free < MIN_FREE_BYTES) {
    throw new Error(`Only ${(free / 1024 / 1024).toFixed(0)} MB free for ${PROFILE_ROOT} - not starting a browser profile (needs ${MIN_FREE_BYTES / 1024 / 1024} MB).`);
  }
  setTimeout(() => {
    console.error(`watchdog: still running after ${maxSeconds} s - stopping`);
    process.exit(2);
  }, maxSeconds * 1000).unref();

  const profile = join(PROFILE_ROOT, `${name}-${process.pid}`);
  // Chrome's own scratch folders (scoped_dir*) go inside the profile too, so they are removed with it.
  const scratch = join(profile, "tmp");
  mkdirSync(scratch, { recursive: true });
  const chrome = spawn(process.env.CHROME_PATH ?? DEFAULT_CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--disk-cache-size=1048576",
    "--media-cache-size=1048576",
    "--no-first-run",
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch } });
  process.on("exit", () => {
    killTree(chrome.pid);
    // Windows can hold the profile's files for many seconds after Chrome is killed - retry for up to ~30 s.
    for (let attempt = 0; attempt < 60 && existsSync(profile); attempt += 1) {
      const until = Date.now() + (attempt === 0 ? 800 : 500);
      while (Date.now() < until) {}
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    }
    if (existsSync(profile)) console.error(`could not remove the test profile ${profile} - remove it by hand`);
  });
  process.on("uncaughtException", (error) => {
    console.error(error);
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    console.error(error);
    process.exit(1);
  });

  let target = null;
  for (let i = 0; i < 100 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://localhost:${port}/json`)).json();
      target = list.find((entry) => entry.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error(`no DevTools target on port ${port} - is another Chrome using it?`);
  const ws = new WebSocket(target);
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  let id = 0;
  const pending = new Map();
  /** Protocol event listeners, by method (e.g. "Fetch.requestPaused") - see on(). */
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) listener(message.params);
    }
    if (message.method === "Page.javascriptDialogOpening") {
      console.log(`dialog (${message.params.type}) accepted: ${message.params.message}`);
      ws.send(JSON.stringify({ id: 1e9 + Math.floor(Math.random() * 1e6), method: "Page.handleJavaScriptDialog", params: { accept: true } }));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails).slice(0, 400));
    return response.result?.result?.value;
  };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    send,
    evaluate,
    /** Calls `listener(params)` for every protocol event named `method`. */
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    async shot(outDir, shotName) {
      const { result } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `${shotName}.png`), Buffer.from(result.data, "base64"));
    },
    async goto(url, readyExpression) {
      await send("Page.navigate", { url });
      for (let i = 0; i < 60; i += 1) {
        await sleep(1000);
        if (await evaluate(readyExpression).catch(() => false)) return true;
      }
      return false;
    },
    async waitFor(expression, timeoutMs = 20000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (await evaluate(expression).catch(() => false)) return true;
        await sleep(300);
      }
      return false;
    },
    close() {
      ws.close();
    }
  };
}

/** Decodes an 8-bit, non-interlaced RGB(A) PNG - what Page.captureScreenshot returns. */
export function decodePng(buffer) {
  let position = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (position < buffer.length) {
    const length = buffer.readUInt32BE(position);
    const type = buffer.toString("ascii", position + 4, position + 8);
    const data = buffer.subarray(position + 8, position + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    position += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let result = value;
      if (filter === 1) result = value + left;
      else if (filter === 2) result = value + up;
      else if (filter === 3) result = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[y * stride + x] = result & 255;
    }
  }
  return { width, height, bpp, data: out };
}

/** Runs `checks`, printing PASS/FAIL lines; exits 0 only when every expectation held. */
export function expectations() {
  let failures = 0;
  return {
    expect(label, condition, detail = "") {
      if (!condition) failures += 1;
      console.log(`${condition ? "PASS" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
    },
    finish() {
      console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
      process.exit(failures === 0 ? 0 : 1);
    }
  };
}
