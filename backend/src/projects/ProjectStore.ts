import type { ProjectRepository } from "../../../src/engine/project/ProjectRepository.ts";
import type { AuthUser } from "../auth/AuthService.ts";

/**
 * Hands out ONE signed-in user's ProjectRepository, per request. The user
 * has already been checked against the AuthService by createServer(); the
 * repository it returns can only ever reach that user's projects.
 *
 * - InMemoryProjectStore (src/engine/project/InMemoryProjectRepository.ts)
 *   filters one shared in-memory map by owner.
 * - SupabaseProjectStore (./SupabaseProjectRepository.ts) sends the user's
 *   own access token to Supabase, where Row Level Security enforces
 *   ownership in the database itself.
 */
export interface ProjectStore {
  forUser(user: AuthUser, accessToken: string): ProjectRepository;
}

/**
 * The database couldn't be reached (no response, or a gateway error) -
 * nothing was stored or read. createServer() answers 503 with this
 * message, so the browser can say "try again" rather than "failed".
 */
export class ProjectStorageUnavailableError extends Error {
  constructor(message = "Project storage is temporarily unavailable - try again shortly.") {
    super(message);
    this.name = "ProjectStorageUnavailableError";
  }
}
