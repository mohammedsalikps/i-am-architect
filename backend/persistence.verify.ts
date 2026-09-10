/**
 * The complete-house persistence round trip, end to end: a house built
 * through CommandExecutor in one browser workspace is saved through the
 * real stack (AuthController + HttpProjectRepository -> the real server ->
 * per-user storage), opened into a fresh workspace after a "reload" (the
 * session restored from storage), and compared - then edited by hand and by
 * AI (the keyless MockAIProvider behind the real server), with undo and
 * redo, and saved again. Run with (from inside backend/):
 *   node --experimental-transform-types persistence.verify.ts
 * (transform-types because it drives the real ProjectContext, whose
 * history controllers use TypeScript parameter properties).
 *
 * No credentials, and nothing beyond loopback: accounts are
 * InMemoryAuthService's, projects InMemoryProjectStore's, and the AI is
 * MockAIProvider - no OpenAI request is possible.
 */
import type { AddressInfo } from "node:net";
import { createServer } from "./src/createServer.ts";
import { InMemoryAuthService } from "./src/auth/InMemoryAuthService.ts";
import { MockAIProvider } from "../src/engine/ai/MockAIProvider.ts";
import { InMemoryProjectStore } from "../src/engine/project/InMemoryProjectRepository.ts";
import { createProjectContext, serializeProject } from "../src/engine/project/ProjectContext.ts";
import type { ProjectContext } from "../src/engine/project/ProjectContext.ts";
import { ProjectPersistenceController } from "../src/engine/project/ProjectPersistenceController.ts";
import { HttpProjectRepository } from "../src/engine/project/HttpProjectRepository.ts";
import type { ProjectFetch } from "../src/engine/project/HttpProjectRepository.ts";
import { HttpAuthClient } from "../src/engine/auth/HttpAuthClient.ts";
import type { AuthFetch } from "../src/engine/auth/HttpAuthClient.ts";
import { AuthController } from "../src/engine/auth/AuthController.ts";
import type { SessionStorageLike } from "../src/engine/auth/AuthController.ts";
import { BackendAIProvider } from "../src/engine/ai/providers/BackendAIProvider.ts";
import type { BackendFetch } from "../src/engine/ai/providers/BackendAIProvider.ts";
import { AIService } from "../src/engine/ai/AIService.ts";
import { buildAIProjectSnapshot } from "../src/engine/ai/types.ts";
import type { AIProviderRequest } from "../src/engine/ai/types.ts";
import type { AIProvider } from "../src/engine/ai/AIProvider.ts";
import { buildAIProjectContext } from "../src/engine/ai/aiProjectContext.ts";
import { analyzeConstructionGeometry } from "../src/engine/ai/geometry/analyzeConstructionGeometry.ts";
import { buildCompleteHouse } from "../src/engine/testing/completeHouse.ts";

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertSameJson(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}:\n  expected ${expectedJson.slice(0, 400)}\n  got      ${actualJson.slice(0, 400)}`);
  }
}

const FRONTEND_ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery";

/** Every object in all seven stores, and the assemblies - the whole model as the stores hold it. */
function modelJson(context: ProjectContext): string {
  return JSON.stringify({
    objects: [
      ...context.wallStore.getAll(),
      ...context.pillarStore.getAll(),
      ...context.beamStore.getAll(),
      ...context.slabStore.getAll(),
      ...context.doorStore.getAll(),
      ...context.windowStore.getAll(),
      ...context.elementStore.getAll()
    ],
    assemblies: context.assemblyStore.getAll()
  });
}

function memoryStorage(): SessionStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    }
  };
}

/** What src/main.ts builds: the auth controller, and project and AI clients whose requests carry the user's token. */
function browserStack(baseUrl: string, storage: SessionStorageLike) {
  const authFetch: AuthFetch = (url, init) => fetch(url, init);
  const auth = new AuthController({ client: new HttpAuthClient({ baseUrl, fetch: authFetch }), storage });
  const projectFetch: ProjectFetch = auth.authorize((url: string, init: Parameters<ProjectFetch>[1]) => fetch(url, init));
  const aiFetch: BackendFetch = auth.authorize((url: string, init: Parameters<BackendFetch>[1]) => fetch(url, init));
  return {
    auth,
    projects: new HttpProjectRepository({ baseUrl, fetch: projectFetch }),
    ai: new BackendAIProvider({ baseUrl, fetch: aiFetch })
  };
}

/** The keyless MockAIProvider (what `npm run mock` runs), recording what the server handed it. */
function recordingMockProvider(): AIProvider & { calls: AIProviderRequest[] } {
  const mock = new MockAIProvider();
  const calls: AIProviderRequest[] = [];
  return {
    calls,
    interpret: (request) => {
      calls.push(request);
      return mock.interpret(request);
    }
  };
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(error);
    }
  }

  console.log("Complete-house persistence verification (full stack)\n");

  const provider = recordingMockProvider();
  const server = createServer({
    provider,
    frontendOrigin: FRONTEND_ORIGIN,
    authService: new InMemoryAuthService(),
    projectStore: new InMemoryProjectStore()
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const storage = memoryStorage();
    const source = createProjectContext();
    const house = buildCompleteHouse(source);
    source.projectMeta.rename("Complete House");
    const original = serializeProject(source);
    let projectId = "";

    await check("save: a signed-in user saves the complete house through the real HTTP stack - one validated document, no history touched", async () => {
      const browser = browserStack(baseUrl, storage);
      assertTrue(await browser.auth.signUp("builder@example.com", PASSWORD), `signed up: ${browser.auth.getState().message}`);
      const persistence = new ProjectPersistenceController({ repository: browser.projects, project: source });
      const undoBefore = source.history.canUndo();

      assertTrue(await persistence.save(), `saved: ${persistence.getState().message}`);
      projectId = source.projectMeta.get().id ?? "";
      assertEqual(persistence.getState().message, 'Saved "Complete House".', "message");
      assertEqual(source.history.canUndo(), undoBefore, "saving added no undo entry");

      const stored = await browser.projects.get(projectId);
      assertSameJson(stored?.document, original, "the stored document is exactly the serialized model");
      assertEqual(stored?.ownerId, browser.auth.getState().user?.id, "owned by the user");
      assertSameJson(
        (await browser.projects.list()).map((summary) => [summary.id, summary.name, summary.objectCount, summary.assemblyCount]),
        [[projectId, "Complete House", original.objects.length, original.assemblies.length]],
        "listed with its counts"
      );
    });

    const target = createProjectContext();
    const reloaded = browserStack(baseUrl, storage);
    const persistence = new ProjectPersistenceController({ repository: reloaded.projects, project: target });

    await check("reload + open: the session is restored and the house opens into a fresh workspace - serialize(load(save(model))) is the model", async () => {
      await reloaded.auth.start();
      assertEqual(reloaded.auth.getState().status, "signed-in", "the stored session is restored");
      const summaries = await persistence.listProjects();
      assertEqual(summaries[0]?.id, projectId, "the saved house is listed");

      assertTrue(await persistence.open(projectId), `opened: ${persistence.getState().message}`);
      assertSameJson(serializeProject(target), original, "the reopened model serializes to exactly the saved document");
      assertEqual(modelJson(target), modelJson(source), "every store holds exactly what the original held - same ids, same values");
      assertEqual(target.projectMeta.get().name, "Complete House", "the project's name");
      assertEqual(target.projectMeta.get().id, projectId, "and identity");
      assertEqual(target.history.canUndo(), false, "nothing to undo");
      assertEqual(target.history.canRedo(), false, "nothing to redo");
      assertEqual(target.selectionStore.get(), null, "nothing selected");
    });

    await check("relationships survive the round trip: hosted openings, connected runs, the assembly - and the geometry derived from them", () => {
      assertEqual(target.doorStore.get(house.hostedDoor)?.hostId, house.frontWall, "the door is in the front wall");
      assertSameJson(target.doorStore.get(house.hostedDoor)?.hostPlacement, source.doorStore.get(house.hostedDoor)?.hostPlacement, "at the same place");
      assertEqual(target.windowStore.get(house.hostedWindow)?.hostId, house.sideWall, "the window is in the side wall");
      for (const [a, b] of [house.supply, house.drain, house.conduit, house.cable]) {
        assertSameJson(target.elementStore.get(a), source.elementStore.get(a), `${a} is restored, connections included`);
        assertTrue(JSON.stringify(target.elementStore.get(a)).includes(`"${b}"`), `${a} is still connected to ${b}`);
      }
      assertSameJson(target.assemblyStore.get(house.assembly)?.objectIds, [house.rooms.Bathroom, ...house.fixtures], "the assembly's members");
      assertSameJson(
        analyzeConstructionGeometry(buildAIProjectSnapshot(target)),
        analyzeConstructionGeometry(buildAIProjectSnapshot(source)),
        "the same derived geometry"
      );
    });

    const loaded = modelJson(target);
    let manuallyEdited = "";

    await check("manual edit after the load: moving the front wall carries its door; undo and redo restore each state exactly", () => {
      const wall = target.wallStore.get(house.frontWall);
      const door = target.doorStore.get(house.hostedDoor);
      assertTrue(wall && door, "the front wall and its door");
      const result = target.commandExecutor.execute({
        type: "update_object",
        objectId: house.frontWall,
        changes: { position: { x: wall.position.x + 0.5, y: wall.position.y, z: wall.position.z } }
      });
      assertTrue(result.success, `moved: ${result.message}`);
      assertTrue(Math.abs((target.doorStore.get(house.hostedDoor)?.position.x ?? Number.NaN) - (door.position.x + 0.5)) < 1e-9, "the door moved with its wall");
      manuallyEdited = modelJson(target);

      target.history.undo();
      assertEqual(modelJson(target), loaded, "undo restores the opened house exactly");
      assertEqual(target.history.canUndo(), false, "the open itself is not an undo step");
      target.history.redo();
      assertEqual(modelJson(target), manuallyEdited, "redo replays the move");
    });

    await check("AI after the load: the request carries the restored ids, types, dimensions and relationships, and update_object edits the restored wall as one undo step", async () => {
      const service = new AIService({ provider: reloaded.ai, commandExecutor: target.commandExecutor, history: target.history, snapshotSource: target });
      const expectedContext = buildAIProjectContext(buildAIProjectSnapshot(target));

      const result = await service.submit(`Make ${house.frontWall} 11 meters long`);
      assertTrue(result.success, `the AI edit ran: ${JSON.stringify(result.errors)}`);

      const request = provider.calls[provider.calls.length - 1];
      assertTrue(request, "the server called its provider");
      assertSameJson(request.projectContext, expectedContext, "the server's sanitized context is exactly the workspace's - nothing restored was lost");
      assertTrue(JSON.stringify(request.projectContext).includes(`"hostId":"${house.frontWall}"`), "the AI sees the door's host");
      assertEqual(target.wallStore.get(house.frontWall)?.dimensions.length, 11, "the restored wall is 11 m long");
      assertEqual(target.doorStore.get(house.hostedDoor)?.hostId, house.frontWall, "its door is still in it");

      target.history.undo();
      assertEqual(modelJson(target), manuallyEdited, "one undo reverts the whole AI edit");
      target.history.redo();
      assertEqual(target.wallStore.get(house.frontWall)?.dimensions.length, 11, "redo replays it");
      target.history.undo();
      target.history.undo();
      assertEqual(modelJson(target), loaded, "undoing both edits returns to the opened house");
      assertEqual(target.history.canUndo(), false, "and nothing before it");
      target.history.redo();
      target.history.redo();
      assertEqual(target.wallStore.get(house.frontWall)?.dimensions.length, 11, "redo brings both edits back");
    });

    await check("save again after editing: the stored copy is the edited model, the project is the same one, and history is untouched", async () => {
      const undoBefore = target.history.canUndo();
      assertTrue(await persistence.save(), `saved: ${persistence.getState().message}`);
      assertEqual(target.projectMeta.get().id, projectId, "the same project");
      const stored = await reloaded.projects.get(projectId);
      assertSameJson(stored?.document, serializeProject(target), "the stored document is the edited model");
      assertEqual((await reloaded.projects.list()).length, 1, "still one project - saving never duplicates");
      assertEqual(target.history.canUndo(), undoBefore, "saving changed nothing in the undo history");
      target.history.undo();
      assertEqual(
        target.wallStore.get(house.frontWall)?.dimensions.length,
        source.wallStore.get(house.frontWall)?.dimensions.length,
        "and undo still reverts the AI edit, back to the wall's original length"
      );
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

// See src/engine/ai/verify.ts's matching comment for why this rethrows
// instead of setting `process.exitCode`.
run().catch((error) => {
  console.error(error);
  throw error;
});
