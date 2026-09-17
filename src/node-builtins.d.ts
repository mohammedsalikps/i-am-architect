/**
 * Minimal ambient declarations for the handful of Node built-ins this
 * project's Node-run verify.ts scripts use (source-text scanning in
 * src/engine/ai/providers/verify.ts and src/engine/ai/e2e/verify.ts;
 * existsSync's own thumbnail-file check in src/engine/assets/verify.ts).
 *
 * The root tsconfig.json - used by `npm run build`'s `tsc --noEmit`,
 * which type-checks every file under src/ whether or not the app
 * imports it - deliberately has no Node types: this is a browser/Vite
 * frontend, and it shouldn't gain an @types/node dependency just so two
 * test scripts can read files off disk.
 *
 * A `.d.ts` file is where TypeScript expects a fresh ambient module
 * declaration like this to live. In a regular `.ts` module file,
 * `declare module "x"` is instead treated as *augmenting* an existing
 * module's types, which fails outright when no such types exist.
 *
 * None of this affects how those scripts actually run: Node's own
 * TypeScript execution resolves "node:fs"/"node:url" itself at runtime
 * regardless of what TypeScript believes about them. This file exists
 * purely to satisfy `tsc --noEmit`. The same reasoning is why those
 * scripts avoid the Node-only `process` global entirely rather than
 * declaring it - see their exit-handling comments.
 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
  export function existsSync(path: string): boolean;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
