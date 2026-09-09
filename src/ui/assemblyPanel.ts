import { el } from "./dom";
import { SelectionStore } from "../engine/selection/SelectionStore";
import { resolveConstructionObject } from "../engine/objects/resolveConstructionObject";
import type { AssemblyData } from "../engine/assemblies/types";
import type { AssemblyStore } from "../engine/assemblies/AssemblyStore";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";
import type { WallStore } from "../engine/wall/WallStore";
import type { PillarStore } from "../engine/pillar/PillarStore";
import type { BeamStore } from "../engine/beam/BeamStore";
import type { SlabStore } from "../engine/slab/SlabStore";
import type { ObjectId, ObjectType } from "../engine/objects/types";

/** Truncates a long id for display; today's ids (e.g. "wall-1") are already short, so this is usually a no-op. */
function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

// Only wall/pillar/beam/slab are resolvable today (see
// resolveConstructionObject.ts) - this map only needs an entry for each
// type that resolver can actually return. A new object type's store
// joining the resolver adds one line here.
const TYPE_LABELS: Partial<Record<ObjectType, string>> = {
  wall: "Wall",
  pillar: "Pillar",
  beam: "Beam",
  slab: "Slab"
};

/**
 * Resolves a member object id to a readable label, using
 * resolveConstructionObject() to check every implemented object-type
 * store (today: wall, pillar, beam, slab) rather than assuming
 * everything is a wall. Never removes anything; an id that matches no
 * known store just reads as "Unknown object."
 */
function resolveMemberLabel(
  objectId: ObjectId,
  wallStore: WallStore,
  pillarStore: PillarStore,
  beamStore: BeamStore,
  slabStore: SlabStore
): { label: string; selectableId: ObjectId | null } {
  const resolved = resolveConstructionObject(objectId, { wallStore, pillarStore, beamStore, slabStore });
  if (resolved) {
    const typeLabel = TYPE_LABELS[resolved.type] ?? resolved.type;
    return { label: `${typeLabel} — ${shortId(objectId)}`, selectableId: objectId };
  }
  return { label: `Unknown object — ${shortId(objectId)}`, selectableId: null };
}

/**
 * Minimal assembly-management panel: list existing assemblies (name +
 * object count), create/select/delete an assembly, show the selected
 * assembly's member objects, and add/remove the currently-selected
 * construction object (a wall, pillar, beam, or slab) to/from the
 * currently-selected assembly. Lives in the left sidebar.
 *
 * Uses its own SelectionStore instance for "which assembly is selected
 * in this panel" - deliberately separate from the shared construction-
 * object SelectionStore. `selectionStore` (the one shared instance from
 * ProjectContext - the same one WallLayer/PillarLayer and rightSidebar.ts
 * use, holding at most one selected construction-object id at a time) is read
 * (`.get()`/`.subscribe()`) throughout this panel to drive the Add/
 * Remove button state, and is also *written to* in exactly one place:
 * clicking a listed member calls `.select()` on it, the same way
 * clicking a mesh in the 3D viewport already does. That's a normal use
 * of the shared store's own public API from a new UI entry point, not
 * a merge of the two selection concepts - assembly selection is never
 * affected by clicking a member, and construction-object selection is
 * never affected by anything else assembly-related.
 *
 * `wallStore`/`pillarStore`/`beamStore`/`slabStore` are read-only here
 * (`.get()`/`.subscribe()`), used only (via resolveConstructionObject)
 * to resolve a member id into a readable label - this panel never
 * writes to any of them.
 *
 * All writes (create/delete/addObject/removeObject) go through
 * commandExecutor - this panel never calls AssemblyStore's write
 * methods directly, only reads (getAll/get, via subscribe) to render
 * itself. Assembly operations have no undo/redo yet (see
 * assemblies/README.md) - every write here is immediate and final.
 */
