import * as THREE from "three";
import type { ScenePalette } from "./sceneTheme";

/**
 * A text label drawn in the 3D scene (an axis name, a dimension) - a
 * camera-facing sprite on a canvas texture, in the theme's label colours,
 * `height` metres tall at its position. Never part of the model: not
 * saved, not selectable, kept out of the ambient-occlusion pass, and never
 * fogged (it must stay readable however far away the camera is).
 * `onTop` draws it over geometry (a room's size label on its floor).
 * `minPixels`: fitLabels() never lets it draw shorter than this on screen.
 * `span`: the length it labels, metres - fitLabels() hides it while that
 * length is shorter on screen than the label itself (a wall seen from far
 * away), so a zoomed-out view isn't buried in overlapping labels.
 */
export function labelSprite(
  text: string,
  palette: ScenePalette,
  options: { height?: number; onTop?: boolean; accent?: string; minPixels?: number; span?: number } = {}
): THREE.Sprite {
  const height = options.height ?? 0.36;
  const scale = 2; // canvas pixels per CSS pixel, for crisp text
  const fontPx = 30 * scale;
  const padX = 14 * scale;
  const padY = 8 * scale;
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d");
  const font = `600 ${fontPx}px "Segoe UI", -apple-system, Roboto, Arial, sans-serif`;
  let textWidth = text.length * fontPx * 0.6;
  if (measure) {
    measure.font = font;
    textWidth = measure.measureText(text).width;
  }
  canvas.width = Math.ceil(textWidth + padX * 2);
  canvas.height = Math.ceil(fontPx + padY * 2);
  const context = canvas.getContext("2d");
  if (context) {
    const radius = 10 * scale;
    context.fillStyle = palette.labelBackground;
    context.strokeStyle = options.accent ?? palette.labelBorder;
    context.lineWidth = 3 * scale;
    context.beginPath();
    context.roundRect(context.lineWidth / 2, context.lineWidth / 2, canvas.width - context.lineWidth, canvas.height - context.lineWidth, radius);
    context.fill();
    context.stroke();
    context.font = font;
    context.fillStyle = palette.labelText;
    context.textBaseline = "middle";
    context.textAlign = "center";
    context.fillText(text, canvas.width / 2, canvas.height / 2 + scale);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: !options.onTop, depthWrite: false, fog: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  sprite.renderOrder = options.onTop ? 10 : 2;
  sprite.userData.excludeFromAO = true;
  sprite.userData.label = text;
  sprite.userData.aspect = canvas.width / canvas.height;
  sprite.userData.baseHeight = height;
  sprite.userData.minPixels = options.minPixels ?? 14;
  if (options.span !== undefined) sprite.userData.span = options.span;
  sprite.raycast = () => undefined;
  return sprite;
}

/** The viewport's drawn size, CSS pixels. */
export interface ViewportSize {
  width: number;
  height: number;
}

const worldPosition = new THREE.Vector3();

/**
 * Keeps every label under `root` readable for this frame: at least its
 * `minPixels` tall on screen (larger in the world as the camera backs
 * away), and hidden while the length it labels (`span`) is shorter on
 * screen than the label. With `declutter`, a label that would overlap one
 * placed before it (children order: first wins) is hidden too. Called
 * every frame (SceneManager), so labels come back as the view clears.
 */
export function fitLabels(root: THREE.Object3D, camera: THREE.PerspectiveCamera, viewport: ViewportSize, declutter = false): void {
  if (!root.visible || viewport.height <= 0) return;
  const tangent = 2 * Math.tan((camera.fov * Math.PI) / 360);
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Sprite) || typeof object.userData.baseHeight !== "number") return;
    object.getWorldPosition(worldPosition);
    const distance = camera.position.distanceTo(worldPosition);
    const perPixel = (distance * tangent) / viewport.height;
    const height = Math.max(object.userData.baseHeight, object.userData.minPixels * perPixel);
    const width = height * object.userData.aspect;
    object.scale.set(width, height, 1);
    object.visible = typeof object.userData.span === "number" ? object.userData.span >= width * 1.1 : true;
    if (!declutter || !object.visible) return;
    const screen = worldPosition.project(camera);
    if (screen.z > 1) return; // behind the camera
    const x = ((screen.x + 1) / 2) * viewport.width;
    const y = ((1 - screen.y) / 2) * viewport.height;
    const halfWidth = width / perPixel / 2 + 2;
    const halfHeight = height / perPixel / 2 + 2;
    const rect = { left: x - halfWidth, right: x + halfWidth, top: y - halfHeight, bottom: y + halfHeight };
    if (placed.some((other) => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top)) {
      object.visible = false;
      return;
    }
    placed.push(rect);
  });
}

/** Frees a label's texture and material (the geometry is shared by all sprites). */
export function disposeLabel(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

/** Removes and frees every child of `group` - labels, lines and meshes alike. */
export function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((object) => {
      if (object instanceof THREE.Sprite) {
        disposeLabel(object);
        return;
      }
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
  }
}
