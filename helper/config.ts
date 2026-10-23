import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_DIR = join(homedir(), ".review-ai");
export const REPOS_DIR = join(HOME_DIR, "repos");
export const WORKTREES_DIR = join(HOME_DIR, "worktrees");
const TOKEN_FILE = join(HOME_DIR, "token");

// Any web page can send requests to localhost, so every request must carry
// this token, which only the extension knows.
export function loadToken(): string {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    mkdirSync(HOME_DIR, { recursive: true });
    const token = crypto.randomUUID() + crypto.randomUUID();
    writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
    return token;
  }
}
