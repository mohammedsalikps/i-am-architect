import * as THREE from "three";
import { clearGroup, disposeLabel, fitLabels, labelSprite, type ViewportSize } from "./labelSprite";
import { dimensionSummary, roomDimensionText, wallDimensionText } from "../engine/workspace/dimensions";
import type { ScenePalette } from "./sceneTheme";
import type { WallStore } from "../engine/wall/WallStore";
import type { ElementStore } from "../engine/elements/ElementStore";
import type { VisibilityStore } from "./visibility/VisibilityStore";

export interface DimensionLayer {
  setPalette(palette: ScenePalette): void;
  setVisible(visible: boolean): void;
  /** "Dimensions shown: 1 room, 4 walls." - what the labels say, in words. */
  summary(): string;
  /**
   * Keeps the labels readable at this frame's zoom (see fitLabels): a
   * wall's label hides while the wall is shorter on screen than it, or
   * while it would overlap a room's label or an earlier wall's.
   */
  update(camera: THREE.PerspectiveCamera, viewport: ViewportSize): void;
}

/**
 * Dimension labels in the 3D view: each room's size on its floor ("Kitchen
 * 4.5 × 5 m", length east-west by width north-south) and each wall's
 * length above its top. Read from the stores every time they change - so
 * labels follow a move, a resize, undo/redo and a reopened project - and
 * never stored: they are not model objects, can't be selected, and can't
 * be duplicated. Hidden objects lose their labels. Theme-aware; shown or
 * hidden with the workspace's "dimensions" setting. Re-read at most once
 * per microtask (a single command writes several stores); a label whose
 * text is unchanged is only moved, so a drag doesn't redraw every label's
 * texture each frame.
 */
export function createDimensionLayer(
  scene: THREE.Scene,
  stores: { wallStore: WallStore; elementStore: ElementStore; visibilityStore: VisibilityStore },
  palette: ScenePalette,
  onSummary?: (summary: string) => void
): DimensionLayer {
  const root = new THREE.Group();
  root.name = "dimension-labels";
  root.userData.excludeFromAO = true;
  // Rooms before walls: the declutter pass keeps whichever comes first.
  const roomLabels = new THREE.Group();
  const wallLabels = new THREE.Group();
  root.add(roomLabels, wallLabels);
  scene.add(root);
  let colors = palette;
  let hidden: ReadonlySet<string> = new Set();
  let text = dimensionSummary(0, 0);
  let queued = false;
  /** The label drawn for each object now, by object id. */
  const labels = new Map<string, THREE.Sprite>();

  const drop = (id: string, sprite: THREE.Sprite): void => {
    sprite.parent?.remove(sprite);
    disposeLabel(sprite);
    labels.delete(id);
  };
  /** The object's label reading `content` - the same sprite while its text is unchanged. */
  const labelFor = (group: THREE.Group, id: string, content: string, options: Parameters<typeof labelSprite>[2]): THREE.Sprite => {
    const existing = labels.get(id);
    if (existing && existing.userData.label === content && existing.parent === group) return existing;
    if (existing) drop(id, existing);
    const sprite = labelSprite(content, colors, options);
    sprite.userData.objectId = id;
    group.add(sprite);
    labels.set(id, sprite);
    return sprite;
  };

  const sync = (): void => {
    const seen = new Set<string>();
    // A visible roof hides the labels of the rooms and walls under it - the
    // finished building reads as architecture, not a tag cloud. Hiding the
    // roof ("show me the kitchen", its eye button, Isolate) brings them back.
    const roofs = stores.elementStore.getAll().filter((element) => element.kind === "roof" && !hidden.has(element.id));
    const underRoof = (x: number, z: number): boolean =>
      roofs.some((roof) => {
        // Into the roof's own axes (the inverse of its turn about Y).
        const dx = x - roof.position.x;
        const dz = z - roof.position.z;
        const cos = Math.cos(roof.rotation);
        const sin = Math.sin(roof.rotation);
        const along = dx * cos - dz * sin;
        const across = dx * sin + dz * cos;
        return Math.abs(along) <= (roof.dimensions.length ?? 0) / 2 && Math.abs(across) <= (roof.dimensions.width ?? 0) / 2;
      });
    const covered = { rooms: 0, walls: 0 };
    for (const element of stores.elementStore.getAll()) {
      if (element.kind !== "room" || hidden.has(element.id)) continue;
      if (underRoof(element.position.x, element.position.z)) {
        covered.rooms += 1;
        continue;
      }
      // The element's own axes: turned a quarter, its length runs north-south - the label says it as it lies.
      const quarter = Math.abs(Math.round(element.rotation / (Math.PI / 2))) % 2 === 1;
      const length = quarter ? element.dimensions.width : element.dimensions.length;
      const width = quarter ? element.dimensions.length : element.dimensions.width;
      const label = labelFor(roomLabels, element.id, roomDimensionText(element.label, length, width), { height: 0.42, onTop: true, minPixels: 16 });
      label.position.set(element.position.x, 0.08, element.position.z);
      seen.add(element.id);
    }
    for (const wall of stores.wallStore.getAll()) {
      if (hidden.has(wall.id)) continue;
      if (underRoof(wall.position.x, wall.position.z)) {
        covered.walls += 1;
        continue;
      }
      // Drawn over geometry, like a room's: a roof or wall in front never cuts a label into fragments (the declutter pass keeps them apart).
      const label = labelFor(wallLabels, wall.id, wallDimensionText(wall.dimensions.length), { height: 0.3, onTop: true, minPixels: 13, span: wall.dimensions.length });
      label.position.set(wall.position.x, wall.position.y + wall.dimensions.height / 2 + 0.3, wall.position.z);
      seen.add(wall.id);
    }
    for (const [id, sprite] of [...labels]) {
      if (!seen.has(id)) drop(id, sprite);
    }
    text = dimensionSummary(roomLabels.children.length, wallLabels.children.length, covered);
    onSummary?.(root.visible ? text : "Dimensions hidden.");
  };

  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync();
    });
  };

  // (The element store carries the roofs too: a roof added, moved or restyled re-reads which labels it covers.)
  stores.wallStore.subscribe(() => schedule());
  stores.elementStore.subscribe(() => schedule());
  stores.visibilityStore.subscribe((next) => {
    hidden = next;
    schedule();
  });

  return {
    setPalette(next) {
      // New colours: every label is redrawn.
      colors = next;
      clearGroup(roomLabels);
      clearGroup(wallLabels);
      labels.clear();
      schedule();
    },
    setVisible(visible) {
      root.visible = visible;
      onSummary?.(visible ? text : "Dimensions hidden.");
    },
    summary: () => (root.visible ? text : "Dimensions hidden."),
    update(camera, viewport) {
      fitLabels(root, camera, viewport, true);
    }
  };
}
