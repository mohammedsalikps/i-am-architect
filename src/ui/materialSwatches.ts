import type { MaterialCategory, MaterialDefinition } from "../engine/materials/materialLibrary";

/**
 * A small CSS background for one material's swatch (the Materials tab -
 * see rightSidebar.ts's createMaterialsPanel()) that suggests the
 * material's own identity - a wood grain, a speckled stone, a metallic
 * sheen, a glass highlight - instead of a single flat color square.
 * Deliberately CSS gradients over the material's OWN color, not a claim
 * of a real texture (task section 10: "do not pretend flat colors are
 * photorealistic textures") - a quick, honest visual cue in a 2D list,
 * kept separate from the real 3D material response every object already
 * gets in the viewport (roughness/metalness/opacity - see
 * materialLibrary.ts and the scene layers that read them).
 */
export function materialSwatchStyle(material: MaterialDefinition): string {
  const { color, category } = material;
  switch (category as MaterialCategory) {
    case "wood":
      // Alternating grain lines along the length.
      return `repeating-linear-gradient(100deg, ${color}, ${color} 3px, rgba(0,0,0,0.16) 3px, rgba(0,0,0,0.16) 4px, ${color} 5px)`;
    case "stone":
    case "masonry":
    case "ceramic":
      // A speckled, mottled surface.
      return [
        `radial-gradient(circle at 20% 30%, rgba(255,255,255,0.22) 0 2px, transparent 3px)`,
        `radial-gradient(circle at 65% 60%, rgba(0,0,0,0.22) 0 2px, transparent 3px)`,
        `radial-gradient(circle at 45% 85%, rgba(255,255,255,0.15) 0 1.5px, transparent 2.5px)`,
        `radial-gradient(circle at 80% 20%, rgba(0,0,0,0.18) 0 1.5px, transparent 2.5px)`,
        color
      ].join(", ");
    case "metal":
      // A diagonal brushed-metal sheen.
      return `linear-gradient(115deg, ${color} 0%, rgba(255,255,255,0.35) 45%, ${color} 55%, rgba(0,0,0,0.2) 80%, ${color} 100%)`;
    case "glass":
      // A translucent surface with a soft highlight streak.
      return `linear-gradient(125deg, rgba(255,255,255,0.5) 0%, ${color} 35%, ${color} 65%, rgba(255,255,255,0.25) 100%)`;
    case "fabric":
      // A fine crosshatch weave.
      return [
        `repeating-linear-gradient(45deg, rgba(0,0,0,0.1) 0, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 4px)`,
        `repeating-linear-gradient(-45deg, rgba(255,255,255,0.08) 0, rgba(255,255,255,0.08) 1px, transparent 1px, transparent 4px)`,
        color
      ].join(", ");
    case "roofing":
      // Overlapping shingle courses.
      return `repeating-linear-gradient(0deg, ${color}, ${color} 5px, rgba(0,0,0,0.2) 5px, rgba(0,0,0,0.2) 6px)`;
    case "landscape":
      // A soft mottled ground cover.
      return `radial-gradient(circle at 30% 40%, rgba(255,255,255,0.15) 0 2px, transparent 3px), radial-gradient(circle at 70% 70%, rgba(0,0,0,0.15) 0 2px, transparent 3px), ${color}`;
    default:
      // generic/structural/finish/plumbing/electrical: a gentle top-lit
      // gloss, so even a plain color reads as a physical surface rather
      // than a flat UI chip.
      return `linear-gradient(160deg, rgba(255,255,255,0.18), rgba(0,0,0,0.12)), ${color}`;
  }
}
