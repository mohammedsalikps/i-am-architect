/**
 * REAL Supabase integration test - a development/staging project, never
 * production. NOT part of `npm run verify`. Run from backend/ with:
 *
 *   npm run test:integration
 *
 * which reads backend/.env.integration (gitignored - copy
 * backend/.env.integration.example). It needs the project's URL and anon
 * key, and two confirmed test accounts (users A and B).
 *
 * The real backend code (createServer + SupabaseAuthService +
 * SupabaseProjectStore) runs locally on loopback against the real project;
 * the AI provider is the keyless MockAIProvider (deployed.smoke.ts covers
 * real OpenAI). It checks, against the real database and Auth:
 *
 * - sign in, a wrong password, a forged token, session restore, refresh;
 * - that the anon key alone reads and writes nothing;
 * - the complete house: save -> list -> open -> compare -> edit -> save ->
 *   reopen -> delete, ids, transforms, dimensions, materials, hosts,
 *   connections and assemblies unchanged;
 * - that user B can't list, open, modify or delete user A's project -
 *   through the backend AND through PostgREST directly with B's own token;
 * - the database's own rules: owner and created_at can't be changed,
 *   updated_at moves, invalid documents and names are refused;
 * - sign out.
 *
 * It only ever creates projects owned by the two test users, named with
 * TEST_PROJECT_PREFIX, and deletes them again - including any left behind
 * by an interrupted earlier run. It never touches other data.
 */
import { randomUUID } from "node:crypto";
import { SupabaseAuthService } from "../src/auth/SupabaseAuthService.ts";
import { AuthError } from "../src/auth/AuthService.ts";
import { SupabaseProjectStore } from "../src/projects/SupabaseProjectRepository.ts";
import type { SupabaseFetch } from "../src/supabase/supabaseHttp.ts";
import { MockAIProvider } from "../../src/engine/ai/MockAIProvider.ts";
import { createProjectContext, serializeProject } from "../../src/engine/project/ProjectContext.ts";
import { ProjectPersistenceController } from "../../src/engine/project/ProjectPersistenceController.ts";
import { ProjectNotFoundError } from "../../src/engine/project/ProjectRepository.ts";
import type { ProjectDocument } from "../../src/engine/project/projectDocument.ts";
import { SESSION_STORAGE_KEY } from "../../src/engine/auth/AuthController.ts";
import { buildCompleteHouse } from "../../src/engine/testing/completeHouse.ts";
import { buildAIProjectSnapshot } from "../../src/engine/ai/types.ts";
import { analyzeConstructionGeometry } from "../../src/engine/ai/geometry/analyzeConstructionGeometry.ts";
import {
  TEST_PROJECT_PREFIX,
  assertEqual,
  assertRejects,
  assertSameJson,
  assertTrue,
  browserStack,
  createChecker,
  modelJson,
  readIntegrationEnv,
  startServer,
  storedSession
} from "./helpers.ts";

const EMPTY: ProjectDocument = { version: 1, objects: [], assemblies: [] };

