import * as THREE from "three";

/**
 * The viewport's backdrop: a soft vertical gradient rather than a single
 * flat fill color - a cheap, texture-free stand-in for a photography-
 * studio cyclorama. A lighter band sits at the horizon (roughly where
 * the camera naturally looks when a building is framed), receding to a
 * slightly deeper neutral tone above and below, so a building reads as
 * standing IN a bright, clean studio space rather than floating in a
 * dark void.
 *
 * Rescue-milestone revision: previously this stayed inside the shell's
 * own near-black UI palette, on the theory that a dark surround would
 * never tint a material's color. In practice, for a presentation, that
 * read as "empty black void" rather than "studio" - the single most
 * common piece of negative feedback on the viewport. A light neutral
 * grey cyclorama (the literal, real-world photography/architectural-viz
 * convention this comment already named) fixes that directly, and stays
 * "neutral architectural studio" rather than a blue "sky" tone, which
 * would tint every material's apparent color against it.
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
  gradient.addColorStop(0, "#dfe1e6"); // zenith
  gradient.addColorStop(0.55, "#f2f1ee"); // horizon - the lightest band, an off-white studio backdrop
  gradient.addColorStop(1, "#c7c8cc"); // recedes toward the ground's own tone
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Matches the gradient's lower band, so distant geometry fades into the same tone instead of a mismatched flat fog color. */
export const HORIZON_FOG_COLOR = 0xc7c8cc;
