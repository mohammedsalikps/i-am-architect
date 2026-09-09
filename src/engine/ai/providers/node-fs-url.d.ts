/**
 * Minimal ambient module declarations for the two Node built-ins
 * verify.ts's static source-scan check uses ("node:fs"'s
 * `readFileSync`, "node:url"'s `fileURLToPath`). The root
 * tsconfig.json (used by `npm run build`'s `tsc --noEmit`, which
 * type-checks every file under src/ regardless of whether the app
 * actually imports it) deliberately has no Node types - this is a
 * browser/Vite frontend project with no @types/node dependency, and
 * shouldn't gain one project-wide just for one test file's file-reading
 * check.
 *
 * A `.d.ts` file (unlike a regular `.ts` module file, where `declare
 * module "x"` is always treated as *augmenting* an existing module's
 * types rather than declaring a brand-new one) is exactly where
 * TypeScript expects a fresh ambient module declaration like this to
 * live.
 *
 * This has no effect on how verify.ts actually runs: Node's own native
 * TypeScript execution (`node providers/verify.ts` - see "npm run
 * verify") resolves "node:fs"/"node:url" itself at runtime regardless
 * of what TypeScript thinks their types are. This file only exists to
 * satisfy `tsc --noEmit`. Same reasoning that led verify.ts's own exit
 * handling (here and in ai/verify.ts) to avoid the Node-only `process`
 * global entirely rather than type it - see those files' comments.
 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
