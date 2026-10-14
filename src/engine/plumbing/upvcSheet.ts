/**
 * Source data from "Clean-water uPVC fittings engineering sheet.pdf"
 * (7 pages; expected in the repository at
 * docs/reference/clean-water-upvc-fittings-engineering-sheet.pdf).
 *
 * The sheet draws two model-making kits: clean water at 1:5 and
 * sanitation at 1:10. Everything here is kept the way the sheet prints it
 * - KIT values in millimetres, with the page, the printed item name and
 * the printed scale - and nothing full-size is stored. A full-size value
 * is only ever computed from a kit value and its scale (fullSizeMetres()),
 * so a kit dimension can never be mistaken for a real pipe dimension.
 *
 * Kit walls ("KIT WALL") are the model's robust model-making walls, NOT
 * scale walls (sheet page 5); they are kept for the kit but never scaled
 * up. Where the sheet's labels can't be interpreted from the drawing
 * alone (some a/b dimensions) the printed numbers are kept and listed in
 * SHEET_NOTES, never "corrected".
 *
 * Transcribed from the sheet's page images and cross-checked by two
 * independent transcriptions; checked against the standard sizes in
 * validateUpvcSheet() (see plumbing/verify.ts). Beam boxes A/B (page 7)
 * are provisional on the sheet and deliberately not included.
 */

export const SHEET = {
  title: "Clean-water uPVC fittings engineering sheet",
  file: "Clean-water uPVC fittings engineering sheet.pdf",
  expectedPath: "docs/reference/clean-water-upvc-fittings-engineering-sheet.pdf",
  pages: 7
} as const;

export type PlumbingSystem = "clean-water" | "sanitation";

/** The sheet's printed scale for each system: a kit millimetre is this many real millimetres. */
export const SYSTEM_SCALE: Readonly<Record<PlumbingSystem, number>> = { "clean-water": 5, sanitation: 10 };

/** The element kind each system's pipes are in this app. */
export const SYSTEM_KIND: Readonly<Record<PlumbingSystem, "water-pipe" | "drain-pipe">> = { "clean-water": "water-pipe", sanitation: "drain-pipe" };

export interface SheetSource {
  page: number;
  /** The item's name exactly as printed. */
  item: string;
}

/** Kit millimetres, as printed. */
export type KitValues = Readonly<Record<string, number>>;

export interface PipeSize {
  id: string;
  system: PlumbingSystem;
  /** The sheet's nominal size, millimetres. */
  nominal: number;
  role: string;
  /** Kit values (mm, as printed): od, trueWall, kitWall, socketBore, socketDepth (+ sanitation: kitId, socketOd, moduleLength). */
  kit: KitValues;
  source: SheetSource;
}

export const PIPE_SIZES: readonly PipeSize[] = [
  {
    id: "cw-25",
    system: "clean-water",
    nominal: 25,
    role: "main",
    kit: { od: 6.68, trueWall: 0.676, kitWall: 1.0, socketBore: 6.85, socketDepth: 5.72 },
    source: { page: 5, item: "25 mm NOMINAL MAIN" }
  },
  {
    id: "cw-20",
    system: "clean-water",
    nominal: 20,
    role: "branch",
    kit: { od: 5.334, trueWall: 0.574, kitWall: 1.0, socketBore: 5.5, socketDepth: 5.08 },
    source: { page: 5, item: "20 mm NOMINAL BRANCH" }
  },
  {
    id: "cw-15",
    system: "clean-water",
    nominal: 15,
    role: "fixture",
    kit: { od: 4.268, trueWall: 0.554, kitWall: 1.0, socketBore: 4.45, socketDepth: 4.44 },
    source: { page: 5, item: "15 mm NOMINAL FIXTURE" }
  },
  {
    id: "san-110",
    system: "sanitation",
    nominal: 110,
    role: "main",
    kit: { od: 11.0, trueWall: 0.32, kitWall: 1.0, kitId: 9.0, socketBore: 11.2, socketOd: 13.2, socketDepth: 4.8, moduleLength: 100.0 },
    source: { page: 6, item: "SANITATION PIPE" }
  },
  {
    // No 75 mm pipe page: its OD is the 110 x 75 reducer's printed SMALL END, its socket the page's SMALL SOCKET line.
    id: "san-75",
    system: "sanitation",
    nominal: 75,
    role: "branch",
    kit: { od: 7.5, socketBore: 7.7, socketDepth: 4.0 },
    source: { page: 4, item: "REDUCER 110 × 75 (SMALL END) / SMALL SOCKET" }
  }
];

