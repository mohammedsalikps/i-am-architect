// Explicit .ts extension on this value import lets Node run this file
// directly (the verify suites do). Harmless for Vite.
import { AuthRequestError, parseSession } from "./types.ts";
import type { AuthClient, AuthSession, AuthUser, SignUpResult } from "./types";

export interface AuthHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type AuthFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<AuthHttpResponse>;

export interface HttpAuthClientOptions {
  /** The backend's base URL. Required. */
  baseUrl: string;
  /** Injected transport - never defaulted to a global fetch. */
  fetch: AuthFetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(payload: unknown, fallback: string): string {
  return isPlainObject(payload) && typeof payload.error === "string" ? payload.error : fallback;
}

/**
 * The browser's client for the backend's /api/auth routes. Holds nothing
 * but the base URL and the injected transport - no identity-provider key.
 * Every failure becomes an AuthRequestError carrying the server's own
 * message ("Wrong email or password.") and status.
 */
export class HttpAuthClient implements AuthClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: AuthFetch;
  private readonly timeoutMs: number;

  constructor(options: HttpAuthClientOptions) {
    if (!options || typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
      throw new Error('HttpAuthClient requires a non-empty "baseUrl".');
    }
    if (typeof options.fetch !== "function") {
      throw new Error('HttpAuthClient requires an injected "fetch" transport.');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async signUp(email: string, password: string): Promise<SignUpResult> {
    const { status, payload } = await this.request("POST", "/api/auth/signup", { email, password });
    if (status === 202 && isPlainObject(payload) && payload.confirmationRequired === true) {
      return { confirmationRequired: true, email: typeof payload.email === "string" ? payload.email : email };
    }
    if (status === 201 || status === 200) {
      return { session: this.session(payload) };
    }
    throw new AuthRequestError(status, errorText(payload, "Could not create the account."));
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const { status, payload } = await this.request("POST", "/api/auth/signin", { email, password });
    if (status === 200) {
      return this.session(payload);
    }
    throw new AuthRequestError(status, errorText(payload, "Could not sign in."));
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const { status, payload } = await this.request("POST", "/api/auth/refresh", { refreshToken });
    if (status === 200) {
      return this.session(payload);
    }
    throw new AuthRequestError(status, errorText(payload, "Your session expired - sign in again."));
  }

  async signOut(accessToken: string): Promise<void> {
    const { status, payload } = await this.request("POST", "/api/auth/signout", undefined, accessToken);
    if (status !== 204 && status !== 200 && status !== 401) {
      throw new AuthRequestError(status, errorText(payload, "Could not sign out."));
    }
  }

  async getUser(accessToken: string): Promise<AuthUser> {
    const { status, payload } = await this.request("GET", "/api/auth/session", undefined, accessToken);
    if (status === 200 && isPlainObject(payload) && isPlainObject(payload.user)) {
      const { id, email } = payload.user;
      if (typeof id === "string" && typeof email === "string") {
        return { id, email };
      }
    }
    throw new AuthRequestError(status === 200 ? 502 : status, errorText(payload, "Your session expired - sign in again."));
  }

  private session(payload: unknown): AuthSession {
    const session = parseSession(isPlainObject(payload) ? payload.session : undefined);
    if (!session) {
      throw new AuthRequestError(502, "The server sent a malformed session.");
    }
    return session;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    accessToken?: string
  ): Promise<{ status: number; payload: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    let response: AuthHttpResponse;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
    } catch (error) {
      const reason = controller.signal.aborted ? `no response within ${this.timeoutMs}ms` : error instanceof Error ? error.message : String(error);
      throw new AuthRequestError(0, `Could not reach the sign-in server: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown = null;
    if (response.status !== 204) {
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
    }
    return { status: response.status, payload };
  }
}
