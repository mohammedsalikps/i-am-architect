/**
 * Authentication, as the browser sees it. The browser only ever talks to
 * the app's own backend (backend/src/createServer.ts's /api/auth routes);
 * the backend talks to the identity provider (Supabase Auth, or an
 * in-memory stand-in for local development). No provider key or secret is
 * ever in the browser - only the signed-in user's own session tokens.
 */

export interface AuthUser {
  id: string;
  email: string;
}

/** A signed-in session. `expiresAt` is when the access token expires, in ms since the epoch. */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
}

export type SignUpResult = { session: AuthSession } | { confirmationRequired: true; email: string };

/** The backend's /api/auth routes - see HttpAuthClient. */
export interface AuthClient {
  signUp(email: string, password: string): Promise<SignUpResult>;
  signIn(email: string, password: string): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  signOut(accessToken: string): Promise<void>;
  /** Who the access token belongs to - rejects with a 401 AuthRequestError when it's invalid or expired. */
  getUser(accessToken: string): Promise<AuthUser>;
}

/** An auth request the server refused (`status` 400/401/409...), or couldn't be made (`status` 0). */
export class AuthRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthRequestError";
    this.status = status;
  }
}

/** Minimum password length - the backend enforces the same. */
export const MIN_PASSWORD_LENGTH = 8;
/** Supabase Auth hashes passwords with bcrypt, which ignores everything past 72 bytes - so longer ones are refused. */
export const MAX_PASSWORD_BYTES = 72;
const MAX_EMAIL_LENGTH = 254;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A reason the credentials can't be sent, or null when they look usable. The backend runs the same check. */
export function credentialsProblem(email: string, password: string): string | null {
  const trimmed = email.trim();
  if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL.test(trimmed)) {
    return "Enter a valid email address.";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return `Use a shorter password (at most ${MAX_PASSWORD_BYTES} characters).`;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A session, checked field by field - from the server, or from storage. Null when it isn't one. */
export function parseSession(value: unknown): AuthSession | null {
  if (!isPlainObject(value) || !isPlainObject(value.user)) {
    return null;
  }
  const { accessToken, refreshToken, expiresAt, user } = value as Record<string, unknown> & { user: Record<string, unknown> };
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    typeof user.id !== "string" ||
    typeof user.email !== "string"
  ) {
    return null;
  }
  return { accessToken, refreshToken, expiresAt, user: { id: user.id, email: user.email } };
}