export function createAssemblyPanel(
  assemblyStore: AssemblyStore,
  commandExecutor: CommandExecutor,
  selectionStore: SelectionStore,
  wallStore: WallStore,
  pillarStore: PillarStore,
  beamStore: BeamStore,
  slabStore: SlabStore
): HTMLElement {
  const assemblySelection = new SelectionStore();

  // Monotonic within this session, deliberately NOT derived from
  // assemblyStore.getAll().length - that count shrinks after a delete,
  // which would let a future name collide with one still on screen
  // (e.g. create "Assembly 1" and "Assembly 2", delete "Assembly 1",
  // create again - length-based naming would produce "Assembly 2"
  // again, an actual duplicate name coexisting with the original).
  // Only advances on a successful create.
  let nextAssemblyNumber = 1;

  const createButton = el("button", {
    className: "toolbar-button toolbar-button--primary",
    text: "New Assembly",
    attrs: { type: "button" }
  });
  createButton.addEventListener("click", () => {
    const name = `Assembly ${nextAssemblyNumber}`;
    const result = commandExecutor.execute({ type: "assembly.create", assembly: { name } });
    if (result.success && result.objectId) {
      nextAssemblyNumber += 1;
      assemblySelection.select(result.objectId);
    }
  });

  const deleteButton = el("button", {
    className: "toolbar-button toolbar-button--danger",
    text: "Delete Assembly",
    attrs: { type: "button" }
  });
  deleteButton.addEventListener("click", () => {
    const selectedId = assemblySelection.get();
    if (!selectedId) {
      return; // the button is disabled in this state, but guard anyway
    }
    const result = commandExecutor.execute({ type: "assembly.delete", id: selectedId });
    if (result.success) {
      assemblySelection.clear();
    }
  });

  const addObjectButton = el("button", {
    className: "toolbar-button",
    text: "Add Selected Object",
    attrs: { type: "button" }
  });
  addObjectButton.addEventListener("click", () => {
    const assembly = getSelectedAssembly();
    const selectedObjectId = selectionStore.get();
    if (!assembly || !selectedObjectId) {
      return; // the button is disabled in this state, but guard anyway
    }
    commandExecutor.execute({ type: "assembly.addObject", assemblyId: assembly.id, objectId: selectedObjectId });
  });

  const removeObjectButton = el("button", {
    className: "toolbar-button",
    text: "Remove Selected Object",
    attrs: { type: "button" }
  });
  removeObjectButton.addEventListener("click", () => {
    const assembly = getSelectedAssembly();
    const selectedObjectId = selectionStore.get();
    if (!assembly || !selectedObjectId) {
      return; // the button is disabled in this state, but guard anyway
    }
    commandExecutor.execute({ type: "assembly.removeObject", assemblyId: assembly.id, objectId: selectedObjectId });
  });

  function getSelectedAssembly(): AssemblyData | undefined {
    const id = assemblySelection.get();
    return id ? assemblyStore.get(id) : undefined;
  }

  function updateMembershipButtons(): void {
    const assembly = getSelectedAssembly();
    const selectedObjectId = selectionStore.get();
    const isMember = !!assembly && !!selectedObjectId && assembly.objectIds.includes(selectedObjectId);

    addObjectButton.disabled = !assembly || !selectedObjectId || isMember;
    removeObjectButton.disabled = !assembly || !selectedObjectId || !isMember;
  }

  assemblySelection.subscribe((selectedId) => {
    deleteButton.disabled = selectedId === null;
  });
  assemblyStore.subscribe(updateMembershipButtons);
  assemblySelection.subscribe(updateMembershipButtons);
  selectionStore.subscribe(updateMembershipButtons);

  const list = el("div", { className: "assembly-list" });

  function renderList(): void {
    const assemblies = assemblyStore.getAll();

    if (assemblies.length === 0) {
      list.replaceChildren(el("p", { className: "sidebar__placeholder", text: "No assemblies yet." }));
      return;
    }

    const selectedId = assemblySelection.get();

    list.replaceChildren(
      ...assemblies.map((assembly) => {
        const isSelected = assembly.id === selectedId;
        const item = el(
          "button",
          {
            className: `assembly-list__item${isSelected ? " assembly-list__item--selected" : ""}`,
            attrs: { type: "button" }
          },
          [
            el("span", { className: "assembly-list__name", text: assembly.name }),
            el("span", { className: "assembly-list__count", text: String(assembly.objectIds.length) })
          ]
        );
        item.addEventListener("click", () => assemblySelection.select(assembly.id));
        return item;
      })
    );
  }

  assemblyStore.subscribe(renderList);
  assemblySelection.subscribe(renderList);

  // --- Selected assembly detail: name, count, member list ---

  const detail = el("div", { className: "assembly-detail" });

  function renderSelectedAssemblyDetail(): void {
    const assembly = getSelectedAssembly();

    if (!assembly) {
      detail.hidden = true;
      detail.replaceChildren();
      return;
    }
    detail.hidden = false;

    const objectCount = assembly.objectIds.length;
    const header = el("div", { className: "assembly-detail__header" }, [
      el("span", { className: "assembly-detail__name", text: assembly.name }),
      el("span", {
        className: "assembly-detail__count",
        text: `${objectCount} object${objectCount === 1 ? "" : "s"}`
      })
    ]);

    const membersContent: HTMLElement =
      objectCount === 0
        ? el("p", { className: "sidebar__placeholder", text: "No objects in this assembly." })
        : el(
            "ul",
            { className: "assembly-members" },
            assembly.objectIds.map((objectId) => {
              const { label, selectableId } = resolveMemberLabel(
                objectId,
                wallStore,
                pillarStore,
                beamStore,
                slabStore
              );
              const item = el("li", { className: "assembly-members__item" });

              if (selectableId) {
                const link = el("button", {
                  className: "assembly-members__link",
                  text: label,
                  attrs: { type: "button" }
                });
                link.addEventListener("click", () => selectionStore.select(selectableId));
                item.append(link);
              } else {
                item.append(el("span", { className: "assembly-members__unknown", text: label }));
              }

              return item;
            })
          );

    detail.replaceChildren(header, membersContent);
  }

  assemblyStore.subscribe(renderSelectedAssemblyDetail);
  assemblySelection.subscribe(renderSelectedAssemblyDetail);
  wallStore.subscribe(renderSelectedAssemblyDetail);
  pillarStore.subscribe(renderSelectedAssemblyDetail);
  beamStore.subscribe(renderSelectedAssemblyDetail);
  slabStore.subscribe(renderSelectedAssemblyDetail);

  return el("div", { className: "sidebar__section" }, [
    el("h3", { className: "sidebar__section-title", text: "Assemblies" }),
    el("div", { className: "assembly-panel__actions" }, [createButton, deleteButton]),
    list,
    detail,
    el("div", { className: "assembly-panel__actions assembly-panel__actions--membership" }, [
      addObjectButton,
      removeObjectButton
    ])
  ]);
}
