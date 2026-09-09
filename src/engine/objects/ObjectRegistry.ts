import type { ObjectId } from "./types";

export type RegistryListener<T> = (objects: T[]) => void;

/**
 * Deep-clones a plain JSON-like value (objects, arrays, primitives only -
 * no functions, Map/Set, Date, class instances, or circular references).
 * Every construction object is plain data by design (see types.ts), so
 * this is enough - it avoids depending on the newer structuredClone
 * global that some runtimes may not have.
 */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const clone = {} as T;
  for (const key of Object.keys(value) as (keyof T)[]) {
    clone[key] = deepClone(value[key]);
  }
  return clone;
}

/**
 * Generic, object-type-agnostic store for anything with an `id`.
 * Mirrors WallStore's method shape (add/update/set/remove/get/getAll/
 * subscribe, plus has()) so a type-specific store can compose this
 * directly - WallStore already does (see WallStore.ts). See
 * objects/README.md for that pattern and how future object-type
 * stores (pillar, beam, slab, ...) follow it.
 *
 * The constraint is deliberately just `{ id: ObjectId }` rather than
 * the full ConstructionObjectBase shape: the implementation below only
 * ever keys on `.id`, so requiring more than that would have made this
 * unusable for non-construction-object data that still deserves the
 * same storage pattern - e.g. AssemblyStore (src/engine/assemblies/),
 * which groups object ids but isn't itself a construction object.
 *
 * Independent from Three.js, rendering, UI, history, AI, and quotation
 * logic - it only knows about plain, identifiable data.
 *
 * Immutability at the boundary: objects are deep-cloned on the way in
 * (add/update/set) and on the way out (get/getAll), so callers can never
 * mutate the registry's internal state through a returned reference,
 * and mutating an object after passing it to add()/set() has no effect
 * on what's stored. The internal Map itself is never exposed.
 */
export class ObjectRegistry<T extends { id: ObjectId }> {
  private readonly objects: Map<ObjectId, T>;
  private readonly listeners: Set<RegistryListener<T>>;

  constructor() {
    this.objects = new Map<ObjectId, T>();
    this.listeners = new Set<RegistryListener<T>>();
  }

  add(object: T): void {
    this.objects.set(object.id, deepClone(object));
    this.emit();
  }

  /**
   * Merges `changes` into the existing object. Purely structural - unlike
   * WallStore, this registry has no knowledge of type-specific derived-
   * field rules (e.g. a wall's base staying grounded when its height
   * changes), since it doesn't know which object type it's holding. A
   * nested field (position, dimensions, ...) must be passed as a
   * complete replacement value when provided, not a partial merge -
   * same convention WallStore already uses.
   */
  update(id: ObjectId, changes: Partial<Omit<T, "id" | "type">>): void {
    const existing = this.objects.get(id);
    if (!existing) {
      return;
    }
    const next = { ...existing, ...deepClone(changes) } as T;
    this.objects.set(id, next);
    this.emit();
  }

  /** Overwrites an object's data exactly - no partial merge. Useful for restoring an exact snapshot (e.g. undo/redo). */
  set(id: ObjectId, object: T): void {
    this.objects.set(id, deepClone(object));
    this.emit();
  }

  remove(id: ObjectId): void {
    if (this.objects.delete(id)) {
      this.emit();
    }
  }

  get(id: ObjectId): T | undefined {
    const object = this.objects.get(id);
    return object === undefined ? undefined : deepClone(object);
  }

  getAll(): T[] {
    return Array.from(this.objects.values(), (object) => deepClone(object));
  }

  has(id: ObjectId): boolean {
    return this.objects.has(id);
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: RegistryListener<T>): () => void {
    this.listeners.add(listener);
    listener(this.getAll());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const objects = this.getAll();
    for (const listener of this.listeners) {
      listener(objects);
    }
  }
}
