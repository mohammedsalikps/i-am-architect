import { AuthError } from "./AuthService.ts";
import type { AuthService, AuthSession, AuthUser, SignUpOutcome } from "./AuthService.ts";
import { SupabaseUnavailableError, describeUpstream, supabaseErrorCode, supabaseMessage, supabaseRequest } from "../supabase/supabaseHttp.ts";
import type { SupabaseConfig, UpstreamShape } from "../supabase/supabaseHttp.ts";

export interface SupabaseAuthServiceOptions extends SupabaseConfig {
  /** Defaults to Date.now - used only when Supabase sends expires_in without expires_at. */
  now?: () => number;
}

const EXPIRED = "Your session expired - sign in again.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toUser(value: unknown): AuthUser | null {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.email !== "string") {
    return null;
  }
  return { id: value.id, email: value.email };
}

/**
 * Why a 200 from the sign-in service couldn't be used, for the log:
 * - not-supabase-auth: the body wasn't JSON (a web page) - SUPABASE_URL
 *   points at something other than Supabase Auth.
 * - unexpected-json: JSON, but nothing of a session or user in it.
 * - missing-session-fields: a session without its access or refresh token.
 * - missing-user-fields: no user, or a user without an id or email.
 */
export type AuthFailureCategory = "not-supabase-auth" | "unexpected-json" | "missing-session-fields" | "missing-user-fields";

const has = (value: unknown): string => (typeof value === "string" && value.length > 0 ? "yes" : "no");

/** Which user fields an answer has - "yes"/"no" only, never a value. */
function userFields(user: unknown): string {
  const record = isPlainObject(user) ? user : {};
  return `user id ${has(record.id)}, user email ${has(record.email)}`;
}

function sessionFindings(payload: unknown): { fields: string; category: AuthFailureCategory } {
  const record = isPlainObject(payload) ? payload : {};
  const fields =
    `access_token ${has(record.access_token)}, refresh_token ${has(record.refresh_token)}, ` +
    `user ${isPlainObject(record.user) ? "yes" : "no"}, ${userFields(record.user)}`;
  if (!isPlainObject(payload) || !("access_token" in payload || "refresh_token" in payload || "user" in payload)) {
    return { fields, category: "unexpected-json" };
  }
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") {
    return { fields, category: "missing-session-fields" };
  }
  return { fields, category: "missing-user-fields" };
}

function userFindings(payload: unknown): { fields: string; category: AuthFailureCategory } {
  const unexpected = !isPlainObject(payload) || !("id" in payload || "email" in payload);
  return { fields: userFields(payload), category: unexpected ? "unexpected-json" : "missing-user-fields" };
}

/**
 * Supabase Auth (GoTrue) over its REST API - /auth/v1/signup, /token,
 * /logout and /user - with the project's anon key. No Supabase SDK, so the
 * backend keeps its zero-dependency footprint, and no service-role key:
 * everything here is what a signed-out visitor, or the signed-in user
 * themselves, is allowed to do.
 *
 * Supabase's error bodies are turned into AuthErrors with short messages
 * meant for the user ("Wrong email or password.") - never its raw output.
 */
export class SupabaseAuthService implements AuthService {
  private readonly config: SupabaseConfig;
  private readonly now: () => number;

  constructor(options: SupabaseAuthServiceOptions) {
    const { now, ...config } = options;
    this.config = config;
    this.now = now ?? (() => Date.now());
  }

