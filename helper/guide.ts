import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  linesToReview,
  prKey,
  type FocusPoint,
  type GuideEvent,
  type PrRef,
  type ReviewBlock,
  type ReviewGuide,
  type ReviewStep,
  type Triage,
} from "../shared/protocol";
import { mapClaudeLine } from "./claude-events";
import { HOME_DIR } from "./config";
import { run, type Checkout } from "./github";
import { GUIDE_SCHEMA, guidePrompt } from "./prompt";
import { ALLOWED_TOOLS, getLatestCheckout } from "./session";
import { classify, isImportsOnly, isLockfile, parseChanges, type RawChange } from "./triage";

// Versioned: a saved guide in an older shape is grouped again.
const GUIDES_DIR = join(HOME_DIR, "guides", "v3");

// The places the briefing asks the reviewer to read closely, at most.
const MAX_FOCUS = 3;

type Triaged = { triage: Triage; raw: RawChange[] };

// One smart review per PR head, shared by every tab that asks for it. Claude's
// grouping takes minutes, so it keeps running when the overlay closes, and its
// result is saved for the next time the PR is opened.
type Job = {
  triaged: Promise<Triaged>;
  guide: Promise<ReviewGuide>;
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
    job.guide.catch(() => jobs.delete(key));
  }
  send({ type: "status", message: "Sorting out moves, renames and whitespace…" });
  const { triage } = await job.triaged;
  send({ type: "triage", triage });
  const count = triage.changes.filter((change) => linesToReview(change) > 0).length;
  send({ type: "status", message: `Claude is grouping ${count} change${count === 1 ? "" : "s"} into blocks…` });
  job.listeners.add(send);
  try {
    send({ type: "guide", guide: await job.guide });
  } finally {
    job.listeners.delete(send);
  }
}

function startJob(pr: PrRef, checkout: Checkout, file: string): Job {
  const listeners = new Set<(event: GuideEvent) => void>();
  const saved = readSaved(file);
  if (saved) {
    return { triaged: Promise.resolve({ triage: saved.triage, raw: [] }), guide: Promise.resolve(saved.guide), listeners };
  }
  const triaged = triagePr(checkout);
  const guide = triaged.then(async ({ triage, raw }) => {
    const emit = (event: GuideEvent) => listeners.forEach((listener) => listener(event));
    const guide = await groupChanges(pr, checkout, triage, raw, emit);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ triage, guide }));
    return guide;
  });
  return { triaged, guide, listeners };
}

function readSaved(file: string): { triage: Triage; guide: ReviewGuide } | null {
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
  const files = new Map<string, Promise<string[]>>();
  const fileLines = (at: "base" | "head", path: string) => {
    const key = `${at}:${path}`;
    if (!files.has(key)) {
      const text = at === "head" ? Bun.file(join(dir, path)).text() : run(["git", "show", `${mergeBase}:${path}`], dir);
      files.set(key, text.then((t) => t.split("\n"), () => []));
    }
    return files.get(key)!;
  };
  const importsOnly = await Promise.all(changes.map((change, i) => isImportsOnly(raw[i]!, change.proven, fileLines)));
  const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(path).digest("hex");
  return {
    triage: {
      headSha: info.headRefOid,
      changes: changes.map((change, i) => ({ id: `c${i + 1}`, fileHash: sha256(change.path), ...change, importsOnly: importsOnly[i]! })),
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

async function groupChanges(pr: PrRef, checkout: Checkout, triage: Triage, raw: RawChange[], emit: (event: GuideEvent) => void): Promise<ReviewGuide> {
  if (!triage.changes.some((change) => linesToReview(change) > 0)) return { summary: "", focus: [], blocks: [] };
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
  return assembleGuide(output, triage);
}

// Keeps Claude's walk honest: only changes with lines left to review, each in
// one step, and each step scrolling to a change it holds that isn't only
// imports. An import change Claude left out joins a step in its file; any
// other goes to a last block, so nothing is hidden.
export function assembleGuide(output: unknown, triage: Triage): ReviewGuide {
  const changes = new Map(triage.changes.map((change) => [change.id, change]));
  const toReview = new Set(triage.changes.filter((change) => linesToReview(change) > 0).map((change) => change.id));
  const assigned = new Set<string>();
  const wanted = new Map<ReviewStep, string>();
  const result = (output ?? {}) as Record<string, unknown>;
  const blocks: ReviewBlock[] = [];
  for (const item of list(result.blocks)) {
    const block = (item ?? {}) as Record<string, unknown>;
    const steps = list(block.steps).flatMap((entry): ReviewStep[] => {
      const step = (entry ?? {}) as Record<string, unknown>;
      const ids = strings(step.changes).filter((id) => toReview.has(id) && !assigned.has(id));
      if (ids.length === 0) return [];
      for (const id of ids) assigned.add(id);
      const reviewStep: ReviewStep = {
        changes: ids,
        anchor: "",
        note: text(step.note),
        check: text(step.check),
        skim: step.skim === true || ids.every((id) => changes.get(id)!.importsOnly),
        outsideIntent: step.outside_intent === true,
      };
      wanted.set(reviewStep, text(step.anchor));
      return [reviewStep];
    });
    if (steps.length === 0) continue;
    blocks.push({ id: `b${blocks.length + 1}`, title: text(block.title) || "Untitled block", intent: text(block.intent), steps });
  }

  const left: string[] = [];
  for (const id of toReview) {
    if (assigned.has(id)) continue;
    const change = changes.get(id)!;
    const home = change.importsOnly
      ? blocks.flatMap((b) => b.steps).find((step) => step.changes.some((other) => changes.get(other)!.path === change.path))
      : undefined;
    if (home) home.changes.push(id);
    else left.push(id);
  }
  if (left.length > 0) {
    blocks.push({
      id: `b${blocks.length + 1}`,
      title: "Left out of the blocks",
      intent: "Claude didn't place these changes. Review them on their own.",
      steps: left.map((id) => ({ changes: [id], anchor: "", note: "", check: "", skim: false, outsideIntent: false })),
    });
  }

  for (const step of blocks.flatMap((b) => b.steps)) {
    const code = step.changes.filter((id) => !changes.get(id)!.importsOnly);
    const asked = wanted.get(step) ?? "";
    step.anchor = code.includes(asked) ? asked : (code[0] ?? step.changes[0]!);
  }

  const stepOf = new Map(blocks.flatMap((b) => b.steps.flatMap((step) => step.changes.map((id) => [id, step] as const))));
  const seen = new Set<ReviewStep>();
  const focus: FocusPoint[] = [];
  for (const item of list(result.focus)) {
    const point = (item ?? {}) as Record<string, unknown>;
    const id = text(point.change);
    const why = text(point.why);
    const step = stepOf.get(id);
    if (!step || !why || changes.get(id)!.importsOnly || seen.has(step) || focus.length >= MAX_FOCUS) continue;
    seen.add(step);
    focus.push({ change: id, why });
  }
  return { summary: text(result.summary), focus, blocks };
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
}
