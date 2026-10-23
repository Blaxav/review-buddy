import type { PrRef } from "../../shared/protocol";

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

export function parsePrPath(pathname: string): PrRef | null {
  const match = PR_PATH.exec(pathname);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}
