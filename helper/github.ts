import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DraftComment, PrRef } from "../shared/protocol";
import { REPOS_DIR, WORKTREES_DIR } from "./config";

export type PrInfo = {
  title: string;
  body: string;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
};

export type Checkout = { dir: string; info: PrInfo };

async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

export async function fetchPrInfo(pr: PrRef): Promise<PrInfo> {
  const json = await run([
    "gh", "pr", "view", String(pr.number),
    "--repo", `${pr.owner}/${pr.repo}`,
    "--json", "title,body,baseRefName,baseRefOid,headRefOid",
  ]);
  return JSON.parse(json) as PrInfo;
}

// Checks the PR head out in its own worktree, so several PRs can be open at once.
export async function checkoutPr(pr: PrRef): Promise<Checkout> {
  const info = await fetchPrInfo(pr);
  const repoDir = join(REPOS_DIR, pr.owner, pr.repo);
  if (!existsSync(repoDir)) {
    mkdirSync(dirname(repoDir), { recursive: true });
    await run(["gh", "repo", "clone", `${pr.owner}/${pr.repo}`, repoDir, "--", "--filter=blob:none", "--no-checkout"]);
  }
  await run([
    "git", "fetch", "--quiet", "origin",
    `+refs/pull/${pr.number}/head:refs/review-ai/pr-${pr.number}`,
    `+refs/heads/${info.baseRefName}:refs/review-ai/base-${pr.number}`,
  ], repoDir);

  const dir = join(WORKTREES_DIR, pr.owner, pr.repo, `pr-${pr.number}`);
  if (existsSync(dir)) {
    await run(["git", "checkout", "--quiet", "--detach", info.headRefOid], dir);
  } else {
    mkdirSync(dirname(dir), { recursive: true });
    await run(["git", "worktree", "add", "--quiet", "--detach", dir, info.headRefOid], repoDir);
  }
  return { dir, info };
}

export async function postComment(pr: PrRef, commitId: string, comment: DraftComment): Promise<string> {
  const args = [
    "gh", "api", "--method", "POST", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`,
    "-f", `body=${comment.body}`,
    "-f", `commit_id=${commitId}`,
    "-f", `path=${comment.path}`,
    "-F", `line=${comment.line}`,
    "-f", `side=${comment.side}`,
  ];
  if (comment.startLine !== undefined) {
    args.push("-F", `start_line=${comment.startLine}`, "-f", `start_side=${comment.side}`);
  }
  const created = JSON.parse(await run(args)) as { html_url: string };
  return created.html_url;
}
