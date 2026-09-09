import { defineConfig } from "vite";

// Minimal Vite config. Kept intentionally small for this milestone -
// no aliases, no plugins beyond defaults, nothing construction-specific yet.
export default defineConfig({
  server: {
    port: 5173
  }
});
