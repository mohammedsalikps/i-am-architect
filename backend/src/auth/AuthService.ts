import { credentialsProblem } from "../../../src/engine/auth/types.ts";
import type { AuthSession, AuthUser } from "../../../src/engine/auth/types.ts";

export type { AuthSession, AuthUser } from "../../../src/engine/auth/types.ts";

/**
 * Identity, as this server sees it. createServer() only ever talks to this
 * interface, so it doesn't know (or care) who actually keeps the accounts:
 *
 * - SupabaseAuthService - Supabase Auth, over its REST API, with the
 *   project's anon (public) key. Never a service-role key.
 * - InMemoryAuthService - accounts in this process's memory, for local
 *   development (LOCAL_AUTH=memory, npm run mock) and every test.
 *
 * Sessions are the same shape the browser keeps (src/engine/auth/types.ts):
 * the user's own access and refresh tokens, and when the access token
 * expires.
 */

export type SignUpOutcome = { session: AuthSession } | { confirmationRequired: true; email: string };

export interface AuthService {
  /** Creates an account. Either signs the user straight in, or (Supabase with email confirmation on) asks them to confirm first. */
  signUp(email: string, password: string): Promise<SignUpOutcome>;
  signIn(email: string, password: string): Promise<AuthSession>;
  /** Trades a refresh token for a new session. Throws AuthError(401) when the refresh token is no longer valid. */
  refresh(refreshToken: string): Promise<AuthSession>;
  /** Ends the session this access token belongs to. */
  signOut(accessToken: string): Promise<void>;
  /** The user this access token belongs to. Throws AuthError(401) when it is invalid or expired. */
  getUser(accessToken: string): Promise<AuthUser>;
}

/**
 * A refused auth request, with the HTTP status to answer it with: 400 (bad
 * input), 401 (wrong credentials, expired session), 409 (account exists),
 * 429 (rate limited), 502 (the identity provider failed). The message is
 * shown to the user as-is, so it never carries a token or a key.
 */
export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export type ParsedCredentials = { ok: true; email: string; password: string } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a `{ email, password }` request body - the same rules the browser checks before sending. The email is trimmed and lower-cased. */
export function parseCredentials(body: unknown): ParsedCredentials {
  if (!isPlainObject(body) || typeof body.email !== "string" || typeof body.password !== "string") {
    return { ok: false, error: 'Expected an "email" and a "password".' };
  }
  const problem = credentialsProblem(body.email, body.password);
  if (problem) {
    return { ok: false, error: problem };
  }
  return { ok: true, email: body.email.trim().toLowerCase(), password: body.password };
}