async function run(): Promise<number> {
  const env = readIntegrationEnv(process.env, { deployed: false });
  const { check, note, finish } = createChecker();
  console.log(`Real Supabase integration test - project "${env.projectRef}" (confirmed non-production)\n`);

  const supabaseFetch: SupabaseFetch = (url, init) => fetch(url, init);
  const supabase = { url: env.supabaseUrl, anonKey: env.anonKey, fetch: supabaseFetch };
  const server = await startServer({
    provider: new MockAIProvider(),
    frontendOrigin: "http://localhost:5173",
    authService: new SupabaseAuthService(supabase),
    projectStore: new SupabaseProjectStore(supabase)
  });

  /** Direct PostgREST - bypassing the backend - with the anon key and, optionally, a user's own token. */
  const rest = (path: string, init: { method?: string; token?: string; body?: unknown; prefer?: string } = {}) =>
    fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
      method: init.method ?? "GET",
      headers: {
        apikey: env.anonKey,
        Accept: "application/json",
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.prefer ? { Prefer: init.prefer } : {})
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });

  const runLabel = `${TEST_PROJECT_PREFIX}${new Date().toISOString()}]`;
  let userA = browserStack(server.url);
  const userB = browserStack(server.url);
  const tokenOf = (stack: { storage: { map: Map<string, string> } }) => storedSession(stack.storage)?.accessToken ?? "";
  const idOf = (stack: { auth: { getState(): { user: { id: string } | null } } }) => stack.auth.getState().user?.id ?? "";
  /** Checks that need user B say so plainly - rather than carrying on without a token and failing as anonymous requests. */
  const requireUserB = () =>
    assertTrue(
      userB.auth.isSignedIn(),
      "user B is not signed in (see the user B sign-in check) - correct INTEGRATION_USER_B_EMAIL / INTEGRATION_USER_B_PASSWORD in backend/.env.integration"
    );

  let projectId = "";
  let original: ProjectDocument | null = null;
  /** Projects this run created - the only ones its cleanup deletes (besides stale leftovers of interrupted runs). */
  const ownIds = new Set<string>();

  try {
    // --- Authentication ---

    await check("real Supabase Auth: user A signs in through the backend; a wrong password and a forged token are refused", async () => {
      assertTrue(
        await userA.auth.signIn(env.userA.email, env.userA.password),
        `user A signs in (INTEGRATION_USER_A_EMAIL / INTEGRATION_USER_A_PASSWORD): ${userA.auth.getState().message}`
      );

      const wrong = browserStack(server.url);
      assertEqual(await wrong.auth.signIn(env.userA.email, "definitely-not-the-password"), false, "a wrong password");
      assertEqual(wrong.auth.getState().message, "Wrong email or password.", "gets the same short refusal as in local testing");
      await assertRejects(
        () => new SupabaseAuthService(supabase).getUser("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmb3JnZWQifQ.forged-signature"),
        (error) => error instanceof AuthError && error.status === 401,
        "Supabase refuses a forged token"
      );
      const forged = await fetch(`${server.url}/api/projects`, { headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmb3JnZWQifQ.x" } });
      assertEqual(forged.status, 401, "and so does the backend");
    });

    await check("real Supabase Auth: user B - a second, different account - signs in through the backend", async () => {
      assertTrue(
        await userB.auth.signIn(env.userB.email, env.userB.password),
        `user B signs in (INTEGRATION_USER_B_EMAIL / INTEGRATION_USER_B_PASSWORD): ${userB.auth.getState().message}`
      );
      assertTrue(idOf(userA) && idOf(userB) && idOf(userA) !== idOf(userB), "two different users");
    });

    await check("session persistence and refresh: a reload restores the session; an expired access token is refreshed with Supabase and rotated", async () => {
      const reloaded = browserStack(server.url, userA.storage);
      await reloaded.auth.start();
      assertEqual(reloaded.auth.getState().status, "signed-in", "the stored session is confirmed by Supabase");
      assertEqual(idOf(reloaded), idOf(userA), "as the same user");

      const before = storedSession(userA.storage);
      assertTrue(before, "a stored session");
      userA.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...before, expiresAt: Date.now() - 1000 }));
      const refreshed = browserStack(server.url, userA.storage);
      await refreshed.auth.start();
      assertEqual(refreshed.auth.getState().status, "signed-in", "refreshed rather than signed out");
      const after = storedSession(userA.storage);
      assertTrue(after && after.accessToken !== before.accessToken, "a new access token");
      assertTrue(after.refreshToken !== before.refreshToken, "and a rotated refresh token");
      assertTrue(after.expiresAt > Date.now(), "that expires in the future");
      // The old controller's refresh token has been rotated away - carry on with the refreshed one.
      userA = refreshed;
      assertSameJson(await userA.projects.list().then((list) => Array.isArray(list)), true, "the refreshed token works for project requests");
    });

    // --- The database itself ---

    await check("Row Level Security and grants: the anon key alone reads nothing and writes nothing", async () => {
      const read = await rest("projects?select=id");
      const readBody = read.status === 200 ? ((await read.json()) as unknown[]) : null;
      assertTrue(read.status === 401 || read.status === 403 || (readBody !== null && readBody.length === 0), `anon can't read projects (status ${read.status})`);
      const write = await rest("projects", { method: "POST", body: { name: `${runLabel} anon`, document: EMPTY }, prefer: "return=representation" });
      assertTrue(write.status === 401 || write.status === 403, `anon can't insert (status ${write.status})`);
    });

    // --- The complete house, through the backend ---

    const source = createProjectContext();
    const house = buildCompleteHouse(source);
    source.projectMeta.rename(`${runLabel} Complete House`);
    const target = createProjectContext();

    await check("complete house: save -> list -> open through the backend and real Supabase - ids, transforms, dimensions, materials, hosts, connections and assemblies unchanged", async () => {
      const saver = new ProjectPersistenceController({ repository: userA.projects, project: source });
      assertTrue(await saver.save(), `saved: ${saver.getState().message}`);
      projectId = source.projectMeta.get().id ?? "";
      ownIds.add(projectId);
      original = serializeProject(source);

      const summary = (await userA.projects.list()).find((entry) => entry.id === projectId);
      assertTrue(summary, "listed for its owner");
      assertEqual(summary.objectCount, original.objects.length, "the database's generated object count");
      assertEqual(summary.assemblyCount, original.assemblies.length, "and assembly count");

      const opener = new ProjectPersistenceController({ repository: userA.projects, project: target });
      assertTrue(await opener.open(projectId), `opened: ${opener.getState().message}`);
      assertSameJson(serializeProject(target), original, "the reopened model is exactly the saved document");
      assertEqual(modelJson(target), modelJson(source), "every object and assembly identical, ids included");
      assertEqual(target.doorStore.get(house.hostedDoor)?.hostId, house.frontWall, "the hosted door is in its wall");
      assertEqual(target.windowStore.get(house.hostedWindow)?.hostId, house.sideWall, "the hosted window is in its wall");
      for (const [a, b] of [house.supply, house.drain, house.conduit, house.cable]) {
        assertTrue(JSON.stringify(target.elementStore.get(a)).includes(`"${b}"`), `${a} is still connected to ${b}`);
      }
      assertSameJson(target.assemblyStore.get(house.assembly)?.objectIds, [house.rooms.Bathroom, ...house.fixtures], "the assembly's members");
      assertSameJson(
        analyzeConstructionGeometry(buildAIProjectSnapshot(target)),
        analyzeConstructionGeometry(buildAIProjectSnapshot(source)),
        "the same derived geometry"
      );
      assertEqual(target.history.canUndo(), false, "no history after opening");
    });

    await check("edit -> save -> reopen: the edit is stored; the database keeps created_at and moves updated_at", async () => {
      assertTrue(projectId, "the project from the previous check");
      const before = await userA.projects.get(projectId);
      assertTrue(before, "stored");
      const wall = target.wallStore.get(house.frontWall);
      assertTrue(wall, "the front wall");
      const moved = target.commandExecutor.execute({
        type: "update_object",
        objectId: house.frontWall,
        changes: { position: { x: wall.position.x + 0.5, y: wall.position.y, z: wall.position.z } }
      });
      assertTrue(moved.success, `the wall moved: ${moved.message}`);
      const editor = new ProjectPersistenceController({ repository: userA.projects, project: target });
      target.projectMeta.adopt(before);
      assertTrue(await editor.save(), `saved again: ${editor.getState().message}`);
      ownIds.add(target.projectMeta.get().id ?? "");

      const after = await userA.projects.get(projectId);
      assertEqual(Object.keys(after?.document ?? {}).join(","), "version,objects,assemblies", "the canonical envelope, although jsonb reorders keys in storage");
      assertSameJson(after?.document, serializeProject(target), "the stored document is the edited model, byte for byte");
      assertEqual(after?.createdAt, before.createdAt, "created_at is unchanged");
      assertTrue((after?.updatedAt ?? "") > before.updatedAt, "updated_at moved forward");
      assertEqual((await userA.projects.list()).filter((entry) => entry.id === projectId).length, 1, "the same project - never a duplicate");
    });

    // --- Two users ---

    await check("ownership through the backend: user B can't list, open, modify or delete user A's project", async () => {
      assertTrue(projectId && original, "A's project");
      requireUserB();
      const storedBefore = await userA.projects.get(projectId);
      assertTrue(!(await userB.projects.list()).some((entry) => entry.id === projectId), "not in B's list");
      assertEqual(await userB.projects.get(projectId), null, "B can't open it");
      await assertRejects(() => userB.projects.save(projectId, { name: "Taken over", document: EMPTY }), (error) => error instanceof ProjectNotFoundError, "B can't modify it");
      await assertRejects(() => userB.projects.delete(projectId), (error) => error instanceof ProjectNotFoundError, "B can't delete it");
      assertSameJson(await userA.projects.get(projectId), storedBefore, "A's project is untouched");
    });

    await check("ownership in the database itself: with B's own token, PostgREST (RLS) returns, changes and deletes none of A's rows, and refuses an insert in A's name", async () => {
      assertTrue(projectId, "A's project");
      requireUserB();
      const bToken = tokenOf(userB);
      const storedBefore = await userA.projects.get(projectId);

      const read = await rest(`projects?id=eq.${projectId}&select=id,name`, { token: bToken });
      assertEqual(read.status, 200, "the query itself is allowed");
      assertSameJson(await read.json(), [], "but A's row isn't visible to B");
      const update = await rest(`projects?id=eq.${projectId}&select=id`, { method: "PATCH", token: bToken, body: { name: "Taken over" }, prefer: "return=representation" });
      assertSameJson(update.status === 200 ? await update.json() : [], [], `no row updated (status ${update.status})`);
      const remove = await rest(`projects?id=eq.${projectId}&select=id`, { method: "DELETE", token: bToken, prefer: "return=representation" });
      assertSameJson(remove.status === 200 ? await remove.json() : [], [], `no row deleted (status ${remove.status})`);
      const insert = await rest("projects?select=id", {
        method: "POST",
        token: bToken,
        body: { user_id: idOf(userA), name: `${runLabel} forged`, document: EMPTY },
        prefer: "return=representation"
      });
      assertTrue(insert.status === 401 || insert.status === 403, `an insert in A's name is refused by the policy (status ${insert.status})`);
      assertSameJson(await userA.projects.get(projectId), storedBefore, "A's project is untouched");
    });

    await check("the database's own rules: the owner and created_at can't be changed; invalid documents and names are refused", async () => {
      assertTrue(projectId, "A's project");
      const aToken = tokenOf(userA);
      const before = await userA.projects.get(projectId);
      assertTrue(before, "stored");

      const tamper = await rest(`projects?id=eq.${projectId}&select=user_id,created_at,updated_at`, {
        method: "PATCH",
        token: aToken,
        // Any other owner id - the trigger must keep the project with A whatever is sent.
        body: { user_id: randomUUID(), created_at: "2000-01-01T00:00:00Z" },
        prefer: "return=representation"
      });
      assertEqual(tamper.status, 200, `the update itself is accepted (status ${tamper.status})`);
      const [row] = (await tamper.json()) as { user_id: string; created_at: string; updated_at: string }[];
      assertEqual(row?.user_id, idOf(userA), "the trigger keeps the owner - a project can't be handed to someone else");
      assertEqual(new Date(row?.created_at ?? "").toISOString(), before.createdAt, "and keeps created_at");

      for (const [label, body] of [
        ["a document whose objects aren't a list", { user_id: idOf(userA), name: `${runLabel} bad`, document: { version: 1, objects: {}, assemblies: [] } }],
        ["a blank name", { user_id: idOf(userA), name: "   ", document: EMPTY }],
        ["a document without a version", { user_id: idOf(userA), name: `${runLabel} bad`, document: { objects: [], assemblies: [] } }]
      ] as const) {
        const response = await rest("projects?select=id", { method: "POST", token: aToken, body, prefer: "return=representation" });
        if (response.status === 201) {
          // Accepted when it shouldn't have been: delete it now, confirm that,
          // and register it so the final cleanup retries if this failed.
          const [created] = (await response.json()) as { id: string }[];
          if (created) {
            ownIds.add(created.id);
            await rest(`projects?id=eq.${created.id}`, { method: "DELETE", token: aToken });
            const still = (await (await rest(`projects?id=eq.${created.id}&select=id`, { token: aToken })).json()) as unknown[];
            note(`${label} was accepted - the test row was ${still.length === 0 ? "deleted again" : "NOT deleted yet (final cleanup retries)"}`);
          }
        }
        assertEqual(response.status, 400, `${label} is refused by a database constraint`);
      }
    });

    await check("delete: the owner deletes the project, and it's gone", async () => {
      assertTrue(projectId, "A's project");
      await userA.projects.delete(projectId);
      assertEqual(await userA.projects.get(projectId), null, "gone");
      assertTrue(!(await userA.projects.list()).some((entry) => entry.id === projectId), "and not listed");
      projectId = "";
    });

    await check("sign out ends the Supabase session: its refresh token stops working", async () => {
      requireUserB();
      const session = storedSession(userB.storage);
      assertTrue(session, "B's session");
      await userB.auth.signOut();
      assertEqual(userB.auth.getState().status, "signed-out", "signed out");
      const refresh = await fetch(`${server.url}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken })
      });
      assertEqual(refresh.status, 401, "the refresh token is refused");
      const check = await fetch(`${server.url}/api/auth/session`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
      note(
        check.status === 401
          ? "after sign-out, Supabase also refuses the old access token"
          : `after sign-out the old access token is still accepted until it expires (status ${check.status}) - Supabase access tokens are stateless JWTs`
      );
    });
  } finally {
    // Clean up this run's projects, and test projects an interrupted run left
    // behind (idle for over an hour) - owned by the test users only. Never a
    // fresh test project: that belongs to another run still in progress.
    const staleBefore = Date.now() - 60 * 60 * 1000;
    for (const user of [env.userA, env.userB]) {
      const cleaner = browserStack(server.url);
      if (await cleaner.auth.signIn(user.email, user.password)) {
        const leftovers = (await cleaner.projects.list()).filter(
          (entry) => ownIds.has(entry.id) || (entry.name.startsWith(TEST_PROJECT_PREFIX) && Date.parse(entry.updatedAt) < staleBefore)
        );
        for (const entry of leftovers) {
          await cleaner.projects.delete(entry.id).catch(() => undefined);
        }
        if (leftovers.length > 0) {
          console.log(`  cleanup - removed ${leftovers.length} test project(s)`);
        }
        await cleaner.auth.signOut();
      }
    }
    await server.close();
  }

  return finish();
}

run()
  .then((failed) => {
    if (failed > 0) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
