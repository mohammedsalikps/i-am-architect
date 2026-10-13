/**
 * Verification for the construction record book (recordBook.ts), driven
 * through the REAL project: createProjectContext()'s stores, the shared
 * CommandExecutor, HistoryManager, and project save/load - so every check
 * reads the record exactly as the Measurements tab does, from
 * buildAIProjectSnapshot(), never from a hand-built object list.
 *
 * Run with: node --experimental-transform-types src/engine/records/recordBook.verify.ts
 */
import { createProjectContext, loadProject, serializeProject } from "../project/ProjectContext.ts";
import type { ProjectContext } from "../project/ProjectContext.ts";
import { buildAIProjectSnapshot } from "../ai/types.ts";
import { ASSET_DEFINITIONS } from "../assets/catalog.ts";
import { RECORD_CSV_COLUMNS, buildRecordBook, recordBookCsv } from "./recordBook.ts";
import type { RecordBook, RecordRow } from "./recordBook.ts";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL - ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function close(actual: number | null, expected: number, message: string): void {
  if (actual === null || Math.abs(actual - expected) > 0.0015) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function exec(context: ProjectContext, command: unknown): string {
  const result = context.commandExecutor.execute(command as Parameters<ProjectContext["commandExecutor"]["execute"]>[0]);
  assertTrue(result.success, `command failed: ${result.message}`);
  return result.objectId ?? "";
}

const bookOf = (context: ProjectContext): RecordBook => buildRecordBook(buildAIProjectSnapshot(context).objects);
const rowOf = (book: RecordBook, id: string): RecordRow => {
  const row = book.rows.find((candidate) => candidate.id === id);
  assertTrue(row, `no record for ${id}`);
  return row;
};
const brickWall = (position: { x: number; z: number }, extra: Record<string, unknown> = {}) => ({
  type: "wall.add",
  wall: { length: 5, height: 2.7, thickness: 0.23, material: "brick", position, ...extra }
});

async function main(): Promise<void> {
  console.log("\nConstruction record book verification\n");

  await check("a wall's record: its id, material, length/height/thickness, centre, direction, face area and volume", () => {
    const context = createProjectContext();
    const id = exec(context, brickWall({ x: 2, z: 3 }));
    const row = rowOf(bookOf(context), id);
    assertEqual(`${row.typeLabel} | ${row.materialLabel}`, "Wall | Brick", "type and material, by the library's label");
    assertEqual(`${row.length} x ${row.height} x ${row.thickness}`, "5 x 2.7 x 0.23", "dimensions in metres");
    assertEqual(JSON.stringify(row.position), JSON.stringify({ x: 2, y: 1.35, z: 3 }), "its centre, standing on the ground");
    assertEqual(row.direction, "east–west (along X)", "direction");
    close(row.area, 13.5, "face area 5 x 2.7");
    close(row.volume, 3.105, "volume 5 x 2.7 x 0.23");
    assertEqual(row.areaBasis, "face L × H", "the formula is stated");
  });

  await check("a hosted window is deducted from its wall's face; the window has an opening area but no volume", () => {
    const context = createProjectContext();
    const wall = exec(context, brickWall({ x: 0, z: 0 }));
    const window = exec(context, { type: "window.add", window: { hostId: wall, width: 1.2, height: 1 } });
    const book = bookOf(context);
    close(rowOf(book, wall).area, 13.5 - 1.2, "net face area");
    close(rowOf(book, wall).volume, (13.5 - 1.2) * 0.23, "net volume");
    assertTrue(rowOf(book, wall).areaBasis?.includes("1.2 m² of openings"), "the deduction is stated");
    close(rowOf(book, window).area, 1.2, "the window's opening area");
    assertEqual(rowOf(book, window).volume, null, "no volume for an opening");
  });

  await check("totals group by type and material, with their lengths, areas and volumes", () => {
    const context = createProjectContext();
    exec(context, brickWall({ x: 0, z: 0 }));
    exec(context, brickWall({ x: 0, z: 5 }, { length: 3 }));
    exec(context, { type: "wall.add", wall: { length: 4, height: 3, thickness: 0.2, material: "concrete-block", position: { x: 10, z: 0 } } });
    const totals = bookOf(context).totals;
    const brick = totals.find((total) => total.typeLabel === "Wall" && total.materialLabel === "Brick");
    const block = totals.find((total) => total.typeLabel === "Wall" && total.materialLabel === "Concrete block");
    assertTrue(brick && block, `both groups: ${JSON.stringify(totals)}`);
    assertEqual(brick.count, 2, "two brick walls");
    close(brick.length, 8, "5 m + 3 m");
    close(brick.area, 13.5 + 8.1, "both faces");
    close(brick.volume, 3.105 + 1.863, "both volumes");
    assertEqual(`${block.count} ${block.length}`, "1 4", "one 4 m block wall");
    close(block.volume, 2.4, "4 x 3 x 0.2");
  });

  await check("moving, resizing, changing material and deleting all show up in the record at once", () => {
    const context = createProjectContext();
    const id = exec(context, brickWall({ x: 0, z: 0 }));
    const other = exec(context, brickWall({ x: 0, z: 6 }));
    exec(context, { type: "update_object", objectId: id, changes: { position: { x: 4, z: -2 }, dimensions: { length: 6 }, material: "stone-masonry", rotation: Math.PI / 2 } });
    const row = rowOf(bookOf(context), id);
    assertEqual(`${row.position.x}, ${row.position.z}`, "4, -2", "moved");
    assertEqual(row.length, 6, "resized");
    close(row.volume, 6 * 2.7 * 0.23, "volume follows the new length");
    assertEqual(row.materialLabel, "Stone masonry", "material changed");
    assertEqual(row.direction, "north–south (along Z)", "turned");
    exec(context, { type: "wall.delete", id: other });
    assertTrue(!bookOf(context).rows.some((candidate) => candidate.id === other), "a deleted wall leaves the record");
  });

  await check("undo and redo: the record always matches the scene", () => {
    const context = createProjectContext();
    const id = exec(context, brickWall({ x: 0, z: 0 }));
    exec(context, { type: "update_object", objectId: id, changes: { dimensions: { height: 3 } } });
    assertEqual(rowOf(bookOf(context), id).height, 3, "edited");
    context.history.undo();
    assertEqual(rowOf(bookOf(context), id).height, 2.7, "undo restores the old height in the record");
    context.history.undo();
    assertEqual(bookOf(context).rows.length, 0, "undoing the wall empties the record");
    context.history.redo();
    context.history.redo();
    assertEqual(rowOf(bookOf(context), id).height, 3, "redo brings both back");
  });

  await check("save and reopen: the reopened project gives exactly the same record and CSV", () => {
    const context = createProjectContext();
    const wall = exec(context, brickWall({ x: 1, z: 1 }));
    exec(context, { type: "door.add", door: { hostId: wall } });
    exec(context, { type: "element.add", element: { kind: "room", label: "Kitchen", dimensions: { length: 4, width: 3 }, position: { x: 1, z: 3 } } });
    const saved = JSON.parse(JSON.stringify(serializeProject(context)));
    const reopened = createProjectContext();
    assertTrue(loadProject(reopened, saved).ok, "the project loads");
    assertEqual(recordBookCsv(bookOf(reopened)), recordBookCsv(bookOf(context)), "identical record after reopening");
  });

  await check("quantities this model doesn't define are null - never estimated", () => {
    const context = createProjectContext();
    const beam = exec(context, { type: "beam.add", beam: { position: { x: 0, y: 3, z: 0 } } });
    const door = exec(context, { type: "door.add", door: { position: { x: 5, z: 5 } } });
    const sofa = exec(context, { type: "asset.add", asset: { assetId: ASSET_DEFINITIONS[0].id, position: { x: -5, z: -5 } } });
    const stair = exec(context, { type: "element.add", element: { kind: "stair", position: { x: 8, z: -8 } } });
    const room = exec(context, { type: "element.add", element: { kind: "room", dimensions: { length: 4, width: 3 }, position: { x: -8, z: 8 } } });
    const roof = exec(context, { type: "element.add", element: { kind: "roof", dimensions: { length: 10, width: 8, height: 1.6 }, position: { x: 20, y: 4, z: 0 } } });
    const book = bookOf(context);
    assertEqual(rowOf(book, beam).area, null, "a beam has no defined area");
    assertTrue(rowOf(book, beam).volume !== null, "but a volume");
    assertEqual(rowOf(book, door).volume, null, "a door: opening area only");
    assertEqual(`${rowOf(book, sofa).area} ${rowOf(book, sofa).volume}`, "null null", "furniture: neither");
    assertEqual(`${rowOf(book, stair).area} ${rowOf(book, stair).volume}`, "null null", "a stair: neither");
    close(rowOf(book, room).area, 12, "a room: floor area");
    assertEqual(rowOf(book, room).volume, null, "a room is a space, not material");
    close(rowOf(book, roof).area, 2 * 10 * Math.hypot(4, 1.6), "a gable roof: both slopes");
    const csv = recordBookCsv(book);
    const sofaLine = csv.split("\r\n").find((line) => line.startsWith(`${sofa},`));
    assertTrue(sofaLine?.endsWith("n/a,n/a,n/a,n/a"), `unavailable quantities read n/a in the CSV: ${sofaLine}`);
  });

  await check("CSV: a header, every visible row, the totals and the assumptions; names with commas and quotes are escaped", () => {
    const context = createProjectContext();
    const wall = exec(context, brickWall({ x: 0, z: 0 }));
    exec(context, { type: "element.add", element: { kind: "room", label: 'Bed, Room "A"', dimensions: { length: 4, width: 3 }, position: { x: 0, z: 4 } } });
    const book = bookOf(context);
    const lines = recordBookCsv(book).split("\r\n");
    assertEqual(lines[0], RECORD_CSV_COLUMNS.join(","), "the header");
    assertEqual(lines.filter((line) => book.rows.some((row) => line.startsWith(`${row.id},`))).length, book.rows.length, "one line per record");
    assertTrue(lines.some((line) => line.includes('"Bed, Room ""A"""')), "the name is quoted, its quotes doubled");
    const wallLine = lines.find((line) => line.startsWith(`${wall},`))!;
    assertTrue(wallLine.includes(",Wall,Brick,5,2.7,0.23,") && wallLine.includes(",13.5,") && wallLine.includes(",3.105,"), `the wall's measurements: ${wallLine}`);
    assertTrue(lines.includes("Totals by type and material") && lines.some((line) => line.startsWith("Wall,Brick,1,5,13.5,3.105")), "the totals");
    assertTrue(lines.includes("Units and assumptions") && lines.some((line) => line.includes("metres (m)")), "the units and assumptions");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} record book check(s) failed`);
  }
}

await main();
