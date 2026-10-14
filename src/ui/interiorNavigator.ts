import { el } from "./dom";
import { EYE_HEIGHT, facing } from "../engine/interior/interiorExplore";
import type { InteriorExploreSession, InteriorRoom, InteriorViewpoint } from "../engine/interior/interiorExplore";
import type { InteriorCameraHandlers } from "../scene/interior/InteriorCamera";

export interface InteriorExploreOptions {
  session: InteriorExploreSession;
  /** Puts the camera in a room (the first call enters Interior Explore in the scene) - SceneManager.enterInterior. */
  showRoom(room: InteriorRoom, view: InteriorViewpoint, handlers: InteriorCameraHandlers): void;
  /** Returns the scene to its exterior view - SceneManager.exitInterior. */
  exitScene(): void;
  /** Before entering: put away an armed placement tool, hide overlays that draw over walls. */
  onEnter?(): void;
  /** After leaving: bring those overlays back. */
  onExit?(): void;
  /** Called on every change to the project's elements, so the room list follows the model. */
  subscribeModel(listener: () => void): () => void;
}

export interface InteriorExplore {
  /**
   * One viewport overlay: the "Interior Explore" button just under the view
   * controls, and the room navigator below it. Its own overlay, not a button
   * in the preset row - that row keeps its width beside the companion.
   */
  element: HTMLElement;
  isActive(): boolean;
  /** Leaves Interior Explore, restoring the view - a no-op when it is off. */
  exit(): void;
}

const fmt = (value: number): string => String(Number(value.toFixed(2)));

/**
 * Interior Explore's controls: the button under the view presets, and a
 * compact navigator listing the project's rooms - whatever they are
 * called, however many there are. Picking a room stands you in it at eye
 * height; "Fit room" goes back to that room's starting view; "Exit
 * interior" (or Escape) returns to the exterior view exactly as it was.
 * A viewing mode only: it never edits the model (see
 * engine/interior/interiorExplore.ts).
 */
export function createInteriorExplore(options: InteriorExploreOptions): InteriorExplore {
  const { session } = options;
  const button = el("button", {
    className: "view-controls__button interior-explore__toggle",
    text: "Interior Explore",
    attrs: { type: "button", "aria-pressed": "false", "aria-controls": "interior-explore", title: "Walk through the house's rooms at eye height" }
  });
  const title = el("h3", { className: "interior-explore__title", text: "Interior Explore" });
  const list = el("div", { className: "interior-explore__rooms", attrs: { role: "list", "aria-label": "Rooms" } });
  const readout = el("p", { className: "interior-explore__readout", attrs: { role: "status", "aria-live": "polite" } });
  const message = el("p", { className: "interior-explore__message" });
  const fitButton = el("button", { className: "toolbar-button", text: "Fit room", attrs: { type: "button", title: "Back to this room's starting view" } });
  const exitButton = el("button", { className: "toolbar-button toolbar-button--primary", text: "Exit interior", attrs: { type: "button", title: "Back to the exterior view (Esc)" } });
  const hint = el("p", {
    className: "interior-explore__hint",
    text: "Drag to look around · W/S or ↑/↓ to walk · A/D to step sideways · ←/→ to turn · wheel to step · Esc to exit"
  });
  const panel = el("section", { className: "interior-explore", attrs: { id: "interior-explore", "aria-label": "Interior Explore" } }, [
    title,
    message,
    list,
    readout,
    el("div", { className: "interior-explore__actions" }, [fitButton, exitButton]),
    hint
  ]);
  panel.hidden = true;
  const element = el("div", { className: "interior-explore-dock" }, [el("div", { className: "view-controls interior-explore__bar" }, [button]), panel]);

  let open = false;
  let current: InteriorRoom | null = null;

  const handlers: InteriorCameraHandlers = {
    onChange: (view) => {
      if (!current) return;
      readout.textContent = `${current.name} · eye ${fmt(EYE_HEIGHT)} m above the floor · X ${fmt(view.position.x)}, Y ${fmt(view.position.z)} · facing ${facing(view.yaw)}`;
      readout.dataset.x = String(view.position.x);
      readout.dataset.y = String(view.position.y);
      readout.dataset.z = String(view.position.z);
    },
    onExit: () => close()
  };

  const renderRooms = (): void => {
    const rooms = session.rooms();
    list.replaceChildren(
      ...rooms.map((room) => {
        const item = el("button", {
          className: `interior-explore__room${room.id === current?.id ? " is-active" : ""}`,
          attrs: { type: "button", role: "listitem", "aria-pressed": String(room.id === current?.id), "data-room-id": room.id }
        }, [el("span", { className: "interior-explore__room-name", text: room.name }), el("span", { className: "interior-explore__room-size", text: `${fmt(room.planX)} × ${fmt(room.planZ)} m` })]);
        item.addEventListener("click", () => goTo(room.id));
        return item;
      })
    );
    fitButton.disabled = !current;
  };

  const goTo = (roomId: string): void => {
    const target = session.goTo(roomId);
    if (!target) {
      message.textContent = "That room isn't in the project any more.";
      return;
    }
    message.textContent = "";
    current = target.room;
    options.showRoom(target.room, target.viewpoint, handlers);
    renderRooms();
  };

  function close(): void {
    if (!open) return;
    open = false;
    session.exit();
    options.exitScene();
    options.onExit?.();
    current = null;
    panel.hidden = true;
    button.classList.remove("is-active");
    button.setAttribute("aria-pressed", "false");
    readout.textContent = "";
  }

  const start = (): void => {
    panel.hidden = false;
    button.classList.add("is-active");
    button.setAttribute("aria-pressed", "true");
    open = true;
    const entered = session.enter();
    if (!entered.ok) {
      // Nothing to walk into: say so, and change nothing in the view.
      message.textContent = entered.message;
      list.replaceChildren();
      fitButton.disabled = true;
      return;
    }
    options.onEnter?.();
    message.textContent = "";
    goTo(entered.rooms[0].id);
  };

  button.addEventListener("click", () => (open ? close() : start()));
  exitButton.addEventListener("click", () => close());
  fitButton.addEventListener("click", () => {
    if (current) goTo(current.id);
  });

  // The rooms follow the model: renamed, resized, added or removed while exploring.
  options.subscribeModel(() => {
    if (!open || !session.isActive()) return;
    const latest = session.currentRoom();
    if (current && !latest) {
      message.textContent = `${current.name} was removed. Pick another room, or exit.`;
      current = null;
    } else if (latest) {
      current = latest;
    }
    renderRooms();
  });

  return {
    element,
    isActive: () => open,
    exit: close
  };
}
