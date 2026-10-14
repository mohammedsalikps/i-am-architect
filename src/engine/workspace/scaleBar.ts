/**
 * The viewport's scale bar: the longest "round" length (1, 2 or 5 times a
 * power of ten, metres) that fits in `maxPixels` at the current zoom,
 * and how many pixels it spans. Measured at the camera's look-at point -
 * in a perspective view nearer things look bigger, so the bar is true
 * there and only approximate elsewhere. Pure and testable.
 */
export interface ScaleBar {
  metres: number;
  pixels: number;
  label: string;
}

const ROUND = [1, 2, 5];

export function scaleBarFor(metresPerPixel: number, maxPixels = 120): ScaleBar | null {
  if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0 || !(maxPixels > 0)) return null;
  const fits = metresPerPixel * maxPixels;
  const power = Math.floor(Math.log10(fits));
  let metres = 0;
  for (const exponent of [power - 1, power]) {
    for (const step of ROUND) {
      // toPrecision: 0.1 * 5 is 0.5, never 0.5000000000000001.
      const candidate = Number((step * 10 ** exponent).toPrecision(6));
      if (candidate <= fits && candidate > metres) metres = candidate;
    }
  }
  if (metres === 0) return null;
  return { metres, pixels: metres / metresPerPixel, label: `${Number(metres.toPrecision(6))} m` };
}

/** Metres per screen pixel at `distance` metres in front of a perspective camera with vertical field of view `fovDegrees`, drawn `viewportHeight` pixels tall. */
export function metresPerPixelAt(distance: number, fovDegrees: number, viewportHeight: number): number {
  if (!(distance > 0) || !(viewportHeight > 0)) return NaN;
  return (2 * distance * Math.tan((fovDegrees * Math.PI) / 360)) / viewportHeight;
}