export type FittingType = "coupler" | "reducer" | "elbow-90" | "elbow-45" | "elbow-87.5" | "tee" | "reducing-tee" | "single-y";

export interface FittingSpec {
  id: string;
  system: PlumbingSystem;
  type: FittingType;
  /** Nominal sizes, largest first: [run] or [run, branch/small end]. */
  sizes: readonly number[];
  label: string;
  kit: KitValues;
  source: SheetSource;
}

/** The fittings this slice resolves joints to. End caps, tank nipples, tap elbows, access pipes and P-traps are later slices. */
export const FITTINGS: readonly FittingSpec[] = [
  { id: "cw-coupler-25", system: "clean-water", type: "coupler", sizes: [25], label: "25 mm coupler", kit: { H: 11.9, wall: 0.91, socketDepth: 5.72 }, source: { page: 2, item: "25 mm COUPLER" } },
  { id: "cw-elbow-90-25", system: "clean-water", type: "elbow-90", sizes: [25], label: "25 mm 90° elbow", kit: { H: 13.5, wall: 0.91, socketDepth: 5.72 }, source: { page: 2, item: "25 mm 90° ELBOW" } },
  { id: "cw-elbow-45-25", system: "clean-water", type: "elbow-45", sizes: [25], label: "25 mm 45° elbow", kit: { H: 15.5, wall: 0.91, socketDepth: 5.72 }, source: { page: 2, item: "25 mm 45° ELBOW" } },
  { id: "cw-tee-25", system: "clean-water", type: "tee", sizes: [25], label: "25 mm equal tee", kit: { H: 18.4, H1: 13.5, wall: 0.91, socketDepth: 5.72 }, source: { page: 2, item: "25 mm EQUAL TEE" } },
  {
    id: "cw-reducer-25x20",
    system: "clean-water",
    type: "reducer",
    sizes: [25, 20],
    label: "25 × 20 mm reducer",
    kit: { H: 12.8, wallLarge: 0.91, wallSmall: 0.78, socketDepthLarge: 5.72, socketDepthSmall: 5.08 },
    source: { page: 1, item: "REDUCER 25 × 20" }
  },
  {
    id: "cw-reducing-tee-25x20",
    system: "clean-water",
    type: "reducing-tee",
    sizes: [25, 20],
    label: "25 × 20 mm reducing tee",
    kit: { H: 18.42, H1: 13.48, wallLarge: 0.91, wallSmall: 0.78, socketDepthLarge: 5.72, socketDepthSmall: 5.08 },
    source: { page: 1, item: "REDUCING TEE 25 × 20" }
  },
  { id: "san-coupler-110", system: "sanitation", type: "coupler", sizes: [110], label: "110 mm coupler", kit: { L: 14.5, Z: 0.3 }, source: { page: 3, item: "COUPLER" } },
  { id: "san-elbow-87.5-110", system: "sanitation", type: "elbow-87.5", sizes: [110], label: "110 mm 87.5° elbow", kit: { W: 19.6, H: 19.8, b: 5.6, kitWall: 1.0 }, source: { page: 3, item: "87.5° ELBOW" } },
  { id: "san-elbow-45-110", system: "sanitation", type: "elbow-45", sizes: [110], label: "110 mm 45° elbow", kit: { W: 17.0, H: 21.1, b: 2.3, kitWall: 1.0 }, source: { page: 3, item: "45° ELBOW" } },
  { id: "san-tee-110", system: "sanitation", type: "tee", sizes: [110], label: "110 mm plain tee", kit: { L: 18.5, a: 5.7, b: 5.7 }, source: { page: 3, item: "PLAIN TEE" } },
  { id: "san-y-110", system: "sanitation", type: "single-y", sizes: [110], label: "110 mm single Y", kit: { L: 22.75, a: 12.9, b: 12.9 }, source: { page: 3, item: "SINGLE Y" } },
  {
    id: "san-reducer-110x75",
    system: "sanitation",
    type: "reducer",
    sizes: [110, 75],
    label: "110 × 75 mm reducer",
    kit: { largeEnd: 11.0, smallEnd: 7.5, a: 1.75, b: 2.15 },
    source: { page: 4, item: "REDUCER 110 × 75" }
  },
  {
    id: "san-reducing-tee-110x75",
    system: "sanitation",
    type: "reducing-tee",
    sizes: [110, 75],
    label: "110 × 75 mm reducing tee",
    kit: { L: 17.8, a: 5.9, b: 5.9 },
    source: { page: 4, item: "REDUCING TEE 110 × 75" }
  }
];

