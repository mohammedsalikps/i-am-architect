/**
 * Node-runnable verification for the uPVC plumbing slice: the sheet's
 * source data (upvcSheet.ts), joint-to-fitting resolution (fittings.ts),
 * fitting geometry (fittingGeometry.ts), pipe runs (architect/pipeRun.ts),
 * the ribbon's size presets, and fittings through the real commands, undo
 * and redo, save and reopen, and the record book. Same "no test framework,
 * plain assertion helpers" convention as every other verify.ts here.
 */
import { createProjectContext, loadProject, serializeProject } from "../project/ProjectContext.ts";
import { buildAIProjectSnapshot } from "../ai/types.ts";
import { buildRecordBook, filterRecordBook, recordBookCsv, RECORD_CSV_COLUMNS } from "../records/recordBook.ts";
import { FITTINGS, PIPE_SIZES, SHEET_NOTES, SYSTEM_SCALE, fullSizeMetres, pipeOutsideDiameter, pipeSizeFor, validateUpvcSheet } from "./upvcSheet.ts";
import { resolveJoints } from "./fittings.ts";
import { centreToEnd, fittingGeometry, memberAtPoint } from "./fittingGeometry.ts";
import { isPipeRun, planPipeRun, readPipeRun } from "../architect/pipeRun.ts";
import { buildRibbonTabs } from "../../ui/ribbonTabs.ts";
import type { PipeLike, ResolvedJoint } from "./fittings";
import type { ProjectContext } from "../project/ProjectContext.ts";

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertClose(actual: number, expected: number, message: string, epsilon = 1e-4): void {
  if (Math.abs(actual - expected) > epsilon) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const OD = { cw25: 0.0334, cw20: 0.02667, cw15: 0.02134, san110: 0.11, san75: 0.075 };

/** A level pipe from (x1, z1) to (x2, z2) - the same position/rotation/length convention as connections.runBetween. */
function pipe(id: string, kind: string, x1: number, z1: number, x2: number, z2: number, diameter: number, connections: PipeLike["connections"] = []): PipeLike {
  return {
    id,
    type: "element",
    kind,
    position: { x: (x1 + x2) / 2, y: 0.3, z: (z1 + z2) / 2 },
    rotation: Math.atan2(-(z2 - z1), x2 - x1),
    dimensions: { length: Math.hypot(x2 - x1, z2 - z1), diameter },
    connections
  };
}
const c = (endpoint: "start" | "end", objectId: string, objectEndpoint: "start" | "end") => ({ endpoint, objectId, objectEndpoint });
const one = (objects: PipeLike[]): ResolvedJoint => {
  const joints = resolveJoints(objects);
  assertEqual(joints.length, 1, `one joint (got ${joints.map((joint) => joint.id).join(", ")})`);
  return joints[0];
};
const label = (joint: ResolvedJoint) => joint.fitting?.label ?? `UNRESOLVED: ${joint.problem}`;

console.log("uPVC plumbing verification\n");

// --- source data ---

check("the transcribed sheet values pass every consistency check (standards, sockets vs pipes, values printed on two pages)", () => {
  const checks = validateUpvcSheet();
  const failures = checks.filter((entry) => !entry.ok);
  assertEqual(failures.map((entry) => entry.message).join(" | "), "", "no failures");
  assertTrue(checks.length >= 25, `all sizes and fittings checked (${checks.length})`);
});

check("kit values stay as printed and are scaled only on demand: 6.680 mm kit at 1:5 is a 33.4 mm pipe; 11.00 mm kit at 1:10 is 110 mm", () => {
  const cw25 = PIPE_SIZES.find((size) => size.id === "cw-25")!;
  assertEqual(cw25.kit.od, 6.68, "kit OD as printed");
  assertEqual(SYSTEM_SCALE["clean-water"], 5, "1:5");
  assertClose(pipeOutsideDiameter(cw25), 0.0334, "full-size OD");
  assertClose(fullSizeMetres(11, "sanitation"), 0.11, "sanitation 1:10");
  assertTrue(FITTINGS.every((fitting) => fitting.source.page >= 1 && fitting.source.page <= 6 && fitting.source.item.length > 0), "every fitting names its page and printed item");
  assertTrue(!FITTINGS.some((fitting) => /beam/i.test(fitting.source.item)), "the provisional beam boxes are not included");
  assertTrue(SHEET_NOTES.some((note) => note.includes("5.90")), "the unclear reducing-tee values are noted, not silently used");
});

check("a pipe's sheet size is read from its outside diameter within 0.5 mm - an older 25 mm or 100 mm custom diameter is no sheet size", () => {
  assertEqual(pipeSizeFor("water-pipe", 0.0334)?.id, "cw-25", "25 mm main");
  assertEqual(pipeSizeFor("water-pipe", 0.02667)?.id, "cw-20", "20 mm branch");
  assertEqual(pipeSizeFor("drain-pipe", 0.075)?.id, "san-75", "75 mm");
  assertEqual(pipeSizeFor("water-pipe", 0.025), null, "the old 0.025 default is custom");
  assertEqual(pipeSizeFor("drain-pipe", 0.1), null, "the old 0.1 default is custom");
  assertEqual(pipeSizeFor("conduit", 0.0334), null, "not a plumbing kind");
});

// --- joint classification ---

check("two ends: straight on is a coupler (same size) or the sheet's reducer; a reducer the sheet doesn't have is reported", () => {
  assertEqual(label(one([pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start")]), pipe("b", "water-pipe", 3, 0, 6, 0, OD.cw25, [c("start", "a", "end")])])), "25 mm coupler", "coupler");
  assertEqual(label(one([pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start")]), pipe("b", "water-pipe", 3, 0, 6, 0, OD.cw20, [c("start", "a", "end")])])), "25 × 20 mm reducer", "reducer");
  assertEqual(label(one([pipe("a", "drain-pipe", 0, 0, 3, 0, OD.san75, [c("end", "b", "start")]), pipe("b", "drain-pipe", 3, 0, 6, 0, OD.san110, [c("start", "a", "end")])])), "110 × 75 mm reducer", "drain reducer, either way round");
  const noReducer = one([pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start")]), pipe("b", "water-pipe", 3, 0, 6, 0, OD.cw15, [c("start", "a", "end")])]);
  assertTrue(noReducer.fitting === null && /no 25 × 15 mm reducer/.test(noReducer.problem ?? ""), `25 x 15 is reported: ${noReducer.problem}`);
  const noCoupler = one([pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw20, [c("end", "b", "start")]), pipe("b", "water-pipe", 3, 0, 6, 0, OD.cw20, [c("start", "a", "end")])]);
  assertTrue(noCoupler.fitting === null && /no 20 mm coupler/.test(noCoupler.problem ?? ""), "the sheet's coupler is 25 mm only");
});

check("two ends turning: 90° and 45° clean-water elbows; a drain's 90° corner takes the 87.5° bend (with a note); other angles are reported", () => {
  const turn = (kind: string, d: number, x2: number, z2: number) =>
    one([pipe("a", kind, 0, 0, 3, 0, d, [c("end", "b", "start")]), pipe("b", kind, 3, 0, 3 + x2, z2, d, [c("start", "a", "end")])]);
  assertEqual(label(turn("water-pipe", OD.cw25, 0, 2)), "25 mm 90° elbow", "90");
  assertEqual(label(turn("water-pipe", OD.cw25, 1, 1)), "25 mm 45° elbow", "45");
  const sixty = turn("water-pipe", OD.cw25, 1, Math.sqrt(3));
  assertTrue(sixty.fitting === null && /turn 60° here/.test(sixty.problem ?? ""), `60 reported: ${sixty.problem}`);
  const drain = turn("drain-pipe", OD.san110, 0, 2);
  assertEqual(label(drain), "110 mm 87.5° elbow", "drain corner");
  assertTrue(/2\.5°/.test(drain.note ?? ""), "and the 2.5° fall note");
  assertEqual(label(turn("drain-pipe", OD.san110, 1, 1)), "110 mm 45° elbow", "drain 45");
  const small = turn("water-pipe", OD.cw20, 0, 2);
  assertTrue(small.fitting === null && /no 20 mm 90° elbow/.test(small.problem ?? ""), "the sheet's elbows are 25 mm only");
  const mixed = one([pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start")]), pipe("b", "water-pipe", 3, 0, 3, 2, OD.cw20, [c("start", "a", "end")])]);
  assertTrue(mixed.fitting === null && /no reducing elbow/.test(mixed.problem ?? ""), "a size change at a turn is reported");
});

check("three ends: a tee only when two run straight through and the branch is at 90° (a Y at 45°, sanitation only); everything else is reported, never assumed", () => {
  const three = (kind: string, run: number, branch: number, bx: number, bz: number) =>
    one([
      pipe("a", kind, 0, 0, 3, 0, run, [c("end", "b", "start"), c("end", "c", "start")]),
      pipe("b", kind, 3, 0, 6, 0, run, [c("start", "a", "end")]),
      pipe("c", kind, 3, 0, 3 + bx, bz, branch, [c("start", "a", "end")])
    ]);
  assertEqual(label(three("water-pipe", OD.cw25, OD.cw25, 0, 2)), "25 mm equal tee", "equal tee");
  assertEqual(label(three("water-pipe", OD.cw25, OD.cw20, 0, -2)), "25 × 20 mm reducing tee", "reducing tee");
  assertEqual(label(three("drain-pipe", OD.san110, OD.san110, 0, 2)), "110 mm plain tee", "drain tee");
  assertEqual(label(three("drain-pipe", OD.san110, OD.san75, 0, 2)), "110 × 75 mm reducing tee", "drain reducing tee");
  assertEqual(label(three("drain-pipe", OD.san110, OD.san110, 1, 1)), "110 mm single Y", "single Y at 45°");
  const waterY = three("water-pipe", OD.cw25, OD.cw25, 1, 1);
  assertTrue(waterY.fitting === null && /90° tees only/.test(waterY.problem ?? ""), `no clean-water Y: ${waterY.problem}`);
  const bigBranch = three("water-pipe", OD.cw20, OD.cw25, 0, 2);
  assertTrue(bigBranch.fitting === null && /larger than the run/.test(bigBranch.problem ?? ""), "branch larger than the run");
  const noRun = one([
    pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start"), c("end", "c", "start")]),
    pipe("b", "water-pipe", 3, 0, 3, 2, OD.cw25, [c("start", "a", "end")]),
    pipe("c", "water-pipe", 3, 0, 4, -1, OD.cw25, [c("start", "a", "end")])
  ]);
  assertTrue(noRun.fitting === null && /no two of them run straight through/.test(noRun.problem ?? ""), "no straight run - not a tee");
  const sizeChange = one([
    pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start"), c("end", "c", "start")]),
    pipe("b", "water-pipe", 3, 0, 6, 0, OD.cw20, [c("start", "a", "end")]),
    pipe("c", "water-pipe", 3, 0, 3, 2, OD.cw25, [c("start", "a", "end")])
  ]);
  assertTrue(sizeChange.fitting === null && /run changes size/.test(sizeChange.problem ?? ""), "the run changing size is reported");
});

check("four ends at one point, a custom size, a zero-length pipe: reported with a reason; conduits and cables are ignored", () => {
  const cross = one([
    pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start"), c("end", "c", "start"), c("end", "d", "start")]),
    pipe("b", "water-pipe", 3, 0, 6, 0, OD.cw25, [c("start", "a", "end")]),
    pipe("c", "water-pipe", 3, 0, 3, 2, OD.cw25, [c("start", "a", "end")]),
    pipe("d", "water-pipe", 3, 0, 3, -2, OD.cw25, [c("start", "a", "end")])
  ]);
  assertTrue(cross.fitting === null && /4 pipes meet/.test(cross.problem ?? ""), "cross");
  const custom = one([pipe("a", "water-pipe", 0, 0, 3, 0, 0.025, [c("end", "b", "start")]), pipe("b", "water-pipe", 3, 0, 3, 2, 0.025, [c("start", "a", "end")])]);
  assertTrue(custom.fitting === null && /custom 25 mm-OD water pipe/.test(custom.problem ?? ""), `custom size: ${custom.problem}`);
  const conduit = resolveJoints([pipe("a", "conduit", 0, 0, 3, 0, 0.02, [c("end", "b", "start")]), pipe("b", "conduit", 3, 0, 3, 2, 0.02, [c("start", "a", "end")])]);
  assertEqual(conduit.length, 0, "conduits have no plumbing fittings");
});

check("deterministic and never duplicated: each joint once, the same ids and order whatever the input order; a tee made as a star (the branch joined to one pipe) is still one joint", () => {
  const objects = [
    pipe("water-pipe-10", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "water-pipe-2", "start"), c("end", "water-pipe-3", "start")]),
    pipe("water-pipe-2", "water-pipe", 3, 0, 6, 0, OD.cw25, [c("start", "water-pipe-10", "end"), c("end", "water-pipe-4", "start")]),
    pipe("water-pipe-3", "water-pipe", 3, 0, 3, 2, OD.cw25, [c("start", "water-pipe-10", "end")]),
    pipe("water-pipe-4", "water-pipe", 6, 0, 6, 2, OD.cw25, [c("start", "water-pipe-2", "end")])
  ];
  const forward = JSON.stringify(resolveJoints(objects));
  const backward = JSON.stringify(resolveJoints([...objects].reverse()));
  assertEqual(backward, forward, "input order doesn't matter");
  const joints = resolveJoints(objects);
  assertEqual(joints.map(label).join(" | "), "25 mm 90° elbow | 25 mm equal tee", "an elbow and a tee, each once");
  assertEqual(joints[1].id, "joint:water-pipe-2:start+water-pipe-3:start+water-pipe-10:end", "members sorted with numeric ids");
});

check("half-recorded and dangling connections (states the store passes through mid-command) never crash or invent a fitting twice", () => {
  const half = resolveJoints([pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start")]), pipe("b", "water-pipe", 3, 0, 3, 2, OD.cw25, [])]);
  assertEqual(half.length, 1, "one joint from the side that records it");
  const dangling = resolveJoints([pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "missing", "start")])]);
  assertEqual(dangling.length, 1, "a joint of one end whose partner is gone");
  assertTrue(dangling[0].fitting === null, "and no fitting for it");
});

// --- geometry ---

check("fitting geometry is full size from the sheet: hubs wider than the pipe along each pipe, port lengths from the printed overall dimensions", () => {
  const elbow = one([pipe("a", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "b", "start")]), pipe("b", "water-pipe", 3, 0, 3, 2, OD.cw25, [c("start", "a", "end")])]);
  const geometry = fittingGeometry(elbow)!;
  // 90° elbow: H 13.50 mm kit x 5 = 67.5 mm = centre-to-end + hub radius (34.25 / 2 + 4.55).
  assertClose(geometry.centreToEnd[0], 0.0675 - (0.03425 / 2 + 0.00455), "elbow centre-to-end", 1e-6);
  const hubs = geometry.parts.filter((part) => part.role === "hub");
  assertEqual(hubs.length, 2, "one hub per pipe");
  for (const [index, hub] of hubs.entries()) {
    if (hub.shape !== "cylinder") throw new Error("hub is a cylinder");
    assertTrue(hub.radius > OD.cw25 / 2, "hub wider than the pipe");
    const direction = { x: hub.to.x - elbow.point.x, z: hub.to.z - elbow.point.z };
    const length = Math.hypot(direction.x, direction.z);
    const member = elbow.members[index];
    assertClose((direction.x * member.direction.x + direction.z * member.direction.z) / length, 1, "hub runs along its pipe");
    assertClose(hub.from.y, 0.3, "level with the pipes");
  }
  assertTrue(geometry.parts.some((part) => part.shape === "sphere"), "a ball closes the bend");
  assertTrue(geometry.parts.some((part) => part.role === "band"), "the clean-water blue band");
  const coupler = one([pipe("a", "drain-pipe", 0, 0, 3, 0, OD.san110, [c("end", "b", "start")]), pipe("b", "drain-pipe", 3, 0, 6, 0, OD.san110, [c("start", "a", "end")])]);
  assertClose(fittingGeometry(coupler)!.centreToEnd[0], 0.0725, "110 coupler: L 14.50 mm kit x 10 / 2");
  assertTrue(!fittingGeometry(coupler)!.parts.some((part) => part.role === "band"), "no band on grey sanitation fittings");
  for (const fitting of FITTINGS) {
    const lengths = centreToEnd(fitting, fitting.sizes.length === 1 ? [fitting.sizes[0], fitting.sizes[0], fitting.sizes[0]] : [fitting.sizes[0], fitting.sizes[0], fitting.sizes[1]], 2);
    assertTrue(lengths.every((length) => length > 0.01 && length < 0.3), `${fitting.id}: sane port lengths ${lengths.map((length) => length.toFixed(4)).join(", ")}`);
  }
});

// --- through the real model: commands, undo/redo, save/reopen, records ---

function addPipe(context: ProjectContext, kind: string, x1: number, z1: number, x2: number, z2: number, diameter: number): string {
  const result = context.commandExecutor.execute({
    type: "element.add",
    element: { kind, position: { x: (x1 + x2) / 2, y: 0.32, z: (z1 + z2) / 2 }, rotation: Math.atan2(-(z2 - z1), x2 - x1), dimensions: { length: Math.hypot(x2 - x1, z2 - z1), diameter } }
  });
  assertTrue(result.success && result.objectId, `add ${kind}: ${result.message}`);
  return result.objectId!;
}
function connect(context: ProjectContext, from: string, fromEnd: string, to: string, toEnd: string): void {
  const result = context.commandExecutor.execute({ type: "element.connect", from: { id: from, endpoint: fromEnd }, to: { id: to, endpoint: toEnd } });
  assertTrue(result.success, `connect: ${result.message}`);
}
const fittingsOf = (context: ProjectContext) => resolveJoints(buildAIProjectSnapshot(context).objects).map((joint) => `${label(joint)} @ ${joint.point.x},${joint.point.z}`).join(" | ");

check("fittings follow the real commands: connect adds one, a move carries it with the joint, disconnect and delete remove it - and undo/redo restore each state exactly", () => {
  const context = createProjectContext();
  const a = addPipe(context, "water-pipe", 0, 0, 3, 0, OD.cw25);
  const b = addPipe(context, "water-pipe", 3, 0, 3, 2, OD.cw25);
  assertEqual(fittingsOf(context), "", "no connection, no fitting");
  connect(context, b, "start", a, "end");
  assertEqual(fittingsOf(context), "25 mm 90° elbow @ 3,0", "connected: an elbow at the corner");
  // Sliding a along its own axis drags the joint; b's far end stays, so b swings off 90° - flagged at once, not drawn as an elbow.
  assertTrue(context.commandExecutor.execute({ type: "update_object", objectId: a, changes: { position: { x: 1, z: 0 } } }).success, "slide a");
  assertTrue(/UNRESOLVED: The pipes turn 76° here/.test(fittingsOf(context)), `swung off 90°: ${fittingsOf(context)}`);
  context.history.undo();
  assertEqual(fittingsOf(context), "25 mm 90° elbow @ 3,0", "undo: the elbow is back");
  // Moving a sideways keeps the corner square: the elbow moves with the joint.
  assertTrue(context.commandExecutor.execute({ type: "update_object", objectId: a, changes: { position: { x: 1.5, z: -1 } } }).success, "move a north");
  assertEqual(fittingsOf(context), "25 mm 90° elbow @ 3,-1", "the joint and its elbow moved with a");
  context.history.undo();
  assertEqual(fittingsOf(context), "25 mm 90° elbow @ 3,0", "undo the move");
  context.history.redo();
  assertEqual(fittingsOf(context), "25 mm 90° elbow @ 3,-1", "redo the move");
  context.history.undo();
  assertTrue(context.commandExecutor.execute({ type: "element.disconnect", from: { id: b }, to: { id: a } }).success, "disconnect");
  assertEqual(fittingsOf(context), "", "disconnected: no fitting");
  context.history.undo();
  assertEqual(fittingsOf(context), "25 mm 90° elbow @ 3,0", "undo the disconnect");
  assertTrue(context.commandExecutor.execute({ type: "element.delete", id: b }).success, "delete b");
  assertEqual(fittingsOf(context), "", "a deleted pipe takes its fitting with it");
  context.history.undo();
  assertEqual(fittingsOf(context), "25 mm 90° elbow @ 3,0", "undo the delete: the elbow is back, once");
});

check("fittings survive save and reopen exactly - with no change to the saved document's format", () => {
  const context = createProjectContext();
  const a = addPipe(context, "drain-pipe", 0, 0, 3, 0, OD.san110);
  const b = addPipe(context, "drain-pipe", 3, 0, 6, 0, OD.san110);
  const branch = addPipe(context, "drain-pipe", 3, 0, 3, 2, OD.san75);
  const corner = addPipe(context, "drain-pipe", 6, 0, 6, -3, OD.san110);
  connect(context, b, "start", a, "end");
  connect(context, branch, "start", a, "end");
  connect(context, corner, "start", b, "end");
  const before = fittingsOf(context);
  assertEqual(before, "110 × 75 mm reducing tee @ 3,0 | 110 mm 87.5° elbow @ 6,0", "a reducing tee and a bend");
  const document = JSON.parse(JSON.stringify(serializeProject(context)));
  assertTrue(!JSON.stringify(document).includes("fitting"), "nothing about fittings is written - they are derived");
  const reopened = createProjectContext();
  const loaded = loadProject(reopened, document);
  assertTrue(loaded.ok, `reopens: ${loaded.ok ? "" : loaded.error}`);
  assertEqual(fittingsOf(reopened), before, "the same fittings after reopening");
  assertEqual(JSON.stringify(resolveJoints(buildAIProjectSnapshot(reopened).objects)), JSON.stringify(resolveJoints(buildAIProjectSnapshot(context).objects)), "identical joint by joint");
});

check("the record book lists each fitting once with its sheet source, counts them in the totals, exports them, and stays identical after reopening; filtering keeps derived values", () => {
  const context = createProjectContext();
  const a = addPipe(context, "water-pipe", 0, 0, 3, 0, OD.cw25);
  const b = addPipe(context, "water-pipe", 3, 0, 3, 2, OD.cw25);
  const custom = addPipe(context, "water-pipe", 10, 0, 12, 0, 0.025);
  connect(context, b, "start", a, "end");
  const wall = context.commandExecutor.execute({ type: "wall.add", wall: { position: { x: 0, z: -5 } } });
  assertTrue(wall.success, "a wall");
  assertTrue(context.commandExecutor.execute({ type: "window.add", window: { hostId: wall.objectId } }).success, "with a window");
  const book = buildRecordBook(buildAIProjectSnapshot(context).objects);
  const elbow = book.rows.filter((row) => row.derived === "fitting");
  assertEqual(elbow.length, 1, "one fitting row");
  assertEqual(`${elbow[0].typeLabel} | ${elbow[0].materialLabel} | ${elbow[0].selectId}`, `25 mm 90° elbow | uPVC (clean water) | ${a}`, "its type, material, and the real pipe a click selects");
  assertTrue(/Sheet p\.2, 25 mm 90° ELBOW \(1:5 kit\)/.test(elbow[0].source ?? ""), `its source: ${elbow[0].source}`);
  assertTrue(/25 mm nominal main - Sheet p\.5/.test(book.rows.find((row) => row.id === a)!.source ?? ""), "a pipe row names its sheet size");
  assertTrue(/Custom size/.test(book.rows.find((row) => row.id === custom)!.source ?? ""), "a custom size says so");
  assertEqual(book.totals.find((total) => total.typeLabel === "25 mm 90° elbow")?.count, 1, "counted in the totals");
  const csv = recordBookCsv(book);
  assertTrue(csv.split("\r\n")[0] === RECORD_CSV_COLUMNS.join(",") && RECORD_CSV_COLUMNS.includes("Source / note"), "the CSV has a Source / note column");
  assertTrue(csv.includes(`${elbow[0].id},25 mm 90° elbow,25 mm 90° elbow,uPVC (clean water)`), "and the fitting line");
  const reopened = createProjectContext();
  assertTrue(loadProject(reopened, JSON.parse(JSON.stringify(serializeProject(context)))).ok, "reopens");
  assertEqual(recordBookCsv(buildRecordBook(buildAIProjectSnapshot(reopened).objects)), csv, "the CSV is identical after reopening");
  const onlyElbows = filterRecordBook(book, elbow[0].type);
  assertEqual(`${onlyElbows.rows.length} ${onlyElbows.totals.length} ${onlyElbows.totals[0]?.count}`, "1 1 1", "filtering by the fitting type keeps exactly it");
  const wallRow = book.rows.find((row) => row.type === "wall")!;
  assertEqual(filterRecordBook(book, "wall").rows[0].area, wallRow.area, "filtering by Wall keeps the window deduction");
});

// --- how pipes get made ---

check("the ribbon offers the sheet's other sizes as their own tools - each places the real outside diameter under its own placement id", () => {
  const calls: { kind: string; diameter: number | undefined; toolId: string | undefined }[] = [];
  const tabs = buildRibbonTabs({
    addWall: () => undefined,
    addPillar: () => undefined,
    addBeam: () => undefined,
    addSlab: () => undefined,
    addDoor: () => undefined,
    addWindow: () => undefined,
    addElement: (kind, options, placement) => void calls.push({ kind, diameter: options?.dimensions?.diameter, toolId: placement?.toolId }),
    addRoom: () => undefined,
    paintSelected: () => undefined,
    canPaintSelection: () => false,
    isPlacementActive: (id) => id === "water-pipe:20"
  });
  const plumbing = tabs.find((tab) => tab.id === "plumbing")!;
  const ids = plumbing.tools.map((tool) => tool.id);
  for (const id of ["water-pipe", "water-pipe:20", "water-pipe:15", "drain-pipe", "drain-pipe:75"]) assertTrue(ids.includes(id), `${id} on the Plumbing tab`);
  plumbing.tools.find((tool) => tool.id === "water-pipe:20")!.run();
  assertEqual(JSON.stringify(calls[0]), JSON.stringify({ kind: "water-pipe", diameter: pipeOutsideDiameter(PIPE_SIZES.find((size) => size.id === "cw-20")!), toolId: "water-pipe:20" }), "20 mm: its OD and its own tool id");
  assertTrue(plumbing.tools.find((tool) => tool.id === "water-pipe:20")!.isActive?.() === true && plumbing.tools.find((tool) => tool.id === "water-pipe")!.isActive?.() === false, "only the armed size shows active");
});

check("a pipe run is read from words: system, sheet size and points; it plans adds then joins, joins an existing end it starts on, and refuses what it can't build", () => {
  assertTrue(isPipeRun("Run a 25 mm water pipe from 0, 0 to 3, 0 to 3, 2"), "a run");
  assertTrue(!isPipeRun("Add a water pipe"), "no points: not a run");
  assertTrue(!isPipeRun("Create a 4 m by 5 m kitchen, 3 m high, at 0, 0"), "a room isn't a run");
  // Changing or removing a pipe that's there must never lay a new one.
  for (const edit of ["Move the water pipe from 0, 0 to 3, 0", "Delete the drain pipe from 0, 0 to 4, 0", "Rotate the pipe from 0, 0 to 3, 0", "Extend the water pipe from 3, 0 to 5, 0", "Remove the pipes from 0 0 to 3 0"]) {
    assertTrue(!isPipeRun(edit), `an edit isn't a new run: ${edit}`);
  }
  assertTrue(isPipeRun("Lay a drain pipe from 0 0 to 4 0 then 4 3"), "lay is a build verb");
  assertTrue(isPipeRun("Add a water pipe from 1, 1 to 1, 4"), "add is a build verb");
  const request = readPipeRun("Lay a 75 mm drain pipe from (0, 4) to (4, 4) then 4, 7 at a height of 0.2 m");
  assertEqual(`${request.kind} ${request.size?.id} ${request.points.map((point) => `${point.x},${point.z}`).join(" ")} ${request.height}`, "drain-pipe san-75 0,4 4,4 4,7 0.2", "read");
  assertEqual(readPipeRun("run a 32 mm water pipe from 0, 0 to 1, 0").size, null, "32 mm isn't a sheet size");
  const plan = planPipeRun(readPipeRun("run a water pipe from 0, 0 to 3, 0 to 3, 2"), []);
  assertTrue(plan.ok, "plans");
  if (!plan.ok) return;
  assertEqual(plan.commands.map((command) => (command as { type: string }).type).join(" "), "element.add element.add element.connect", "adds, then the join");
  const existing = [{ id: "water-pipe-7", kind: "water-pipe", position: { x: 1.5, y: 0.31, z: 0 }, rotation: 0, dimensions: { length: 3, diameter: OD.cw25 } }];
  const branch = planPipeRun(readPipeRun("run a 20 mm water pipe from 3, 0 to 3, 2"), existing);
  assertTrue(branch.ok && branch.joins.length === 1 && branch.joins[0].id === "water-pipe-7" && branch.y === 0.31, "starts on water-pipe-7's end: joins it, at its height");
  const tooShort = planPipeRun(readPipeRun("run a water pipe from 0, 0 to 0.01, 0"), []);
  assertTrue(!tooShort.ok && /shorter than 5 cm/.test(tooShort.reason), "a leg under 5 cm is refused");
});

check("only a request to build a NEW pipe is a run: not a cancel, a question, a look, or a pipe mentioned beside a wall or room", () => {
  for (const text of [
    "cancel the pipe from 0, 0 to 3, 0",
    "Don't run a pipe from 0, 0 to 3, 0",
    "How long is the pipe from 0, 0 to 3, 0?",
    "What fittings does the pipe from 0, 0 to 3, 0 need?",
    "focus on the pipe from 0, 0 to 3, 0",
    "zoom in on the pipe from 0, 0 to 3, 0",
    "Add a 3 m wall next to the water pipe from 0, 0 to 3, 0",
    "Create a 4 m by 5 m bathroom at 2, 2 with a drain pipe from 0, 0 to 3, 0",
    "Build a bathroom with a drain pipe from 0, 0 to 3, 0"
  ]) {
    assertTrue(!isPipeRun(text), `not a new run: ${text}`);
  }
  for (const text of ["Run a 25 mm hot water pipe from 0, 0 to 3, 0", "Could you lay drain pipes from 0 0 to 4 0", "install another 20 mm pipe from 1, 1 to 1, 4", "Run a 25 mm clean water uPVC pipe from 0, 0 to 2, 0"]) {
    assertTrue(isPipeRun(text), `a new run: ${text}`);
  }
  const hot = planPipeRun(readPipeRun("Run a 25 mm hot water pipe from 0, 0 to 3, 0"), []);
  assertTrue(hot.ok && JSON.stringify(hot.commands[0]).includes('"params":{"system":"hot"}'), "a hot water pipe is built with System: hot");
  const cold = planPipeRun(readPipeRun("Run a 25 mm water pipe from 0, 0 to 3, 0"), []);
  assertTrue(cold.ok && !JSON.stringify(cold.commands[0]).includes("params"), "otherwise the catalog default (cold)");
});

check("a run is planned as built: snapped ends give the legs and points, a loop closes on its start, a said height never loses silently, and two sizes line up", () => {
  const existing = [{ id: "water-pipe-7", kind: "water-pipe", position: { x: 1.5, y: 0.3167, z: 0 }, rotation: 0, dimensions: { length: 3, diameter: OD.cw25 } }];
  const snapped = planPipeRun(readPipeRun("run a water pipe from 3.03, 0 to 6, 0"), existing);
  assertTrue(snapped.ok, "plans");
  if (!snapped.ok) return;
  assertEqual(JSON.stringify(snapped.points), JSON.stringify([{ x: 3, z: 0 }, { x: 6, z: 0 }]), "the joined end is where it's built");
  assertEqual(snapped.legs.join(","), "3", "the leg as built: 3 m, not 2.97 m");

  const loop = planPipeRun(readPipeRun("run a water pipe from 0, 0 to 3, 0 to 3, 2 to 0, 2 to 0.02, 0"), []);
  assertTrue(loop.ok && loop.closed, "a run back to its start (within 5 cm) is a closed loop");
  if (!loop.ok) return;
  assertEqual(JSON.stringify(loop.commands[loop.commands.length - 1]), JSON.stringify({ type: "element.connect", from: { id: "$step:3", endpoint: "end" }, to: { id: "$step:0", endpoint: "start" } }), "joined at its start");
  assertEqual(JSON.stringify(loop.points[loop.points.length - 1]), JSON.stringify({ x: 0, z: 0 }), "ending exactly on its start");

  const conflict = planPipeRun(readPipeRun("run a water pipe from 3, 0 to 5, 0 at a height of 2 m"), existing);
  assertTrue(!conflict.ok && /You asked for 2 m/.test(conflict.reason) && /0\.317 m/.test(conflict.reason), "a said height the join can't keep is refused, saying why");
  const sameHeight = planPipeRun(readPipeRun("run a water pipe from 3, 0 to 5, 0 at a height of 0.3167 m"), existing);
  assertTrue(sameHeight.ok, "a said height that matches the join is fine");

  const twenty = { id: "water-pipe-8", kind: "water-pipe", position: { x: 6.5, y: 0.3133, z: 0 }, rotation: 0, dimensions: { length: 3, diameter: OD.cw20 } };
  const between = planPipeRun(readPipeRun("run a 25 mm water pipe from 3, 0 to 5, 0"), [...existing, twenty]);
  assertTrue(between.ok && between.realigned?.id === "water-pipe-8" && Math.abs(between.realigned.by - 0.0034) < 1e-9, "a 25 mm and a 20 mm pipe at their own default heights: the far one is lined up");
  if (!between.ok) return;
  assertEqual(JSON.stringify(between.commands[between.commands.length - 1]), JSON.stringify({ type: "element.connect", from: { id: "water-pipe-8", endpoint: "start" }, to: { id: "$step:0", endpoint: "end" } }), "connected from the existing pipe, so it moves to the run");
  const raised = { ...twenty, position: { ...twenty.position, y: 0.5 } };
  const tooFar = planPipeRun(readPipeRun("run a 25 mm water pipe from 3, 0 to 5, 0"), [...existing, raised]);
  assertTrue(!tooFar.ok && /different heights/.test(tooFar.reason), "more than the seating offset is still refused");
});

check("only uPVC pipes take the sheet: copper joints get nothing, a uPVC-to-CPVC joint is flagged, and the record book says so", () => {
  const copper = [{ ...pipe("water-pipe-1", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "water-pipe-2", "start")]), material: "copper" }, { ...pipe("water-pipe-2", "water-pipe", 3, 0, 3, 2, OD.cw25, [c("start", "water-pipe-1", "end")]), material: "copper" }];
  assertEqual(resolveJoints(copper).length, 0, "a copper corner: no uPVC fitting, no flag");
  const mixed = [{ ...copper[0], material: "upvc" }, { ...copper[1], material: "cpvc" }];
  assertTrue(/joins uPVC to cpvc pipe; the uPVC sheet has no adaptor/.test(label(one(mixed))), `uPVC to CPVC is flagged: ${label(one(mixed))}`);
  const pvcDrain = [{ ...pipe("drain-pipe-1", "drain-pipe", 0, 0, 3, 0, OD.san110, [c("end", "drain-pipe-2", "start")]), material: "pvc" }, { ...pipe("drain-pipe-2", "drain-pipe", 3, 0, 6, 0, OD.san110, [c("start", "drain-pipe-1", "end")]), material: "pvc" }];
  assertEqual(label(one(pvcDrain)), "110 mm coupler", "an older project's PVC (PVC-U) drain keeps its fittings");

  const context = createProjectContext();
  const add = (material: string, x1: number, z1: number, x2: number, z2: number): string => {
    const result = context.commandExecutor.execute({
      type: "element.add",
      element: { kind: "water-pipe", material, position: { x: (x1 + x2) / 2, y: 0.32, z: (z1 + z2) / 2 }, rotation: Math.atan2(-(z2 - z1), x2 - x1), dimensions: { length: Math.hypot(x2 - x1, z2 - z1), diameter: OD.cw25 } }
    });
    assertTrue(result.success, `add: ${result.message}`);
    return result.objectId!;
  };
  const a = add("copper", 0, 0, 3, 0);
  const b = add("copper", 3, 0, 3, 2);
  connect(context, b, "start", a, "end");
  const u = add("upvc", 10, 0, 13, 0);
  const v = add("cpvc", 13, 0, 13, 2);
  connect(context, v, "start", u, "end");
  const rows = buildRecordBook(buildAIProjectSnapshot(context).objects).rows;
  const row = (id: string) => rows.find((entry) => entry.id === id)!;
  assertTrue(/not covered by the uPVC fittings sheet/.test(row(a).source ?? ""), `a copper pipe gets no sheet size: ${row(a).source}`);
  const joints = rows.filter((entry) => entry.derived === "fitting");
  assertEqual(joints.length, 1, "no row for the copper corner; one for the uPVC-to-CPVC joint");
  assertEqual(`${joints[0].typeLabel} | ${joints[0].materialLabel}`, "Unresolved joint | uPVC (clean water) + CPVC", "listed under both materials, not as uPVC alone");
});

check("the ordinary ways of asking for a run are runs; questions and negated requests are not, wherever the words fall", () => {
  for (const text of [
    "put in a water pipe from 0, 0 to 3, 0",
    "add in a water pipe from 0, 0 to 3, 0",
    "Add on a 20 mm pipe from 3, 0 to 3, 2",
    "I need a 25 mm water pipe from 0, 0 to 3, 0",
    "I'd like a 20 mm water pipe from 0, 0 to 3, 0",
    "Run a 3 m water pipe from 0, 0 to 3, 0",
    "Add 2 water pipes from 0, 0 to 3, 0 to 3, 2",
    "Lay a 25-mm water pipe from 0, 0 to 3, 0",
    "Now run the hot water pipe from 0, 0 to 3, 0",
    "Pipe from 0, 0 to 3, 0",
    "Water pipe, 25 mm, from 0, 0 to 3, 0 to 3, 2",
    "Can you put in a water pipe from 0, 0 to 3, 0?",
    "Run a 25 mm water pipe from 0, 0 to 3, 0 to the stop valve",
    "Run a 25 mm water pipe from 0, 0 to 3, 0 with a stop end",
    "Run a 25 mm water pipe from 0, 0 to 3, 0 but don't connect it"
  ]) {
    assertTrue(isPipeRun(text), `a run: ${text}`);
  }
  for (const text of [
    "I did not ask you to add a pipe from 0, 0 to 3, 0",
    "I didn't ask you to run a pipe from 0, 0 to 3, 0",
    "You shouldn't have run a pipe from 0, 0 to 3, 0",
    "Do I need to lay a drain pipe from 0, 0 to 3, 0?",
    "Would it be better to run a pipe from 0, 0 to 3, 0?",
    "Should I run a water pipe from 0, 0 to 3, 0 or from 0, 0 to 0, 3?",
    "The pipes from 0, 0 to 3, 0 are leaking",
    "Move water pipe from 0, 0 to 3, 0",
    "Make the pipe from 0, 0 to 3, 0 longer",
    "I want the pipe from 0, 0 to 3, 0 removed"
  ]) {
    assertTrue(!isPipeRun(text), `not a run: ${text}`);
  }
});

check("a run's own words set its system, size and hot/cold - not another pipe the sentence mentions - and hot and cold are never joined", () => {
  assertEqual(readPipeRun("Run a 25 mm cold water pipe from 0, 0.2 to 3, 0.2 beside the hot water pipe").temperature, "cold", "beside the hot one: still cold");
  assertEqual(readPipeRun("Run a cold water pipe from 0, 0 to 3, 0 parallel to the hot one").temperature, "cold", "parallel to the hot one: cold");
  assertEqual(readPipeRun("Run a 25 mm hot water pipe from 0, 0 to 3, 0").temperature, "hot", "hot");
  assertEqual(readPipeRun("Run a water pipe from 0, 0 to 3, 0").temperature, null, "unsaid");
  assertEqual(readPipeRun("Run a 20 mm water pipe from 0, 0 to 3, 0 beside the 25 mm main").size?.nominal, 20, "the run's size, not the main's");
  assertEqual(readPipeRun("Run a water pipe from 0, 0 to 3, 0 beside the drain").kind, "water-pipe", "a water pipe beside a drain is a water pipe");

  const cold = { id: "water-pipe-1", kind: "water-pipe", position: { x: 1.5, y: 0.3167, z: 0 }, rotation: 0, dimensions: { length: 3, diameter: OD.cw25 } };
  const hot = { id: "water-pipe-2", kind: "water-pipe", position: { x: 6.5, y: 0.3167, z: 0 }, rotation: 0, dimensions: { length: 3, diameter: OD.cw25 }, system: "hot" };
  const hotOnCold = planPipeRun(readPipeRun("Run a 25 mm hot water pipe from 3, 0 to 3, 2"), [cold]);
  assertTrue(!hotOnCold.ok && /hot and cold supplies are never joined/.test(hotOnCold.reason), "a hot run starting on a cold pipe's end is refused");
  const between = planPipeRun(readPipeRun("Run a 25 mm water pipe from 3, 0 to 5, 0"), [cold, hot]);
  assertTrue(!between.ok && /\(cold water\) to water-pipe-2 \(hot water\)/.test(between.reason), "a run from a cold end to a hot end is refused");
  const continued = planPipeRun(readPipeRun("Run a 25 mm water pipe from 8, 0 to 8, 2"), [cold, hot]);
  assertTrue(continued.ok && continued.temperature === "hot" && JSON.stringify(continued.commands[0]).includes('"params":{"system":"hot"}'), "an unsaid run from a hot pipe's end continues hot");
  const plainCold = planPipeRun(readPipeRun("Run a 25 mm water pipe from 3, 0 to 3, 2"), [cold]);
  assertTrue(plainCold.ok && plainCold.temperature === "cold" && !JSON.stringify(plainCold.commands[0]).includes("params"), "and from a cold one stays cold (the default)");
});

check("paint is a finish: a painted uPVC pipe keeps its sheet size and fittings; a mixed joint's materials don't depend on pipe order", () => {
  const corner = [{ ...pipe("water-pipe-1", "water-pipe", 0, 0, 3, 0, OD.cw25, [c("end", "water-pipe-2", "start")]), material: "paint" }, { ...pipe("water-pipe-2", "water-pipe", 3, 0, 3, 2, OD.cw25, [c("start", "water-pipe-1", "end")]), material: "upvc" }];
  assertEqual(label(one(corner)), "25 mm 90° elbow", "one pipe painted: still the elbow");
  assertEqual(label(one(corner.map((entry) => ({ ...entry, material: "paint" })))), "25 mm 90° elbow", "both painted: still the elbow");

  const context = createProjectContext();
  const add = (material: string, x1: number, z1: number, x2: number, z2: number): string => {
    const result = context.commandExecutor.execute({
      type: "element.add",
      element: { kind: "water-pipe", material, position: { x: (x1 + x2) / 2, y: 0.32, z: (z1 + z2) / 2 }, rotation: Math.atan2(-(z2 - z1), x2 - x1), dimensions: { length: Math.hypot(x2 - x1, z2 - z1), diameter: OD.cw25 } }
    });
    assertTrue(result.success, `add: ${result.message}`);
    return result.objectId!;
  };
  const painted = add("paint", 20, 0, 23, 0);
  const tee = (x: number, second: string, third: string): void => {
    const main = add("upvc", x, 0, x + 3, 0);
    const b = add(second, x + 3, 0, x + 6, 0);
    const branch = add(third, x + 3, 0, x + 3, 2);
    connect(context, b, "start", main, "end");
    connect(context, branch, "start", main, "end");
  };
  tee(0, "cpvc", "copper");
  tee(10, "copper", "cpvc");
  const book = buildRecordBook(buildAIProjectSnapshot(context).objects);
  assertTrue(/Sheet p\.5/.test(book.rows.find((row) => row.id === painted)!.source ?? ""), "a painted pipe keeps its sheet size");
  const joints = book.rows.filter((row) => row.derived === "fitting");
  assertEqual(new Set(joints.map((row) => `${row.material} | ${row.materialLabel} | ${row.source}`)).size, 1, `the same materials in another order are the same row: ${joints.map((row) => row.material).join(", ")}`);
  const total = book.totals.find((entry) => entry.typeLabel === "Unresolved joint");
  assertEqual(total?.count, 2, "and one totals line, counting both");
});

check("a click on a fitting picks the visible pipe whose leg it's on - at reducing tees and Ys too, never a hidden one", () => {
  const pick = (objects: PipeLike[], offset: { x: number; y: number; z: number }, hidden: ReadonlySet<string> = new Set()) => {
    const joint = one(objects);
    const geometry = fittingGeometry(joint);
    assertTrue(geometry !== null, "a sheet fitting has geometry");
    return memberAtPoint(joint, geometry, hidden, { x: joint.point.x + offset.x, y: joint.point.y + offset.y, z: joint.point.z + offset.z });
  };
  // 110 x 75 reducing tee: the run continues +x, the 75 mm branch goes +z. This point is on the fat run's side, beside the branch.
  const reducingTee = [
    pipe("drain-pipe-1", "drain-pipe", 0, 0, 3, 0, OD.san110, [c("end", "drain-pipe-2", "start"), c("end", "drain-pipe-3", "start")]),
    pipe("drain-pipe-2", "drain-pipe", 3, 0, 6, 0, OD.san110, [c("start", "drain-pipe-1", "end")]),
    pipe("drain-pipe-3", "drain-pipe", 3, 0, 3, 2, OD.san75, [c("start", "drain-pipe-1", "end")])
  ];
  assertEqual(one(reducingTee).fitting?.id, "san-reducing-tee-110x75", "the joint is the reducing tee");
  assertEqual(pick(reducingTee, { x: 0.036, y: 0.037, z: 0.044 }), "drain-pipe-2", "on the run's surface beside the branch: the run pipe");
  assertEqual(pick(reducingTee, { x: 0, y: 0, z: 0.09 }), "drain-pipe-3", "out along the branch: the branch");
  assertEqual(pick(reducingTee, { x: 0, y: 0, z: 0.09 }, new Set(["drain-pipe-3"])) === "drain-pipe-3", false, "the branch hidden: never picked");
  // 110 single Y: the 45° branch reaches past the run's socket mouth.
  const s = Math.SQRT1_2;
  const y = [
    pipe("drain-pipe-1", "drain-pipe", 0, 0, 3, 0, OD.san110, [c("end", "drain-pipe-2", "start"), c("end", "drain-pipe-3", "start")]),
    pipe("drain-pipe-2", "drain-pipe", 3, 0, 6, 0, OD.san110, [c("start", "drain-pipe-1", "end")]),
    pipe("drain-pipe-3", "drain-pipe", 3, 0, 3 + 2 * s, 2 * s, OD.san110, [c("start", "drain-pipe-1", "end")])
  ];
  assertEqual(one(y).fitting?.id, "san-y-110", "the joint is the single Y");
  assertEqual(pick(y, { x: 0.123, y: -0.009, z: 0.041 }), "drain-pipe-3", "on the branch's hub past the run's mouth: the branch");
  assertEqual(pick(y, { x: -0.08, y: 0.05, z: 0 }), "drain-pipe-1", "on the incoming run: that pipe");
});

check("the 110 mm drain bends are measured to the drawn socket's outside (the kit wall), as printed", () => {
  const bend = FITTINGS.find((fitting) => fitting.id === "san-elbow-87.5-110")!;
  // (W + H) / 2 = 19.7 kit mm, less the drawn socket's outer radius 13.2 / 2 kit mm; x 10 (1:10) = 131 mm.
  assertClose(centreToEnd(bend, [110, 110], null)[0], 0.131, "87.5° bend: 131 mm centre to socket mouth", 1e-6);
  const fortyFive = FITTINGS.find((fitting) => fitting.id === "san-elbow-45-110")!;
  const leg = centreToEnd(fortyFive, [110, 110], null)[0];
  assertTrue(leg > 0.048 && leg < 0.131, `45° bend shorter than the 87.5° one, longer than its socket: ${leg}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  throw new Error(`${failed} plumbing check(s) failed`);
}