  async signUp(email: string, password: string): Promise<SignUpOutcome> {
    const { status, payload, shape } = await this.call("POST", "/auth/v1/signup", { body: { email, password } });
    if (status === 200 || status === 201) {
      if (isPlainObject(payload) && typeof payload.access_token === "string") {
        return { session: this.session(payload, shape) };
      }
      // Email confirmation is on. Supabase answers an address that is
      // already registered the same way, so this never reveals whether an
      // account exists.
      return { confirmationRequired: true, email };
    }
    throw this.refusal(status, payload, "Could not create the account.");
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const { status, payload, shape } = await this.call("POST", "/auth/v1/token?grant_type=password", { body: { email, password } });
    if (status === 200) {
      return this.session(payload, shape);
    }
    throw this.refusal(status, payload, "Could not sign in.");
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const { status, payload, shape } = await this.call("POST", "/auth/v1/token?grant_type=refresh_token", {
      body: { refresh_token: refreshToken }
    });
    if (status === 200) {
      return this.session(payload, shape);
    }
    if (status >= 400 && status < 500 && status !== 429) {
      throw new AuthError(401, EXPIRED);
    }
    throw this.refusal(status, payload, EXPIRED);
  }

  async signOut(accessToken: string): Promise<void> {
    const { status, payload } = await this.call("POST", "/auth/v1/logout", { accessToken });
    // 401/403/404: the session is already gone - which is what was asked for.
    if (status >= 500 || status === 429) {
      throw this.refusal(status, payload, "Could not sign out.");
    }
  }

  async getUser(accessToken: string): Promise<AuthUser> {
    const { status, payload, shape } = await this.call("GET", "/auth/v1/user", { accessToken });
    if (status === 200) {
      const user = toUser(payload);
      if (!user) {
        throw new AuthError(502, "The sign-in service sent a malformed user.", this.diagnose(shape, userFindings(payload)));
      }
      return user;
    }
    if (status >= 400 && status < 500 && status !== 429) {
      throw new AuthError(401, EXPIRED);
    }
    throw this.refusal(status, payload, EXPIRED);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; accessToken?: string }
  ): Promise<{ status: number; payload: unknown; shape: UpstreamShape }> {
    try {
      return await supabaseRequest(this.config, method, path, options);
    } catch (error) {
      if (error instanceof SupabaseUnavailableError) {
        throw new AuthError(502, "Could not reach the sign-in service - try again shortly.");
      }
      throw error;
    }
  }

  /** The log diagnostic for an unusable 200: what answered, which fields it had, and the failure category - see AuthFailureCategory. */
  private diagnose(shape: UpstreamShape, findings: { fields: string; category: AuthFailureCategory }): string {
    const category = shape.body === "not-json" ? "not-supabase-auth" : findings.category;
    return `${describeUpstream(this.config, shape)}; fields: ${findings.fields}; category: ${category}`;
  }

  private session(payload: unknown, shape: UpstreamShape): AuthSession {
    if (
      !isPlainObject(payload) ||
      typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string" ||
      !toUser(payload.user)
    ) {
      throw new AuthError(502, "The sign-in service sent a malformed session.", this.diagnose(shape, sessionFindings(payload)));
    }
    const expiresAt =
      typeof payload.expires_at === "number"
        ? payload.expires_at * 1000
        : this.now() + (typeof payload.expires_in === "number" ? payload.expires_in : 3600) * 1000;
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt,
      user: toUser(payload.user) as AuthUser
    };
  }

  private refusal(status: number, payload: unknown, fallback: string): AuthError {
    const text = supabaseMessage(payload) ?? fallback;
    const code = supabaseErrorCode(payload);
    if (status === 429) {
      return new AuthError(429, "Too many attempts - wait a minute and try again.");
    }
    if (status >= 500) {
      return new AuthError(502, "The sign-in service is unavailable - try again shortly.");
    }
    if (code === "user_already_exists" || code === "email_exists" || /already (registered|exists)/i.test(text)) {
      return new AuthError(409, "An account with this email already exists - sign in instead.");
    }
    if (code === "invalid_credentials" || /invalid login credentials/i.test(text)) {
      return new AuthError(401, "Wrong email or password.");
    }
    if (code === "email_not_confirmed" || /email not confirmed/i.test(text)) {
      return new AuthError(401, "Confirm your email address first - check your inbox for the link.");
    }
    if (code === "weak_password") {
      return new AuthError(400, text);
    }
    return new AuthError(status === 401 || status === 403 ? 401 : 400, text);
  }
}
