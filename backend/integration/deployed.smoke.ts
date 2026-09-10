/**
 * Smoke test for the DEPLOYED application - the hosted backend and the
 * hosted frontend, over the internet. NOT part of `npm run verify`. Run
 * from backend/ with:
 *
 *   npm run test:deployed
 *
 * which reads backend/.env.integration (gitignored): DEPLOYED_BACKEND_URL,
 * DEPLOYED_FRONTEND_URL, the staging Supabase settings, and the two test
 * accounts. With DEPLOYED_RUN_AI=yes it also sends ONE small AI request
 * through the deployed backend to the real OpenAI API (a few cents at most).
 *
 * It checks: HTTPS, the health endpoint, CORS (the frontend allowed, other
 * origins refused), that signed-out project and AI requests are refused,
 * the frontend's Content-Security-Policy and that its bundle holds no
 * secret, a project round trip and two-user isolation on the deployed
 * backend, the AI path end to end (with undo/redo), and sign-out.
 */
import { AIService } from "../../src/engine/ai/AIService.ts";
import { createProjectContext } from "../../src/engine/project/ProjectContext.ts";
import { ProjectNotFoundError } from "../../src/engine/project/ProjectRepository.ts";
import type { ProjectDocument } from "../../src/engine/project/projectDocument.ts";
import { buildAIProjectSnapshot } from "../../src/engine/ai/types.ts";
import {
  TEST_PROJECT_PREFIX,
  assertEqual,
  assertRejects,
  assertSameJson,
  assertTrue,
  browserStack,
  createChecker,
  readIntegrationEnv,
  storedSession
} from "./helpers.ts";

const EMPTY: ProjectDocument = { version: 1, objects: [], assemblies: [] };

