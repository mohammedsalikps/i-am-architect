import type { Theme } from "../ui/theme";

/**
 * The 3D viewport's colours for each workspace theme - the backdrop
 * gradient, the fog that fades distant geometry into it, the ground plane
 * and the grid, the X/Y/Z axes and origin marker, the plot outline, and
 * the labels drawn in the scene (dimensions, axis names). Construction
 * objects keep their own material colours in both themes (a brick wall is
 * the same brick); only the studio and the guides around them change.
 */
export interface ScenePalette {
  /** Backdrop gradient, top (zenith) to bottom. */
  sky: { zenith: string; horizon: string; ground: string };
  /** Matches the gradient's lower band, so far geometry fades into it. */
  fog: number;
  ground: number;
  /** Grid lines: major (every 5 m) and minor (the chosen spacing). */
  gridMajor: number;
  gridMinor: number;
  gridOpacity: number;
  /** X east, Y up, Z south - the conventional red, green, blue. */
  axisX: number;
  axisY: number;
  axisZ: number;
  origin: number;
  /** The plot's boundary. */
  plot: number;
  /** In-scene labels: text and its backing. */
  labelText: string;
  labelBackground: string;
  labelBorder: string;
}

export const SCENE_PALETTES: Readonly<Record<Theme, ScenePalette>> = {
  light: {
    // A clear daylight studio: soft blue overhead, a warm pale horizon, and a
    // stone-toned ground dark enough for white-rendered walls to stand out.
    sky: { zenith: "#b7cbe2", horizon: "#f1efe9", ground: "#e2dfd7" },
    fog: 0xe8e5de,
    ground: 0xd3d0c6,
    gridMajor: 0x77808b,
    gridMinor: 0x9ea5ad,
    gridOpacity: 0.5,
    axisX: 0xd23c2c,
    axisY: 0x2e9a4a,
    axisZ: 0x2a62c9,
    origin: 0x17233a,
    plot: 0xb08a3e,
    labelText: "#17233a",
    labelBackground: "rgba(255, 255, 255, 0.94)",
    labelBorder: "#1f5fbf"
  },
  dark: {
    sky: { zenith: "#0d1117", horizon: "#1f2630", ground: "#171c23" },
    fog: 0x181d24,
    ground: 0x262b33,
    gridMajor: 0x5d6878,
    gridMinor: 0x3a424e,
    gridOpacity: 0.7,
    axisX: 0xff6b5a,
    axisY: 0x5fd17f,
    axisZ: 0x6aa5ff,
    origin: 0xe5e9ef,
    plot: 0xd9b46a,
    labelText: "#e5e9ef",
    labelBackground: "rgba(25, 30, 38, 0.92)",
    labelBorder: "#6aa5ff"
  }
};
