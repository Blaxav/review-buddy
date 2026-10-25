import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DraftComment, LineSelection, PrRef, ThreadInfo } from "../shared/protocol";
import { REPOS_DIR, WORKTREES_DIR } from "./config";
import { parseDiffRows, parseNameStatus, selectRows } from "./diff";

export type PrInfo = {
  title: string;
  body: string;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
};

// `mergeBase` is the commit GitHub diffs the PR head against.
export type Checkout = { dir: string; info: PrInfo; mergeBase: string };

// `okCodes` lists the exit codes that aren't failures, such as 1 for a grep that finds nothing.
export async function run(cmd: string[], cwd?: string, { input, okCodes = [0] }: { input?: string; okCodes?: number[] } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (!okCodes.includes(code)) {
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
  const mergeBase = (await run(["git", "merge-base", info.baseRefOid, info.headRefOid], dir)).trim();
  return { dir, info, mergeBase };
}

// Finds the file GitHub's anchor names and the diff rows of the selection.
export async function fetchThread({ dir, mergeBase }: Checkout, selection: LineSelection): Promise<ThreadInfo> {
  const changed = parseNameStatus(await run(["git", "diff", "--name-status", "-z", "-M", mergeBase, "HEAD"], dir));
  const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(path).digest("hex");
  const file = changed.find((f) => sha256(f.newPath) === selection.fileHash || sha256(f.oldPath) === selection.fileHash);
  if (!file) throw new Error("The selected lines aren't in a file this PR changes.");
  const diff = await run(["git", "diff", "-M", "--unified=1000000", mergeBase, "HEAD", "--", file.oldPath, file.newPath], dir);
  const rows = selectRows(parseDiffRows(diff), selection);
  if (rows.length === 0) throw new Error(`Couldn't find the selected lines in ${file.newPath}.`);
  return { path: file.newPath, rows };
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
    args.push("-F", `start_line=${comment.startLine}`, "-f", `start_side=${comment.startSide ?? comment.side}`);
  }
  const created = JSON.parse(await run(args)) as { html_url: string };
  return created.html_url;
}
