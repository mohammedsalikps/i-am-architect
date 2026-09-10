/**
 * Shared helpers for the REAL-infrastructure tests in this directory -
 * supabase.integration.ts (a real Supabase project) and deployed.smoke.ts
 * (the deployed backend and frontend). These are deliberately NOT part of
 * `npm run verify`: they need credentials in backend/.env.integration
 * (gitignored) and reach real services. See DEPLOYMENT.md "Real
 * infrastructure tests".
 *
 * Nothing here prints a secret: failures name the variable, never its
 * value, and tokens are never logged.
 */
import type { AddressInfo } from "node:net";
import { createServer } from "../src/createServer.ts";
import type { CreateServerOptions } from "../src/createServer.ts";
import { isPrivilegedSupabaseKey } from "../src/config.ts";
import { HttpAuthClient } from "../../src/engine/auth/HttpAuthClient.ts";
import type { AuthFetch } from "../../src/engine/auth/HttpAuthClient.ts";
import { AuthController, SESSION_STORAGE_KEY } from "../../src/engine/auth/AuthController.ts";
import type { SessionStorageLike } from "../../src/engine/auth/AuthController.ts";
import type { AuthSession } from "../../src/engine/auth/types.ts";
import { HttpProjectRepository } from "../../src/engine/project/HttpProjectRepository.ts";
import type { ProjectFetch } from "../../src/engine/project/HttpProjectRepository.ts";
import { BackendAIProvider } from "../../src/engine/ai/providers/BackendAIProvider.ts";
import type { BackendFetch } from "../../src/engine/ai/providers/BackendAIProvider.ts";
import type { PersistableProject } from "../../src/engine/project/projectPersistence.ts";

export function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertSameJson(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}:\n  expected ${expectedJson.slice(0, 300)}\n  got      ${actualJson.slice(0, 300)}`);
  }
}

export async function assertRejects(fn: () => Promise<unknown>, check: (error: unknown) => boolean, message: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assertTrue(check(error), `${message}: unexpected error ${String(error)}`);
    return;
  }
  throw new Error(`${message}: expected a rejection`);
}

/** The same no-framework runner every verify.ts uses; returns the failure count. */
export function createChecker() {
  let passed = 0;
  let failed = 0;
  const notes: string[] = [];
  return {
    async check(name: string, fn: () => void | Promise<void>): Promise<void> {
      try {
        await fn();
        passed += 1;
        console.log(`  ok - ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`  FAIL - ${name}`);
        console.error(error instanceof Error ? error.message : error);
      }
    },
    /** An observation worth reporting that isn't a pass/fail rule. */
    note(text: string): void {
      notes.push(text);
      console.log(`  note - ${text}`);
    },
    finish(): number {
      console.log(`\n${passed} passed, ${failed} failed.`);
      return failed;
    }
  };
}

export interface TestUser {
  email: string;
  password: string;
}

export interface IntegrationEnv {
  supabaseUrl: string;
  anonKey: string;
  projectRef: string;
  userA: TestUser;
  userB: TestUser;
  deployedBackendUrl: string | null;
  deployedFrontendUrl: string | null;
  runAi: boolean;
}

/**
 * Reads and checks backend/.env.integration. Refuses to run unless the
 * target is explicitly confirmed to be a NON-production project whose ref
 * matches SUPABASE_URL, and never with a privileged key.
 */
