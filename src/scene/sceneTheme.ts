import type { Theme } from "../ui/theme";

/**
 * The 3D viewport's colours for each workspace theme - the backdrop
 * gradient, the fog that fades distant geometry into it, the ground plane
 * and the grid. Construction objects keep their own material colours in
 * both themes (a brick wall is the same brick); only the studio around
 * them changes, so the model reads the same and the viewport matches the
 * chrome around it.
 */
export interface ScenePalette {
  /** Backdrop gradient, top (zenith) to bottom. */
  sky: { zenith: string; horizon: string; ground: string };
  /** Matches the gradient's lower band, so far geometry fades into it. */
  fog: number;
  ground: number;
  /** Grid lines: every 5th (major) and the rest (minor). */
  gridMajor: number;
  gridMinor: number;
  gridOpacity: number;
}

export const SCENE_PALETTES: Readonly<Record<Theme, ScenePalette>> = {
  light: {
    sky: { zenith: "#cfdcec", horizon: "#eef2f6", ground: "#e7e9ec" },
    fog: 0xe9ecef,
    ground: 0xdfe1dc,
    gridMajor: 0x7f8792,
    gridMinor: 0xa6adb6,
    gridOpacity: 0.5
  },
  dark: {
    sky: { zenith: "#0d1117", horizon: "#1f2630", ground: "#171c23" },
    fog: 0x181d24,
    ground: 0x262b33,
    gridMajor: 0x5d6878,
    gridMinor: 0x3a424e,
    gridOpacity: 0.7
  }
};