/**
 * Printed values whose meaning the drawing doesn't settle. They are kept
 * as printed and not used for any calculation; where geometry needs a
 * length the sheet doesn't give unambiguously, fittingGeometry.ts says
 * which rule it uses instead.
 */
export const SHEET_NOTES: readonly string[] = [
  "Page 4, REDUCING TEE 110 × 75: a = b = 5.90 mm are drawn across the body and the branch, but are smaller than the 75 mm pipe's own 7.50 mm kit OD - meaning unclear; not used.",
  "Pages 3-4: the a/b values of the plain tee, single Y and 110 × 75 reducer, and b of the two sanitation elbows, aren't defined on the sheet - kept as printed; only the single Y's a is used (as the branch length from the run axis).",
  "Pages 1-2: clean-water fitting WALL values (0.91 / 0.78 / 0.75 mm) aren't marked kit or true scale; they are below the 1.00 mm kit wall, so they are treated as true-scale walls for drawing fittings.",
  "Pages 2 and 5: the kit socket bores are about 0.17 mm (0.85 mm full size) larger than the pipe ODs - a model-making push-fit clearance, so they are used only to size fitting hubs.",
  "Sanitation fittings give only a 1.00 mm KIT WALL (not to scale); fittings are drawn with the pipe's true 1:10 wall (0.32 mm kit, 3.2 mm full size) instead.",
  "Page 7, Beam Box A/B: marked PROVISIONAL with no scale - not included."
];

/** A kit millimetre value as a real-world length in metres. */
export function fullSizeMetres(kitMillimetres: number, system: PlumbingSystem): number {
  return (kitMillimetres * SYSTEM_SCALE[system]) / 1000;
}

/** A pipe's real outside diameter, metres. */
export function pipeOutsideDiameter(size: PipeSize): number {
  return fullSizeMetres(size.kit.od, size.system);
}

export function pipeSizesFor(system: PlumbingSystem): PipeSize[] {
  return PIPE_SIZES.filter((size) => size.system === system);
}

export function systemOfKind(kind: string): PlumbingSystem | null {
  return kind === "water-pipe" ? "clean-water" : kind === "drain-pipe" ? "sanitation" : null;
}

/** How far a stored diameter may be from a sheet size's real OD and still be that size, metres. */
export const SIZE_TOLERANCE = 0.0005;

/** The sheet size a pipe of `kind` with this outside diameter is - or null (a custom size the sheet has no parts for). */
export function pipeSizeFor(kind: string, diameter: number): PipeSize | null {
  const system = systemOfKind(kind);
  if (!system) return null;
  return pipeSizesFor(system).find((size) => Math.abs(pipeOutsideDiameter(size) - diameter) <= SIZE_TOLERANCE) ?? null;
}

export function findFitting(system: PlumbingSystem, type: FittingType, sizes: readonly number[]): FittingSpec | null {
  return FITTINGS.find((fitting) => fitting.system === system && fitting.type === type && fitting.sizes.length === sizes.length && fitting.sizes.every((size, index) => size === sizes[index])) ?? null;
}

/** "Sheet p.2, 25 mm 90° ELBOW (1:5 kit)" - where a value came from. */
export function describeSource(source: SheetSource, system: PlumbingSystem): string {
  return `Sheet p.${source.page}, ${source.item} (1:${SYSTEM_SCALE[system]} kit)`;
}

/**
 * Published sizes the sheet's scaled-up values are checked against
 * (validateUpvcSheet): ASTM D1785 Schedule 40 outside diameters and
 * minimum walls and ASTM D2466 socket depths for the clean-water sizes
 * (25/20/15 mm nominal = 1", 3/4", 1/2"), EN 1401 / EN 1329 outside
 * diameters for sanitation. Millimetres.
 */