export function readIntegrationEnv(env: Record<string, string | undefined>, options: { deployed: boolean }): IntegrationEnv {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "INTEGRATION_PROJECT_REF",
    "INTEGRATION_CONFIRM_NON_PRODUCTION",
    "INTEGRATION_USER_A_EMAIL",
    "INTEGRATION_USER_A_PASSWORD",
    "INTEGRATION_USER_B_EMAIL",
    "INTEGRATION_USER_B_PASSWORD",
    ...(options.deployed ? ["DEPLOYED_BACKEND_URL", "DEPLOYED_FRONTEND_URL"] : [])
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Set these in backend/.env.integration (see backend/.env.integration.example): ${missing.join(", ")}`);
  }
  const value = (name: string) => (env[name] ?? "").trim();

  if (value("INTEGRATION_CONFIRM_NON_PRODUCTION") !== "yes") {
    throw new Error('INTEGRATION_CONFIRM_NON_PRODUCTION must be "yes" - these tests create and delete data, so they only run against a development/staging project.');
  }
  let url: URL;
  try {
    url = new URL(value("SUPABASE_URL"));
  } catch {
    throw new Error("SUPABASE_URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("SUPABASE_URL must be https://.");
  }
  const ref = value("INTEGRATION_PROJECT_REF");
  if (url.hostname.split(".")[0] !== ref) {
    throw new Error("INTEGRATION_PROJECT_REF does not match SUPABASE_URL - check that these tests point at the intended staging project.");
  }
  if (isPrivilegedSupabaseKey(value("SUPABASE_ANON_KEY"))) {
    throw new Error("SUPABASE_ANON_KEY holds a service-role/secret key - use the anon/publishable key.");
  }
  if (value("INTEGRATION_USER_A_EMAIL").toLowerCase() === value("INTEGRATION_USER_B_EMAIL").toLowerCase()) {
    throw new Error("Users A and B must be two different accounts.");
  }
  const https = (name: string): string | null => {
    const raw = value(name);
    if (!raw) {
      return null;
    }
    if (!raw.startsWith("https://")) {
      throw new Error(`${name} must be an https:// URL.`);
    }
    return raw.replace(/\/+$/, "");
  };

  return {
    supabaseUrl: url.origin,
    anonKey: value("SUPABASE_ANON_KEY"),
    projectRef: ref,
    userA: { email: value("INTEGRATION_USER_A_EMAIL"), password: value("INTEGRATION_USER_A_PASSWORD") },
    userB: { email: value("INTEGRATION_USER_B_EMAIL"), password: value("INTEGRATION_USER_B_PASSWORD") },
    deployedBackendUrl: https("DEPLOYED_BACKEND_URL"),
    deployedFrontendUrl: https("DEPLOYED_FRONTEND_URL"),
    runAi: value("DEPLOYED_RUN_AI") === "yes"
  };
}

export function memoryStorage(): SessionStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    }
  };
}

export function storedSession(storage: { map: Map<string, string> }): AuthSession | null {
  return JSON.parse(storage.map.get(SESSION_STORAGE_KEY) ?? "null") as AuthSession | null;
}

/** What src/main.ts builds against `baseUrl`: the auth controller, and project and AI clients sending the user's token. */
export function browserStack(baseUrl: string, storage = memoryStorage()) {
  const authFetch: AuthFetch = (url, init) => fetch(url, init);
  const auth = new AuthController({ client: new HttpAuthClient({ baseUrl, fetch: authFetch }), storage });
  const projectFetch: ProjectFetch = auth.authorize((url: string, init: Parameters<ProjectFetch>[1]) => fetch(url, init));
  const aiFetch: BackendFetch = auth.authorize((url: string, init: Parameters<BackendFetch>[1]) => fetch(url, init));
  return {
    auth,
    storage,
    projects: new HttpProjectRepository({ baseUrl, fetch: projectFetch }),
    ai: new BackendAIProvider({ baseUrl, fetch: aiFetch, timeoutMs: 60_000 })
  };
}

/** Starts a real createServer() on an ephemeral loopback port. */
export async function startServer(options: CreateServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

/** Every object in all seven stores, and the assemblies - the whole model as the stores hold it. */
export function modelJson(context: PersistableProject): string {
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

/** Test projects are named with this prefix, so a later run can clean up after an interrupted one - touching nothing else. */
export const TEST_PROJECT_PREFIX = "[integration ";
