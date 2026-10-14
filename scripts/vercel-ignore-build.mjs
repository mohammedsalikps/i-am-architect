// Vercel's "Ignored Build Step" (vercel.json `ignoreCommand`): exit 0 skips
// this frontend build, exit 1 builds it.
//
// A commit whose message contains "[backend-first]" is released to the
// backend (Render, which deploys every commit on master) and NOT to the
// frontend: the frontend follows with the next commit, once the backend's
// GET /health reports that commit in its X-Release header. This is how a
// release that adds a field to saved projects (a newer frontend's documents
// would be refused by an older backend) goes out backend first - see
// DEPLOYMENT.md "Release order".
//
// Fails open: without a commit message to read, the build goes ahead.
import { execSync } from "node:child_process";

const MARKER = "[backend-first]";

function commitMessage() {
  if (process.env.VERCEL_GIT_COMMIT_MESSAGE) return process.env.VERCEL_GIT_COMMIT_MESSAGE;
  try {
    return execSync("git log -1 --pretty=%B", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

if (commitMessage().includes(MARKER)) {
  console.log(`Skipping the frontend build: a ${MARKER} release deploys the backend first (DEPLOYMENT.md "Release order").`);
  process.exit(0);
}
console.log("Building the frontend.");
process.exit(1);
