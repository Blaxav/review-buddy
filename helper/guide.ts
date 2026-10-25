import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { linesToReview, prKey, type GuideEvent, type PrRef, type ReviewBlock, type Triage } from "../shared/protocol";
import { mapClaudeLine } from "./claude-events";
import { HOME_DIR } from "./config";
import { run, type Checkout } from "./github";
import { GUIDE_SCHEMA, guidePrompt } from "./prompt";
import { ALLOWED_TOOLS, getLatestCheckout } from "./session";
import { classify, isLockfile, parseChanges, type RawChange } from "./triage";

const GUIDES_DIR = join(HOME_DIR, "guides");

type Triaged = { triage: Triage; raw: RawChange[] };

// One guided review per PR head, shared by every tab that asks for it. Claude's
// grouping takes minutes, so it keeps running when the overlay closes, and its
// result is saved for the next time the PR is opened.
type Job = {
  triaged: Promise<Triaged>;
  blocks: Promise<ReviewBlock[]>;
  listeners: Set<(event: GuideEvent) => void>;
};

const jobs = new Map<string, Job>();

export async function streamGuide(pr: PrRef, regroup: boolean, send: (event: GuideEvent) => void): Promise<void> {
  send({ type: "status", message: "Preparing checkout…" });
  const checkout = await getLatestCheckout(pr);
  const key = `${prKey(pr)}@${checkout.info.headRefOid}`;
  const file = join(GUIDES_DIR, pr.owner, pr.repo, String(pr.number), `${checkout.info.headRefOid}.json`);
  if (regroup) {
    jobs.delete(key);
    rmSync(file, { force: true });
  }
  let job = jobs.get(key);
  if (!job) {
    job = startJob(pr, checkout, file);
    jobs.set(key, job);
    job.blocks.catch(() => jobs.delete(key));
  }
  send({ type: "status", message: "Sorting out moves, renames and whitespace…" });
  const { triage } = await job.triaged;
  send({ type: "triage", triage });
  const count = triage.changes.filter((change) => linesToReview(change) > 0).length;
  send({ type: "status", message: `Claude is grouping ${count} change${count === 1 ? "" : "s"} into blocks…` });
  job.listeners.add(send);
  try {
    send({ type: "blocks", blocks: await job.blocks });
  } finally {
    job.listeners.delete(send);
  }
}

function startJob(pr: PrRef, checkout: Checkout, file: string): Job {
  const listeners = new Set<(event: GuideEvent) => void>();
  const saved = readSaved(file);
  if (saved) {
    return { triaged: Promise.resolve({ triage: saved.triage, raw: [] }), blocks: Promise.resolve(saved.blocks), listeners };
  }
  const triaged = triagePr(checkout);
  const blocks = triaged.then(async ({ triage, raw }) => {
    const emit = (event: GuideEvent) => listeners.forEach((listener) => listener(event));
    const blocks = await groupChanges(pr, checkout, triage, raw, emit);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ triage, blocks }));
    return blocks;
  });
  return { triaged, blocks, listeners };
}

function readSaved(file: string): { triage: Triage; blocks: ReviewBlock[] } | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// --- Triage -------------------------------------------------------------------

export async function triagePr({ dir, mergeBase, info }: Checkout): Promise<Triaged> {
  const diff = await run(
    ["git", "-c", "core.quotePath=false", "diff", "-M", "--unified=0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", mergeBase, "HEAD"],
    dir,
  );
  const raw = parseChanges(diff);
  const generated = await generatedPaths(dir, [...new Set(raw.map((c) => c.path))]);
  const changedOld = new Set(raw.map((c) => c.oldPath));
  const changedNew = new Set(raw.map((c) => c.path));
  const { changes, renames } = await classify(
    raw,
    (path) => generated.has(path) || isLockfile(path),
    (names, at) => (at === "head" ? namesAtHead(dir, names) : namesAtBase(dir, mergeBase, names, changedOld, changedNew)),
  );
  const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(path).digest("hex");
  return {
    triage: {
      headSha: info.headRefOid,
      changes: changes.map((change, i) => ({ id: `c${i + 1}`, fileHash: sha256(change.path), ...change })),
      renames,
    },
    raw,
  };
}

// Files the repository's .gitattributes marks as generated, as GitHub does.
async function generatedPaths(dir: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const out = await run(["git", "check-attr", "-z", "--stdin", "linguist-generated"], dir, { input: paths.join("\0") + "\0" });
  const fields = out.split("\0");
  const generated = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === "set" || fields[i + 2] === "true") generated.add(fields[i]!);
  }
  return generated;
}

