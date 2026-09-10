// Explicit .ts extensions on these value imports let Node run the verify
// suites that use this file directly. Harmless for Vite (and nothing in
// the app imports this file).
import { buildSimpleHousePlan } from "../ai/housePlan.ts";
import { ROOM_PRESETS, roomPresetOptions } from "../elements/roomPresets.ts";
import { WINDOW_SILL_HEIGHT } from "../openings/hostOpening.ts";
import type { CreateElementOptions } from "../elements/createElement.ts";
import type { ProjectContext } from "../project/ProjectContext.ts";

/** The ids a test needs to find its way around the house. */
export interface CompleteHouse {
  frontWall: string;
  sideWall: string;
  beam: string;
  /** In the front wall. */
  hostedDoor: string;
  /** In the side wall, at sill height. */
  hostedWindow: string;
  /** In the front wall. */
  frontWindow: string;
  /** Pairs of linear elements joined end to start by element.connect. */
  supply: [string, string];
  drain: [string, string];
  conduit: [string, string];
  cable: [string, string];
  /** Room element ids by preset name ("Bathroom", ...). */
  rooms: Record<string, string>;
  /** The bathroom fixtures - members of the "Bathroom" assembly with the bathroom. */
  fixtures: string[];
  assembly: string;
}

function run(project: ProjectContext, command: unknown): string | undefined {
  const result = project.commandExecutor.execute(command);
  if (!result.success) {
    throw new Error(`${JSON.stringify(command)} failed: ${result.message}`);
  }
  return result.objectId;
}

function create(project: ProjectContext, command: unknown): string {
  const id = run(project, command);
  if (!id) {
    throw new Error(`${JSON.stringify(command)} created nothing`);
  }
  return id;
}

/**
 * A complete house built only through CommandExecutor, the way the UI and
 * the AI build one: all seven object types, every element kind in the
 * catalog, openings hosted in walls, connected pipe, conduit and cable
 * runs, six rooms with floor finishes, a painted wall, and an assembly.
 * The same house as the element suite's "complete house" check, plus a
 * beam. Test-only: shared by src/engine/project/verify.ts and
 * backend/persistence.verify.ts.
 */
