// Explicit .ts extensions on these value imports (the rest are type-only)
// let Node run this module directly - the backend and the verify.ts
// scripts both do. Harmless for Vite.
import { analyzeConstructionGeometry } from "./geometry/analyzeConstructionGeometry.ts";
import { parseAIProjectSnapshot } from "./parseProjectSnapshot.ts";
import type { AIProjectContext, AIProjectSnapshot } from "./types";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Copies only the finite numeric fields of a dimensions object, in sorted key order - the same rule buildAIProjectSnapshot() applies. */
function copyDimensions(dimensions: Record<string, number>): Record<string, number> {
  const copy: Record<string, number> = {};
  for (const key of Object.keys(dimensions).sort()) {
    const value = dimensions[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      copy[key] = value;
    }
  }
  return copy;
}

/**
 * Builds what an AIProvider receives as `projectContext`: a plain copy of
 * the snapshot plus the geometry analysis derived from exactly that copy.
 *
 * This is the one place geometry enters the AI context, and
 * analyzeConstructionGeometry() is the one thing that computes it. In the
 * browser, AICommandPipeline.run() calls this for every instruction. On
 * the AI proxy backend, parseAIProjectContext() below calls it on the
 * snapshot the server has just sanitized - so the geometry OpenAI sees is
 * always computed server-side, from validated data, by the same code.
 *
 * - Geometry always matches the snapshot beside it: it is derived here,
 *   from the copy being returned. A `geometry` field already on the input
 *   (say, one a client sent) is never read.
 * - Plain JSON: the snapshot is copied field by field, like
 *   buildAIProjectSnapshot(), so anything else attached to the input - a
 *   mesh, a DOM node, a function - is left behind.
 * - Immutable: the result is deep-frozen, so a provider can read it but
 *   can't change it, and the caller's snapshot is never touched.
 * - Deterministic: the same snapshot always yields a byte-identical
 *   context. Every pairwise relationship is included, unfiltered.
 */
export function buildAIProjectContext(snapshot: AIProjectSnapshot): AIProjectContext {
  const copy: AIProjectSnapshot = {
    wallCount: snapshot.wallCount,
    pillarCount: snapshot.pillarCount,
    beamCount: snapshot.beamCount,
    slabCount: snapshot.slabCount,
    doorCount: snapshot.doorCount,
    windowCount: snapshot.windowCount,
    assemblyCount: snapshot.assemblyCount,
    selectedObjectId: snapshot.selectedObjectId,
    objects: snapshot.objects.map((object) => ({
      id: object.id,
      type: object.type,
      // An element also carries its catalog kind and label (the backend's
      // sanitizer requires the kind); the six original types have
      // neither, so their copy is unchanged.
      ...(object.kind !== undefined ? { kind: object.kind, label: object.label ?? "" } : {}),
      position: { x: object.position.x, y: object.position.y, z: object.position.z },
      rotation: object.rotation,
      dimensions: copyDimensions(object.dimensions),
      material: object.material,
      color: object.color,
      assemblyIds: [...object.assemblyIds]
    })),
    assemblies: snapshot.assemblies.map((assembly) => ({
      id: assembly.id,
      name: assembly.name,
      description: assembly.description,
      objectIds: [...assembly.objectIds]
    }))
  };

  return deepFreeze({ ...copy, geometry: analyzeConstructionGeometry(copy) });
}

export type ParsedAIProjectContext = { ok: true; context: AIProjectContext } | { ok: false; error: string };

/**
 * The AI proxy backend's (and the E2E mock backend's) entry point for an
 * untrusted `projectContext`: validate and sanitize it with
 * parseAIProjectSnapshot(), then derive geometry from the sanitized result.
 *
 * Whatever `geometry` the client sent is never read - not trusted, and
 * not even validated, because nothing of it is kept. The sanitizer
 * rebuilds only the snapshot's own fields, and buildAIProjectContext()
 * replaces geometry with the server's own derivation. A missing,
 * malformed, or fabricated client geometry section therefore changes
 * nothing, and can't make a request fail.
 */
export function parseAIProjectContext(value: unknown): ParsedAIProjectContext {
  const parsed = parseAIProjectSnapshot(value);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, context: buildAIProjectContext(parsed.snapshot) };
}
