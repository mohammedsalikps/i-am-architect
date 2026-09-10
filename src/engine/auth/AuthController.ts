// Explicit .ts extension on this value import lets Node run this file
// directly (the verify suites do). Harmless for Vite.
import { AuthRequestError, credentialsProblem, parseSession } from "./types.ts";
import type { AuthClient, AuthSession, AuthUser } from "./types";

export type AuthStatus = "restoring" | "signed-out" | "working" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  /** The signed-in user, or null. */
  user: AuthUser | null;
  /** A one-line outcome for the UI ("Wrong email or password.", "Your session expired - sign in again."), or null. */
  message: string | null;
}

export type AuthListener = (state: AuthState) => void;

/** Where the session is kept between page loads - window.localStorage in the app, a Map in tests. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthControllerOptions {
  client: AuthClient;
  storage: SessionStorageLike;
  /** Defaults to Date.now. */
  now?: () => number;
}

export const SESSION_STORAGE_KEY = "iarchitect.session";
/** Refresh the access token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;
const EXPIRED = "Your session expired - sign in again.";

/**
 * The browser's authentication state - DOM-free, like every other
 * controller the UI renders. It:
 *
 * - keeps the session (the user's own access and refresh tokens - never a
 *   provider key) in the injected storage, so a reload stays signed in;
 * - on start(), checks a stored session with the server (/api/auth/session)
 *   and refreshes it if it has expired; a session the server no longer
 *   accepts is dropped;
 * - wraps a transport with authorize(): every request carries
 *   "Authorization: Bearer <token>", the token is refreshed shortly before
 *   it expires, and a 401 triggers ONE refresh and retry - if that fails
 *   too, the user is signed out with "Your session expired".
 *
 * The server checks the token on every request; nothing here is a
 * security boundary by itself.
 */
export class AuthController {
  private state: AuthState = { status: "restoring", user: null, message: null };
  private session: AuthSession | null = null;
  private refreshing: Promise<AuthSession | null> | null = null;
  private readonly listeners = new Set<AuthListener>();
  private readonly client: AuthClient;
  private readonly storage: SessionStorageLike;
  private readonly now: () => number;

  constructor(options: AuthControllerOptions) {
    this.client = options.client;
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
  }

  getState(): AuthState {
    return this.state;
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  isSignedIn(): boolean {
    return this.state.status === "signed-in" && this.session !== null;
  }

  /** Restores the stored session, if any, and confirms it with the server. */
  async start(): Promise<void> {
    const stored = this.readStored();
    if (!stored) {
      this.setState({ status: "signed-out", user: null, message: null });
      return;
    }
    this.session = stored;
    this.setState({ status: "restoring", user: stored.user, message: null });

    const token = await this.accessToken();
    if (!token) {
      return; // the refresh failed - already signed out
    }
    try {
      const user = await this.client.getUser(token);
      this.setState({ status: "signed-in", user, message: null });
    } catch (error) {
      if (error instanceof AuthRequestError && error.status === 401) {
        const refreshed = await this.refreshNow();
        if (refreshed) {
          this.setState({ status: "signed-in", user: refreshed.user, message: null });
        }
        return;
      }
      // The server couldn't be reached - keep the session; every request
      // is checked by the server anyway.
      this.setState({ status: "signed-in", user: stored.user, message: "Couldn't reach the server to confirm your session." });
    }
  }

  async signIn(email: string, password: string): Promise<boolean> {
    // Signing in starts over: whatever session was here before is dropped.
    this.clear();
    const problem = credentialsProblem(email, password);
    if (problem) {
      this.setState({ status: "signed-out", user: null, message: problem });
      return false;
    }
    this.setState({ status: "working", user: null, message: "Signing in…" });
    try {
      this.adopt(await this.client.signIn(email.trim(), password));
      return true;
    } catch (error) {
      this.setState({ status: "signed-out", user: null, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  async signUp(email: string, password: string): Promise<boolean> {
    this.clear();
    const problem = credentialsProblem(email, password);
    if (problem) {
      this.setState({ status: "signed-out", user: null, message: problem });
      return false;
    }
    this.setState({ status: "working", user: null, message: "Creating your account…" });
    try {
      const result = await this.client.signUp(email.trim(), password);
      if ("session" in result) {
        this.adopt(result.session);
        return true;
      }
      this.setState({ status: "signed-out", user: null, message: `Check ${result.email} to confirm your account, then sign in.` });
      return false;
    } catch (error) {
      this.setState({ status: "signed-out", user: null, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /** Signs out here, and - best effort - on the server. Always ends signed out. */
  async signOut(): Promise<void> {
    const token = this.session?.accessToken;
    this.clear();
    this.setState({ status: "signed-out", user: null, message: "Signed out." });
    if (token) {
      try {
        await this.client.signOut(token);
      } catch {
        // Already signed out locally; the token expires on its own.
      }
    }
  }

  /** A current access token - refreshed first when it's about to expire - or null when signed out. */
  async accessToken(): Promise<string | null> {
    const session = this.session;
    if (!session) {
      return null;
    }
    if (session.expiresAt - this.now() > REFRESH_MARGIN_MS) {
      return session.accessToken;
    }
    return (await this.refreshNow())?.accessToken ?? null;
  }

  /**
   * Wraps a transport so every request carries the session's token. A 401
   * refreshes the session once and retries; a request made while signed
   * out goes without a token (and the server answers 401).
   */
  authorize<I extends { headers: Record<string, string> }, R extends { status: number }>(
    send: (url: string, init: I) => Promise<R>
  ): (url: string, init: I) => Promise<R> {
    const withToken = (init: I, token: string | null): I =>
      token ? { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } } : init;
    return async (url, init) => {
      const token = await this.accessToken();
      const response = await send(url, withToken(init, token));
      if (response.status !== 401 || !token) {
        return response;
      }
      const refreshed = await this.refreshNow();
      return refreshed ? send(url, withToken(init, refreshed.accessToken)) : response;
    };
  }

  /** One refresh at a time. On failure the user is signed out with "Your session expired". */
  private refreshNow(): Promise<AuthSession | null> {
    if (this.refreshing) {
      return this.refreshing;
    }
    const session = this.session;
    if (!session) {
      return Promise.resolve(null);
    }
    this.refreshing = (async () => {
      try {
        const next = await this.client.refresh(session.refreshToken);
        this.adopt(next);
        return next;
      } catch {
        this.clear();
        this.setState({ status: "signed-out", user: null, message: EXPIRED });
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private adopt(session: AuthSession): void {
    this.session = session;
    try {
      this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Storage unavailable (private mode): signed in for this page only.
    }
    this.setState({ status: "signed-in", user: session.user, message: null });
  }

  private clear(): void {
    this.session = null;
    try {
      this.storage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Nothing stored.
    }
  }

  private readStored(): AuthSession | null {
    try {
      const raw = this.storage.getItem(SESSION_STORAGE_KEY);
      return raw ? parseSession(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private setState(next: AuthState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
