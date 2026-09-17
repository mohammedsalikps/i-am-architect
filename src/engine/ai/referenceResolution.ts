import type { CommandResult } from "../commands/types";

/**
 * Lets one AI response reference an object ANOTHER command earlier in the
 * SAME response is about to create - which has no stable id yet - without
 * the provider inventing one. See ai/README.md "Object references".
 *
 * AICommandPipeline already executes a response's commands sequentially,
 * one at a time, through the exact same CommandExecutor every UI action
 * uses (see commands/executeCommandBatch.ts) - each command's real result
 * (including its assigned objectId) is available before the next one
 * runs. This module is the missing piece: rewriting a reference TOKEN in
 * one not-yet-executed command's known id-bearing fields into the real id
 * an earlier command in this batch actually produced, immediately before
 * that command reaches CommandExecutor. It never invents an id itself -
 * every resolved id is copied from a real CommandResult.objectId (or the
 * project's own selectedObjectId), and an unresolvable token fails the
 * command cleanly (see resolveCommandReferences) rather than silently
 * guessing.
 *
 * A field that already holds a real id (anything not starting with "$")
 * is left completely untouched - the common case, since most references
 * are to objects that already exist in the current construction state,
 * which the provider is instructed to copy directly (see promptSchema.ts).
 * Tokens exist only for the one case a real id can't cover: an object this
 * SAME response hasn't created yet when the prompt was built.
 */

/** "$previous": the immediately preceding command in this response. "$step:N": command N (0-based) in this response. "$selection": the object selected when the request was submitted. */
const REFERENCE_TOKEN_PATTERN = /^\$(previous|step:(\d+)|selection)$/;

export function isReferenceToken(value: unknown): value is string {
  return typeof value === "string" && REFERENCE_TOKEN_PATTERN.test(value);
}

type TokenResolution = { ok: true; id: string } | { ok: false; error: string };

function resolveToken(
  token: string,
  index: number,
  priorResults: readonly CommandResult[],
  selectedObjectId: string | null
): TokenResolution {
  const match = REFERENCE_TOKEN_PATTERN.exec(token);
  if (!match) {
    return { ok: false, error: `"${token}" is not a recognized reference.` };
  }

  if (match[1] === "selection") {
    return selectedObjectId
      ? { ok: true, id: selectedObjectId }
      : { ok: false, error: `"${token}" refers to the current selection, but nothing is selected.` };
  }

  const stepIndex = match[1] === "previous" ? index - 1 : Number(match[2]);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= index) {
    return {
      ok: false,
      error: `"${token}" must refer to an earlier command in this same response (this is command ${index + 1} of the response).`
    };
  }

  const referenced = priorResults[stepIndex];
  if (!referenced || !referenced.success || !referenced.objectId) {
    return { ok: false, error: `"${token}" refers to command ${stepIndex + 1} of this response, which did not create an object to reference.` };
  }
  return { ok: true, id: referenced.objectId };
}

/** One id-bearing field a reference token may appear in, addressed by its path inside the raw command object. */
const REFERENCE_FIELDS: readonly (readonly string[])[] = [
  ["objectId"],
  ["door", "hostId"],
  ["window", "hostId"],
  ["element", "roomId"],
  ["asset", "roomId"],
  ["from", "id"],
  ["to", "id"]
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAt(container: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = container;
  for (const key of path) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/** A copy of `container` with `value` set at `path`, cloning only the objects the path actually passes through. */
function setAt(container: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    return { ...container, [head]: value };
  }
  const child = container[head];
  return { ...container, [head]: setAt(isPlainObject(child) ? child : {}, rest, value) };
}

export type ResolvedCommand = { ok: true; command: unknown };
export type UnresolvedCommand = { ok: false; message: string };

/**
 * Rewrites every reference token found in one raw command's known
 * id-bearing fields (see REFERENCE_FIELDS) into a real object id, using
 * only commands already executed earlier in this same response
 * (`priorResults`, in order) and the selection at the start of the
 * request. A field that isn't a token (the common case: a real id, or the
 * field is simply absent) is left exactly as it was - this function never
 * touches, validates, or even looks at any other part of the command.
 *
 * Returns the ORIGINAL object, not a copy, when it contains no reference
 * token at all - the overwhelming majority of commands - so this adds no
 * allocation to the common path.
 */
export function resolveCommandReferences(
  raw: unknown,
  index: number,
  priorResults: readonly CommandResult[],
  selectedObjectId: string | null
): ResolvedCommand | UnresolvedCommand {
  if (!isPlainObject(raw)) {
    return { ok: true, command: raw };
  }

  let command: Record<string, unknown> = raw;
  for (const path of REFERENCE_FIELDS) {
    const value = getAt(command, path);
    if (!isReferenceToken(value)) {
      continue;
    }
    const resolved = resolveToken(value, index, priorResults, selectedObjectId);
    if (!resolved.ok) {
      return { ok: false, message: `Command ${index + 1}: ${resolved.error}` };
    }
    command = setAt(command, path, resolved.id);
  }
  return { ok: true, command };
}
