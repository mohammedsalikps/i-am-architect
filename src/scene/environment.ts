import * as THREE from "three";

/**
 * The viewport's backdrop: a soft vertical gradient rather than a single
 * flat fill color - a cheap, texture-free stand-in for a dark
 * photography/architectural-studio cyclorama. A slightly lighter charcoal
 * band sits at the horizon (roughly where the camera naturally looks when
 * a building is framed), receding to a deeper near-black tone above and
 * below, so a building reads as standing IN a calm, dark studio space -
 * enough depth/gradient to avoid a flat "empty void", without ever going
 * bright or white.
 *
 * Viewport-correction revision: an earlier ("Rescue") milestone tried a
 * light neutral-grey cyclorama here on the theory that "empty void"
 * feedback meant "too dark". In practice that made the viewport read as a
 * bright/white workspace, which is wrong for this product's professional
 * CAD/studio identity and visibly hurt shadow and material contrast
 * (task: "restore the professional DARK architectural modeling
 * viewport"). Dark charcoal tones restore that contrast while keeping
 * the same "soft gradient, not a flat void" structure this file already
 * had - only the actual color stops changed.
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
  gradient.addColorStop(0, "#15161a"); // zenith - near-black, not pitch black
  gradient.addColorStop(0.55, "#24262b"); // horizon - a lighter charcoal band, enough to read as a studio wall, not a void
  gradient.addColorStop(1, "#1a1b1f"); // recedes toward the ground's own dark tone
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Matches the gradient's lower band, so distant geometry fades into the same dark tone instead of a mismatched flat fog color. */
export const HORIZON_FOG_COLOR = 0x1a1b1f;
