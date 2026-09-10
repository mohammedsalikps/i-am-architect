import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { AuthError } from "./AuthService.ts";
import type { AuthService, AuthSession, AuthUser, SignUpOutcome } from "./AuthService.ts";

export interface InMemoryAuthServiceOptions {
  /** Defaults to Date.now. Tests inject a clock to expire sessions. */
  now?: () => number;
  /** How long an access token lasts. Defaults to one hour, like Supabase. */
  accessTokenTtlMs?: number;
}

interface Account {
  user: AuthUser;
  salt: Buffer;
  hash: Buffer;
}

interface IssuedToken {
  userId: string;
  sessionId: string;
  expiresAt: number;
}

const HASH_BYTES = 64;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const EXPIRED = "Your session expired - sign in again.";
// Hashed against when an email has no account, so a wrong email takes as
// long to refuse as a wrong password.
const DECOY_SALT = randomBytes(16);

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Accounts kept in this process's memory - for local development
 * (LOCAL_AUTH=memory, npm run mock) and every test. Not a stand-in for
 * production: accounts vanish when the process stops.
 *
 * It still behaves like real authentication at its boundary: passwords are
 * stored only as salted scrypt hashes and compared in constant time, tokens
 * are random and opaque, access tokens expire, refresh tokens work once
 * (rotation), and signing out ends the session.
 */
export class InMemoryAuthService implements AuthService {
  private readonly accountsByEmail = new Map<string, Account>();
  private readonly usersById = new Map<string, AuthUser>();
  private readonly accessTokens = new Map<string, IssuedToken>();
  private readonly refreshTokens = new Map<string, IssuedToken>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: InMemoryAuthServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.accessTokenTtlMs ?? DEFAULT_TTL_MS;
  }

  async signUp(email: string, password: string): Promise<SignUpOutcome> {
    const key = normalizeEmail(email);
    if (this.accountsByEmail.has(key)) {
      throw new AuthError(409, "An account with this email already exists - sign in instead.");
    }
    const salt = randomBytes(16);
    const user: AuthUser = { id: randomUUID(), email: key };
    this.accountsByEmail.set(key, { user, salt, hash: scryptSync(password, salt, HASH_BYTES) });
    this.usersById.set(user.id, user);
    return { session: this.issue(user, randomUUID()) };
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const account = this.accountsByEmail.get(normalizeEmail(email));
    const hash = scryptSync(password, account?.salt ?? DECOY_SALT, HASH_BYTES);
    if (!account || !timingSafeEqual(hash, account.hash)) {
      throw new AuthError(401, "Wrong email or password.");
    }
    return this.issue(account.user, randomUUID());
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const issued = this.refreshTokens.get(refreshToken);
    const user = issued ? this.usersById.get(issued.userId) : undefined;
    if (!issued || !user) {
      throw new AuthError(401, EXPIRED);
    }
    // Rotation: a refresh token works once. The session continues.
    this.refreshTokens.delete(refreshToken);
    return this.issue(user, issued.sessionId);
  }

  async signOut(accessToken: string): Promise<void> {
    const issued = this.accessTokens.get(accessToken);
    if (!issued) {
      return;
    }
    for (const tokens of [this.accessTokens, this.refreshTokens]) {
      for (const [token, entry] of tokens) {
        if (entry.sessionId === issued.sessionId) {
          tokens.delete(token);
        }
      }
    }
  }

  async getUser(accessToken: string): Promise<AuthUser> {
    const issued = this.accessTokens.get(accessToken);
    const user = issued && issued.expiresAt > this.now() ? this.usersById.get(issued.userId) : undefined;
    if (!user) {
      throw new AuthError(401, EXPIRED);
    }
    return { ...user };
  }

  private issue(user: AuthUser, sessionId: string): AuthSession {
    const expiresAt = this.now() + this.ttlMs;
    const accessToken = newToken();
    const refreshToken = newToken();
    this.accessTokens.set(accessToken, { userId: user.id, sessionId, expiresAt });
    this.refreshTokens.set(refreshToken, { userId: user.id, sessionId, expiresAt: Number.POSITIVE_INFINITY });
    return { accessToken, refreshToken, expiresAt, user: { ...user } };
  }
}