export function buildCompleteHouse(project: ProjectContext): CompleteHouse {
  const place = (kind: string, options: Omit<CreateElementOptions, "kind"> = {}): string =>
    create(project, { type: "element.add", element: { kind, ...options } });

  // Structure: foundation, the AI house plan (slab, walls, pillars, door, windows), a ridge beam, a roof and a stair.
  place("foundation");
  for (const command of buildSimpleHousePlan({ length: 10, width: 8 })) {
    create(project, command);
  }
  const walls = project.wallStore.getAll();
  const frontWall = walls.reduce((a, b) => (b.position.z > a.position.z ? b : a)).id;
  const sideWall = walls.reduce((a, b) => (b.position.x > a.position.x ? b : a)).id;
  const beam = create(project, { type: "beam.add", beam: { length: 10, position: { x: 0, y: 3.2, z: 0 } } });
  place("roof");
  place("stair", { position: { x: -3.6, z: -0.8 } });

  // Openings hosted in walls.
  const hostedWindow = create(project, { type: "window.add", window: { hostId: sideWall, offset: -1.5, sill: WINDOW_SILL_HEIGHT } });
  const hostedDoor = create(project, { type: "door.add", door: { hostId: frontWall, offset: 3 } });
  const frontWindow = create(project, { type: "window.add", window: { hostId: frontWall, offset: -2.5 } });

  // Rooms, each with a floor finish; a ceiling; a painted wall.
  const roomAt: Record<string, { x: number; z: number }> = {
    "Living Room": { x: -2.4, z: 1.6 },
    Kitchen: { x: 3.1, z: 2.4 },
    "Master Bedroom": { x: -2.8, z: -2 },
    Bedroom: { x: 0.5, z: -2.3 },
    Bathroom: { x: 3.7, z: -2.9 },
    "Dining Room": { x: 3, z: -0.1 }
  };
  const rooms: Record<string, string> = {};
  for (const preset of ROOM_PRESETS) {
    const at = roomAt[preset.name];
    rooms[preset.name] = create(project, { type: "element.add", element: roomPresetOptions(preset, at) });
    place("flooring", { position: { x: at.x, y: 0.21, z: at.z }, dimensions: { length: preset.length, width: preset.width } });
  }
  place("ceiling", { dimensions: { length: 9.6, width: 7.6 } });
  run(project, { type: "update_object", objectId: frontWall, changes: { material: "paint", color: "#e8dcc8" } });

  // Plumbing: tank, pump, connected supply and drain runs, bathroom fixtures.
  place("water-tank", { position: { x: 6.5, z: -3 } });
  place("pump", { position: { x: 6.5, z: -1.6 } });
  const supply: [string, string] = [
    place("water-pipe", { position: { x: 5.6, y: 0.3, z: -2.4 }, params: { system: "cold" } }),
    place("water-pipe", { position: { x: 8.7, y: 0.3, z: -2.4 }, params: { system: "cold" } })
  ];
  const drain: [string, string] = [place("drain-pipe", { position: { x: 4, z: -4.6 } }), place("drain-pipe", { position: { x: 7.1, z: -4.6 } })];
  run(project, { type: "element.connect", from: { id: supply[0], endpoint: "end" }, to: { id: supply[1], endpoint: "start" } });
  run(project, { type: "element.connect", from: { id: drain[0] }, to: { id: drain[1] } });
  const fixtures = [
    place("sink", { position: { x: 3, z: -2.3 } }),
    place("toilet", { position: { x: 4.2, z: -3.4 } }),
    place("shower", { position: { x: 4.3, z: -2.4 } }),
    place("tap", { position: { x: 3, z: -2.45 } })
  ];

  // Electrical.
  place("distribution-board", { position: { x: -4.7, z: 3.7 } });
  const conduit: [string, string] = [place("conduit", { position: { x: 0, z: 0 } }), place("conduit", { position: { x: 3.05, z: 0 } })];
  const cable: [string, string] = [place("cable", { position: { x: 0, z: 1 } }), place("cable", { position: { x: -3.05, z: 1 } })];
  run(project, { type: "element.connect", from: { id: conduit[0] }, to: { id: conduit[1] } });
  run(project, { type: "element.connect", from: { id: cable[1], endpoint: "end" }, to: { id: cable[0], endpoint: "start" } });
  place("switch", { position: { x: -0.5, z: 3.85 } });
  place("socket", { position: { x: -3, z: 3.85 } });
  place("light", { position: { x: -2.4, z: 1.6 } });

  // Interior.
  place("bed", { position: { x: -2.8, z: -2 } });
  place("wardrobe", { position: { x: -4.3, z: -3.2 } });
  place("table", { position: { x: 3, z: -0.1 } });
  place("chair", { position: { x: 3, z: 0.6 } });
  place("sofa", { position: { x: -2.4, z: 2.8 } });
  place("kitchen-cabinet", { position: { x: 4.3, z: 3.4 } });
  place("kitchen-counter", { position: { x: 2.6, z: 3.4 } });

  // Exterior: the plot, a path, boundary walls with a gate, planting.
  place("landscape");
  place("path", { position: { x: 0, z: 6 }, rotation: Math.PI / 2, dimensions: { length: 4 } });
  place("boundary-wall", { position: { x: -5.4, z: 8 }, dimensions: { length: 9.2 } });
  place("boundary-wall", { position: { x: 5.4, z: 8 }, dimensions: { length: 9.2 } });
  place("boundary-wall", { position: { x: 0, z: -8 }, dimensions: { length: 20 } });
  place("boundary-wall", { position: { x: -10, z: 0 }, rotation: Math.PI / 2, dimensions: { length: 16 } });
  place("boundary-wall", { position: { x: 10, z: 0 }, rotation: Math.PI / 2, dimensions: { length: 16 } });
  place("gate", { position: { x: 0, z: 8 } });
  place("tree", { position: { x: -7, z: 5 } });
  place("plant", { position: { x: 2, z: 5 } });

  // An assembly: the bathroom and its fixtures.
  const assembly = create(project, { type: "assembly.create", assembly: { name: "Bathroom" } });
  for (const objectId of [rooms.Bathroom, ...fixtures]) {
    run(project, { type: "assembly.addObject", assemblyId: assembly, objectId });
  }

  return { frontWall, sideWall, beam, hostedDoor, hostedWindow, frontWindow, supply, drain, conduit, cable, rooms, fixtures, assembly };
}
