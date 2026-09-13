import * as THREE from "three";

/**
 * The viewport's backdrop: a soft vertical gradient rather than a single
 * flat fill color - a cheap, texture-free stand-in for a photography-
 * studio cyclorama. A lighter band sits at the horizon (roughly where
 * the camera naturally looks when a building is framed), receding to a
 * darker tone above and below, so a building reads as standing IN a
 * space rather than floating in a flat void - the single biggest lever
 * on "does this look like a void" without adding a literal sky, city, or
 * landscape (left for a later milestone). Deliberately kept inside the
 * same near-neutral dark family as the rest of the shell (see styles.css
 * :root's --color-bg) rather than a blue "sky" tone, so it never tints
 * how a material's own color reads against it.
 *
 * A 2x256 canvas is plenty: it's stretched to fill the background, never
 * sampled at an angle, so no vertical banding is visible at any window
 * size.
 */
export function createHorizonBackground(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Extremely defensive - every real browser supports 2d canvas
    // contexts. Falls back to a flat texture rather than throwing.
    const texture = new THREE.Texture();
    return texture;
  }
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#1c1e25"); // zenith
  gradient.addColorStop(0.58, "#2d303b"); // horizon - the lightest band
  gradient.addColorStop(1, "#101116"); // recedes into the ground's own tone
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Matches the gradient's horizon band, so distant geometry fades into the same tone instead of a mismatched flat fog color. */
export const HORIZON_FOG_COLOR = 0x22242c;