/** Patterns that must never appear in anything served to a browser. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["an OpenAI key", /sk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ["a Supabase secret key", /sb_secret_/],
  ["a service-role reference", /service_role/],
  ["an OPENAI_API_KEY reference", /OPENAI_API_KEY/],
  ["a database connection string", /postgres(ql)?:\/\//]
];

async function run(): Promise<number> {
  const env = readIntegrationEnv(process.env, { deployed: true });
  const backend = env.deployedBackendUrl as string;
  const frontend = env.deployedFrontendUrl as string;
  const frontendOrigin = new URL(frontend).origin;
  const { check, note, finish } = createChecker();
  console.log(`Deployed smoke test\n  backend:  ${backend}\n  frontend: ${frontend}\n`);

  await check("the backend is served over HTTPS, and /health answers with no internal detail", async () => {
    const health = await fetch(`${backend}/health`);
    assertEqual(health.status, 200, "status");
    assertSameJson(await health.json(), { status: "ok" }, "only { status: 'ok' } - no configuration, versions or database details");
    const plain = backend.replace(/^https:/, "http:");
    try {
      const response = await fetch(`${plain}/health`, { redirect: "manual" });
      assertTrue([301, 302, 307, 308].includes(response.status), `plain HTTP must not be served (got ${response.status})`);
      assertTrue((response.headers.get("location") ?? "").startsWith("https://"), "it redirects to HTTPS");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("plain HTTP")) {
        throw error;
      }
      note("plain HTTP is not reachable at all (no listener) - also fine");
    }
  });

  await check("CORS: the deployed frontend is allowed by name; any other origin is refused", async () => {
    const allowed = await fetch(`${backend}/api/projects`, {
      method: "OPTIONS",
      headers: { Origin: frontendOrigin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" }
    });
    assertEqual(allowed.status, 204, "the frontend's preflight");
    assertEqual(allowed.headers.get("access-control-allow-origin"), frontendOrigin, "allowed by name, never '*'");
    assertTrue((allowed.headers.get("access-control-allow-headers") ?? "").includes("Authorization"), "the Authorization header is allowed");
    for (const origin of ["https://evil.example", `${frontendOrigin}.evil.example`]) {
      const refused = await fetch(`${backend}/api/projects`, { method: "OPTIONS", headers: { Origin: origin } });
      assertEqual(refused.status, 403, `${origin} is refused`);
      assertEqual(refused.headers.get("access-control-allow-origin"), null, `${origin} gets no CORS grant`);
    }
  });

  await check("signed out, the deployed backend refuses project and AI requests", async () => {
    const projects = await fetch(`${backend}/api/projects`);
    assertEqual(projects.status, 401, "projects");
    const ai = await fetch(`${backend}/api/ai/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "Add a wall", projectContext: buildAIProjectSnapshot(createProjectContext()) })
    });
    assertEqual(ai.status, 401, "AI - an anonymous caller can't spend the OpenAI quota");
    assertEqual(((await ai.json()) as { code?: string }).code, "unauthorized", "with the unauthorized code");
  });

  await check("the frontend: served over HTTPS with a Content-Security-Policy naming this backend, and no secret anywhere in what it serves", async () => {
    const page = await fetch(frontend);
    assertEqual(page.status, 200, "the page");
    const html = await page.text();
    const csp = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/i.exec(html)?.[1] ?? "";
    assertTrue(csp.includes(`connect-src 'self' ${new URL(backend).origin}`), `the CSP lets the page reach only itself and the backend: "${csp}"`);
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => new URL(match[1], frontend).toString());
    const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((match) => new URL(match[1], frontend).toString());
    assertTrue(scripts.length > 0, "the page loads its bundle");
    const assets = [html];
    for (const url of [...scripts, ...styles]) {
      assets.push(await (await fetch(url)).text());
    }
    const served = assets.join("\n");
    for (const [label, pattern] of SECRET_PATTERNS) {
      assertTrue(!pattern.test(served), `no ${label} in the served frontend`);
    }
    assertTrue(!served.includes(env.anonKey), "not even the Supabase anon key - the browser never talks to Supabase");
    assertTrue(served.includes(new URL(backend).host), "the bundle points at the deployed backend");
  });

  const userA = browserStack(backend);
  const userB = browserStack(backend);
  let projectId = "";

  try {
    await check("real accounts on the deployed backend: A and B sign in; A saves, lists, reopens and deletes a project; B can't see or touch it", async () => {
      assertTrue(await userA.auth.signIn(env.userA.email, env.userA.password), `A signs in: ${userA.auth.getState().message}`);
      assertTrue(await userB.auth.signIn(env.userB.email, env.userB.password), `B signs in: ${userB.auth.getState().message}`);
      const created = await userA.projects.create({ name: `${TEST_PROJECT_PREFIX}${new Date().toISOString()}] deployed`, document: EMPTY });
      projectId = created.id;
      assertEqual(created.ownerId, userA.auth.getState().user?.id, "owned by A");
      assertTrue((await userA.projects.list()).some((entry) => entry.id === projectId), "listed for A");
      assertSameJson((await userA.projects.get(projectId))?.document, EMPTY, "reopened intact");

      assertTrue(!(await userB.projects.list()).some((entry) => entry.id === projectId), "not listed for B");
      assertEqual(await userB.projects.get(projectId), null, "B can't open it");
      await assertRejects(() => userB.projects.save(projectId, { name: "Taken", document: EMPTY }), (error) => error instanceof ProjectNotFoundError, "B can't modify it");
      await assertRejects(() => userB.projects.delete(projectId), (error) => error instanceof ProjectNotFoundError, "B can't delete it");

      await userA.projects.delete(projectId);
      assertEqual(await userA.projects.get(projectId), null, "A deleted it");
      projectId = "";
    });

    if (env.runAi) {
      await check("AI in production: a signed-in user's instruction goes through the deployed backend to OpenAI, the commands build the model, and undo/redo work", async () => {
        const context = createProjectContext();
        const service = new AIService({ provider: userA.ai, commandExecutor: context.commandExecutor, history: context.history, snapshotSource: context });
        const result = await service.submit("Add one wall 5 meters long.");
        assertTrue(result.success, `the AI response built something: ${JSON.stringify(result.errors)}`);
        const built = buildAIProjectSnapshot(context).objects.length;
        assertTrue(built > 0, `objects were created (${built})`);
        context.history.undo();
        assertEqual(buildAIProjectSnapshot(context).objects.length, 0, "one undo removes the whole AI response");
        context.history.redo();
        assertEqual(buildAIProjectSnapshot(context).objects.length, built, "redo brings it back");
      });
    } else {
      note("AI in production skipped - set DEPLOYED_RUN_AI=yes to send one small real OpenAI request");
    }

    await check("sign out on the deployed backend ends the session", async () => {
      const session = storedSession(userB.storage);
      assertTrue(session, "B's session");
      await userB.auth.signOut();
      const refresh = await fetch(`${backend}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken })
      });
      assertEqual(refresh.status, 401, "the refresh token is refused");
      await assertRejects(() => userB.projects.list(), (error) => error instanceof Error, "signed out, project requests fail");
    });
  } finally {
    if (projectId) {
      await userA.projects.delete(projectId).catch(() => undefined);
    }
    for (const stack of [userA, userB]) {
      if (stack.auth.isSignedIn()) {
        await stack.auth.signOut();
      }
    }
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