export const REFERENCE_SIZES: Readonly<Record<string, { od: number; wall?: number; socketDepth?: number; standard: string }>> = {
  "cw-25": { od: 33.4, wall: 3.38, socketDepth: 28.6, standard: "ASTM D1785 Sch 40 / D2466, 1 in" },
  "cw-20": { od: 26.67, wall: 2.87, socketDepth: 25.4, standard: "ASTM D1785 Sch 40 / D2466, 3/4 in" },
  "cw-15": { od: 21.34, wall: 2.77, socketDepth: 22.2, standard: "ASTM D1785 Sch 40 / D2466, 1/2 in" },
  "san-110": { od: 110, wall: 3.2, standard: "EN 1401 / EN 1329, 110 mm" },
  "san-75": { od: 75, standard: "EN 1329, 75 mm" }
};

export interface SheetCheck {
  ok: boolean;
  message: string;
}

/**
 * Consistency checks on the transcribed values - scaled-up sizes against
 * the published standards, sockets against pipes, and the same value
 * printed on two pages agreeing. A failure is reported, never fixed.
 */
export function validateUpvcSheet(): SheetCheck[] {
  const checks: SheetCheck[] = [];
  const check = (ok: boolean, message: string) => checks.push({ ok, message });
  const mm = (value: number) => `${Number(value.toFixed(3))} mm`;
  for (const size of PIPE_SIZES) {
    const scale = SYSTEM_SCALE[size.system];
    const reference = REFERENCE_SIZES[size.id];
    const od = size.kit.od * scale;
    check(Math.abs(od - reference.od) <= 0.05, `${size.id}: OD ${mm(size.kit.od)} × ${scale} = ${mm(od)}; ${reference.standard} ${mm(reference.od)}`);
    if (reference.wall !== undefined && size.kit.trueWall !== undefined) {
      const wall = size.kit.trueWall * scale;
      check(Math.abs(wall - reference.wall) <= 0.05, `${size.id}: true wall ${mm(size.kit.trueWall)} × ${scale} = ${mm(wall)}; ${reference.standard} ${mm(reference.wall)}`);
    }
    if (reference.socketDepth !== undefined) {
      const depth = size.kit.socketDepth * scale;
      check(Math.abs(depth - reference.socketDepth) <= 0.2, `${size.id}: socket depth ${mm(size.kit.socketDepth)} × ${scale} = ${mm(depth)}; ${reference.standard} ${mm(reference.socketDepth)}`);
    }
    check(size.kit.socketBore > size.kit.od, `${size.id}: socket bore ${mm(size.kit.socketBore)} is larger than the pipe OD ${mm(size.kit.od)}`);
    if (size.kit.kitId !== undefined && size.kit.kitWall !== undefined) {
      check(Math.abs(size.kit.od - 2 * size.kit.kitWall - size.kit.kitId) <= 0.005, `${size.id}: kit ID ${mm(size.kit.kitId)} = OD - 2 × kit wall`);
    }
    if (size.kit.socketOd !== undefined && size.kit.kitWall !== undefined) {
      check(Math.abs(size.kit.socketBore + 2 * size.kit.kitWall - size.kit.socketOd) <= 0.005, `${size.id}: socket OD ${mm(size.kit.socketOd)} = bore + 2 × kit wall`);
    }
  }
  // Fittings' socket depths (pages 1-2) must equal their pipes' (page 5).
  const depthOf = (system: PlumbingSystem, nominal: number) => PIPE_SIZES.find((size) => size.system === system && size.nominal === nominal)?.kit.socketDepth;
  for (const fitting of FITTINGS.filter((entry) => entry.system === "clean-water")) {
    const large = fitting.kit.socketDepth ?? fitting.kit.socketDepthLarge;
    check(large === depthOf("clean-water", fitting.sizes[0]), `${fitting.id}: socket depth ${mm(large)} matches the ${fitting.sizes[0]} mm pipe's`);
    if (fitting.kit.socketDepthSmall !== undefined) {
      check(fitting.kit.socketDepthSmall === depthOf("clean-water", fitting.sizes[1]), `${fitting.id}: small socket depth ${mm(fitting.kit.socketDepthSmall)} matches the ${fitting.sizes[1]} mm pipe's`);
    }
  }
  const reducer = FITTINGS.find((fitting) => fitting.id === "san-reducer-110x75")!;
  check(reducer.kit.largeEnd === PIPE_SIZES.find((size) => size.id === "san-110")!.kit.od, "san-reducer-110x75: LARGE END equals the 110 mm pipe OD (page 6)");
  return checks;
}