// grep the worktree, which holds the head: the clone is blobless, so grepping
// another tree would download every file of it.
async function namesAtHead(dir: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const out = await run(["git", "grep", "-o", "-h", "-w", "-F", "-I", "-f", "-", "--"], dir, { input: names.join("\n") + "\n", okCodes: [0, 1] });
  return new Set(out.split("\n").filter(Boolean));
}

// A file the PR doesn't change is the same at the base as in the worktree; the
// base versions of the files it changes were fetched for the diff.
async function namesAtBase(dir: string, mergeBase: string, names: string[], changedOld: Set<string>, changedNew: Set<string>): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const input = names.join("\n") + "\n";
  const found = new Set<string>();
  const unchanged = await run(["git", "grep", "-o", "-w", "-F", "-I", "-f", "-", "--"], dir, { input, okCodes: [0, 1] });
  for (const line of unchanged.split("\n")) {
    const colon = line.lastIndexOf(":");
    if (colon > 0 && !changedNew.has(line.slice(0, colon))) found.add(line.slice(colon + 1));
  }
  const changed = await run(
    ["git", "--literal-pathspecs", "grep", "-o", "-h", "-w", "-F", "-I", "-f", "-", mergeBase, "--", ...changedOld],
    dir,
    { input, okCodes: [0, 1] },
  );
  for (const name of changed.split("\n")) if (name) found.add(name);
  return found;
}

// --- Grouping -----------------------------------------------------------------

async function groupChanges(pr: PrRef, checkout: Checkout, triage: Triage, raw: RawChange[], emit: (event: GuideEvent) => void): Promise<ReviewBlock[]> {
  if (!triage.changes.some((change) => linesToReview(change) > 0)) return [];
  const proc = Bun.spawn(
    [
      "claude", "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--allowedTools", ...ALLOWED_TOOLS,
      "--json-schema", JSON.stringify(GUIDE_SCHEMA),
    ],
    { cwd: checkout.dir, stdin: new TextEncoder().encode(guidePrompt(pr, checkout, triage, raw)), stdout: "pipe", stderr: "inherit" },
  );
  let output: unknown;
  let failure: string | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let json: { type?: string; is_error?: boolean; result?: string; structured_output?: unknown };
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      if (json.type === "result") {
        if (json.is_error) failure = json.result ?? "Claude failed";
        else output = json.structured_output;
        continue;
      }
      for (const event of mapClaudeLine(json)) {
        if (event.type === "tool" || event.type === "status") emit(event);
      }
    }
  }
  const code = await proc.exited;
  if (failure) throw new Error(failure);
  if (output === undefined) throw new Error(`Claude exited (code ${code}) without grouping the changes`);
  return assembleBlocks(output, triage);
}

// Keeps Claude's blocks honest: only changes with lines left to review, each in
// one block; whatever Claude left out goes to a last block, so nothing is hidden.
export function assembleBlocks(output: unknown, triage: Triage): ReviewBlock[] {
  const toReview = new Set(triage.changes.filter((change) => linesToReview(change) > 0).map((change) => change.id));
  const assigned = new Set<string>();
  const blocks: ReviewBlock[] = [];
  const list = (output as { blocks?: unknown })?.blocks;
  for (const item of Array.isArray(list) ? list : []) {
    const block = (item ?? {}) as Record<string, unknown>;
    const changes = strings(block.changes).filter((id) => toReview.has(id) && !assigned.has(id));
    if (changes.length === 0) continue;
    for (const id of changes) assigned.add(id);
    const outside = Array.isArray(block.outside_intent) ? block.outside_intent : [];
    blocks.push({
      id: `b${blocks.length + 1}`,
      title: text(block.title) || "Untitled block",
      intent: text(block.intent),
      changes,
      checks: strings(block.checks),
      outsideIntent: outside.flatMap((entry) => {
        const { change, note } = (entry ?? {}) as Record<string, unknown>;
        return typeof change === "string" && changes.includes(change) && text(note) ? [{ change, note: text(note) }] : [];
      }),
    });
  }
  const left = [...toReview].filter((id) => !assigned.has(id));
  if (left.length > 0) {
    blocks.push({
      id: `b${blocks.length + 1}`,
      title: "Changes left out of the blocks",
      intent: "Claude didn't place these changes in a block. Review them on their own.",
      changes: left,
      checks: [],
      outsideIntent: [],
    });
  }
  return blocks;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
}
