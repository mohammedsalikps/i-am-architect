import type { AIProjectContext, AIContextObject } from "./types";

/**
 * A small, local "reliability layer" (task: NOT an AI bypass) for the
 * handful of common edits whose meaning is completely unambiguous once
 * something is selected: an explicit number, a fixed operation, a real
 * object already in front of the user. Recognizing these WITHOUT calling
 * the AI provider means the app's most-demoed edits ("make the selected
 * wall 5 metres long") keep working even during a real, observed Gemini
 * outage (see this milestone's report) - while every other instruction,
 * including anything even slightly open-ended ("make the living room
 * bigger" - by how much?), still goes to the provider exactly as before.
 *
 * This never bypasses validation: a matched intent still becomes a real
 * `update_object` command, still runs through AICommandPipeline's own
 * shape validation and CommandExecutor's domain validation, and still
 * gets one undo entry - see AICommandPipeline.runDeterministicIntent().
 * The ONLY thing skipped is the network round-trip to the AI provider.
 *
 * Deliberately narrow: each pattern requires the literal phrasing below,
 * an explicit number, and (for the wall-length case) a specific selected
 * object type. Anything that doesn't match exactly - a synonym, a vaguer
 * instruction, nothing selected - falls through to the provider (`{ kind:
 * "none" }`) or, when the phrasing matches but a precondition doesn't
 * (nothing selected, wrong type), is rejected locally with a clear reason
 * rather than spending a provider call on something already known to fail.
 */

export type DeterministicIntentResult =
  | { kind: "none" }
  | { kind: "matched"; command: Record<string, unknown>; explanation: string }
  | { kind: "rejected"; reason: string };

function selectedObject(context: AIProjectContext): AIContextObject | null {
  if (!context.selectedObjectId) {
    return null;
  }
  return context.objects.find((object) => object.id === context.selectedObjectId) ?? null;
}

const NUMBER = "(\\d+(?:\\.\\d+)?)";
const METERS = "(?:\\s*(?:meters|metres|m))?";

const WALL_LENGTH = new RegExp(`^(?:make|set)\\s+the\\s+selected\\s+wall\\s+${NUMBER}${METERS}\\s+long\\.?$`, "i");
const ROTATE_SELECTED = new RegExp(`^rotate\\s+the\\s+selected\\s+[a-z]+\\s+${NUMBER}\\s*(?:degrees|deg|°)\\.?$`, "i");
const MOVE_SELECTED = new RegExp(
  `^move\\s+the\\s+selected\\s+[a-z]+\\s+${NUMBER}${METERS}\\s+to\\s+the\\s+(right|left|forward|front|back|backward)\\.?$`,
  "i"
);

/**
 * World-axis directions, the same convention the AI system prompt already
 * declares (buildSystemPrompt: "front is +Z"): facing +Z (front), the
 * app's own right hand points toward +X.
 */
const DIRECTION_DELTA: Readonly<Record<string, { x: number; z: number }>> = {
  right: { x: 1, z: 0 },
  left: { x: -1, z: 0 },
  forward: { x: 0, z: 1 },
  front: { x: 0, z: 1 },
  back: { x: 0, z: -1 },
  backward: { x: 0, z: -1 }
};

export function tryDeterministicIntent(instruction: string, context: AIProjectContext): DeterministicIntentResult {
  const text = instruction.trim();

  const lengthMatch = WALL_LENGTH.exec(text);
  if (lengthMatch) {
    const length = Number(lengthMatch[1]);
    const selected = selectedObject(context);
    if (!selected) {
      return { kind: "rejected", reason: "Nothing is selected. Select a wall, then try again." };
    }
    if (selected.type !== "wall") {
      return { kind: "rejected", reason: `The selected object (${selected.id}) is a ${selected.type}, not a wall.` };
    }
    if (!(length > 0)) {
      return { kind: "rejected", reason: "A wall's length must be a positive number of meters." };
    }
    return {
      kind: "matched",
      command: { type: "update_object", objectId: selected.id, changes: { dimensions: { length } } },
      explanation: `Set ${selected.id}'s length to ${length} m.`
    };
  }

  const rotateMatch = ROTATE_SELECTED.exec(text);
  if (rotateMatch) {
    const degrees = Number(rotateMatch[1]);
    const selected = selectedObject(context);
    if (!selected) {
      return { kind: "rejected", reason: "Nothing is selected. Select an object, then try again." };
    }
    const rotation = selected.rotation + (degrees * Math.PI) / 180;
    return {
      kind: "matched",
      command: { type: "update_object", objectId: selected.id, changes: { rotation } },
      explanation: `Rotated ${selected.id} by ${degrees}°.`
    };
  }

  const moveMatch = MOVE_SELECTED.exec(text);
  if (moveMatch) {
    const distance = Number(moveMatch[1]);
    const direction = moveMatch[2].toLowerCase();
    const selected = selectedObject(context);
    if (!selected) {
      return { kind: "rejected", reason: "Nothing is selected. Select an object, then try again." };
    }
    const delta = DIRECTION_DELTA[direction];
    const position = { x: selected.position.x + delta.x * distance, z: selected.position.z + delta.z * distance };
    return {
      kind: "matched",
      command: { type: "update_object", objectId: selected.id, changes: { position } },
      explanation: `Moved ${selected.id} ${distance} m ${direction}.`
    };
  }

  return { kind: "none" };
}
