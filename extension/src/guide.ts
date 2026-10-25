import type Browser from "webextension-polyfill";
import {
  linesToReview,
  prKey,
  type Change,
  type GuideEvent,
  type GuideRequest,
  type PrRef,
  type ProvenKind,
  type ReviewBlock,
  type Triage,
} from "../../shared/protocol";
import { lineAnchor, scrollToLine, setMarks } from "./diff-marks";
import { icon } from "./icons";
import { GUIDE_PORT } from "./messages";
import { h, renderMarkdown } from "./ui";

// The Review tab: Claude's blocks to read one at a time, with GitHub's diff
// dimming the lines the helper proved need no review.

type Guide = {
  pr: PrRef;
  phase: "idle" | "running" | "done" | "error";
  status?: string;
  error?: string;
  triage?: Triage;
  blocks?: ReviewBlock[];
  port: Browser.Runtime.Port | null;
  // The block open in the list, whose lines carry a bar in the diff.
  current?: string;
  reviewed: Set<string>;
};

const KINDS: { kind: ProvenKind; label: string }[] = [
  { kind: "moved", label: "moved" },
  { kind: "renamed", label: "renamed" },
  { kind: "whitespace", label: "whitespace" },
  { kind: "generated", label: "generated" },
];

const guides = new Map<string, Guide>();
let guide: Guide | null = null;
let dim = true;
let askClaude: (question: string, label: string) => void = () => {};

export const guideView = h("div", { className: "guide" });

// `ask` opens the chat on a question about a block.
export function initGuide(ask: (question: string, label: string) => void): void {
  askClaude = ask;
}

// Follows the PR shown on the page. A PR whose smart review was started
// before picks it up again: the helper keeps its result.
export function setGuidePr(pr: PrRef | null): void {
  if (!pr) {
    guide = null;
    updateMarks();
    return;
  }
  const key = prKey(pr);
  if (guide && prKey(guide.pr) === key) return;
  const existing = guides.get(key);
  guide = existing ?? { pr, phase: "idle", port: null, reviewed: new Set() };
  guides.set(key, guide);
  render();
  updateMarks();
  if (!existing) {
    const current = guide;
    void load(startedKey(pr)).then((started) => {
      if (started && current.phase === "idle") start(current, false);
    });
  }
}

function start(target: Guide, regroup: boolean): void {
  target.port?.disconnect();
  Object.assign(target, { phase: "running", status: "Starting…", error: undefined, triage: undefined, blocks: undefined, current: undefined });
  void save(startedKey(target.pr), true);
  const port = browser.runtime.connect({ name: GUIDE_PORT });
  target.port = port;
  port.onMessage.addListener((event: unknown) => onEvent(target, event as GuideEvent));
  port.onDisconnect.addListener(() => {
    if (target.phase === "running") onEvent(target, { type: "error", message: "Lost the connection to the extension." });
  });
  port.postMessage({ pr: target.pr, regroup } satisfies GuideRequest);
  if (target === guide) render();
}

function onEvent(target: Guide, event: GuideEvent): void {
  switch (event.type) {
    case "status":
      target.status = event.message;
      break;
    case "tool":
      target.status = `${event.name} ${event.detail}`.trim();
      break;
    case "triage":
      target.triage = event.triage;
      break;
    case "blocks":
      target.blocks = event.blocks;
      target.phase = "done";
      finish(target);
      void load(reviewedKey(target)).then((ids) => {
        target.reviewed = new Set(Array.isArray(ids) ? ids : []);
        target.current = event.blocks.find((block) => !target.reviewed.has(block.id))?.id;
        if (target === guide) {
          render();
          updateMarks();
        }
      });
      return;
    case "error":
      target.phase = "error";
      target.error = event.message;
      finish(target);
      break;
  }
  if (target === guide) {
    render();
    if (event.type === "triage") updateMarks();
  }
}

function finish(target: Guide): void {
  target.status = undefined;
  target.port?.disconnect();
  target.port = null;
}

// --- Rendering ----------------------------------------------------------------

function render(): void {
  if (!guide) return guideView.replaceChildren();
  const g = guide;
  if (g.phase === "idle") {
    guideView.replaceChildren(
      h(
        "div",
        { className: "empty" },
        h("div", { className: "badge mark" }, icon("blocks")),
        h("h2", { textContent: "Review by block, not by file" }),
        h("p", {
          textContent:
            "Claude sorts the changes into blocks to read one at a time. Lines a check proves were moved, renamed or reformatted are dimmed in the diff, so you read only what changed.",
        }),
        h("button", { className: "primary", textContent: "Start smart review", onclick: () => start(g, false) }),
      ),
    );
    return;
  }
  const scrollTop = guideView.scrollTop;
  const parts: HTMLElement[] = [];
  if (g.triage) parts.push(renderSummary(g.triage));
  if (g.phase === "running") parts.push(h("div", { className: "status", textContent: g.status ?? "Working…" }));
  if (g.phase === "error") {
    parts.push(
      h(
        "div",
        { className: "setup" },
        h("div", { className: "error", textContent: g.error ?? "Something went wrong." }),
        h("button", { textContent: "Try again", onclick: () => start(g, false) }),
      ),
    );
  }
  if (g.phase === "done" && g.triage && g.blocks) {
    parts.push(renderBlocks(g, g.triage, g.blocks));
    parts.push(renderProof(g.triage));
  }
  guideView.replaceChildren(...parts);
  guideView.scrollTop = scrollTop;
}

function renderSummary(triage: Triage): HTMLElement {
  const total = triage.changes.reduce((n, c) => n + c.oldCount + c.newCount, 0);
  const review = triage.changes.reduce((n, c) => n + linesToReview(c), 0);
  const counts = new Map<ProvenKind, number>();
  for (const change of triage.changes) {
    for (const line of change.proven) counts.set(line.kind, (counts.get(line.kind) ?? 0) + 1);
  }
  const segment = (kind: string, n: number) => {
    const el = h("span", { className: `seg ${kind}` });
    el.style.flexGrow = String(n);
    return el;
  };
  const bar = h("div", { className: "bar" }, segment("review", review));
  const legend = h("div", { className: "legend" }, legendItem("review", `${fmt(review)} to review`));
  for (const { kind, label } of KINDS) {
    const n = counts.get(kind) ?? 0;
    if (n === 0) continue;
    bar.append(segment(kind, n));
    legend.append(legendItem(kind, `${fmt(n)} ${label}`));
  }
  const toggle = h("input", { type: "checkbox", checked: dim });
  toggle.onchange = () => {
    dim = toggle.checked;
    updateMarks();
  };
  return h(
    "div",
    { className: "summary" },
    h("div", { className: "headline" }, h("strong", { textContent: fmt(review) }), ` of ${fmt(total)} changed lines to review`),
    bar,
    legend,
    h("label", { className: "toggle" }, toggle, "Dim the other lines in the diff"),
  );
}

function legendItem(kind: string, text: string): HTMLElement {
  return h("span", {}, h("span", { className: `dot ${kind}` }), text);
}

function renderBlocks(g: Guide, triage: Triage, blocks: ReviewBlock[]): HTMLElement {
  if (blocks.length === 0) {
    return h("div", { className: "all-proven", textContent: "Every changed line is proven: nothing to review by hand." });
  }
  const changes = new Map(triage.changes.map((change) => [change.id, change]));
  const done = blocks.filter((block) => g.reviewed.has(block.id)).length;
  return h(
    "div",
    { className: "blocks" },
    h(
      "div",
      { className: "blocks-head" },
      h("span", { textContent: `Blocks · ${done} of ${blocks.length} reviewed` }),
      h("button", { className: "icon-button", title: "Ask Claude to group the changes again", ariaLabel: "Regroup", onclick: () => start(g, true) }, icon("refresh")),
    ),
    ...blocks.map((block, i) => renderBlock(g, block, i, changes)),
  );
}

function renderBlock(g: Guide, block: ReviewBlock, index: number, changes: Map<string, Change>): HTMLElement {
  const reviewed = g.reviewed.has(block.id);
  const open = g.current === block.id;
  const lines = block.changes.reduce((n, id) => n + linesToReview(changes.get(id)!), 0);
  const el = h(
    "div",
    { className: `block${open ? " open" : ""}${reviewed ? " reviewed" : ""}` },
    h(
      "button",
      { className: "block-head", ariaExpanded: String(open), onclick: () => openBlock(g, open ? undefined : block.id, !open) },
      h("span", { className: "num" }, reviewed ? icon("check") : String(index + 1)),
      h("span", { className: "block-title", textContent: block.title }),
      h("span", { className: "meta", textContent: `${lines} line${lines === 1 ? "" : "s"}` }),
      icon("chevron"),
    ),
  );
  if (!open) return el;

  const body = h("div", { className: "block-body" });
  if (block.intent) body.append(h("p", { className: "intent", textContent: block.intent }));
  if (block.checks.length > 0) {
    body.append(
      h("div", { className: "label", textContent: "Worth checking" }),
      h("ul", { className: "checks" }, ...block.checks.map((check) => h("li", {}, renderMarkdown(check)))),
    );
  }
  for (const { change, note } of block.outsideIntent) {
    const target = changes.get(change);
    body.append(
      h(
        "div",
        { className: "outside" },
        icon("warning"),
        h("div", {}, h("strong", { textContent: "Outside the intent" }), target ? changeButton(g, target) : "", h("div", { textContent: note })),
      ),
    );
  }
  body.append(
    h("div", { className: "label", textContent: "Changes" }),
    h("div", { className: "changes" }, ...block.changes.map((id) => changeButton(g, changes.get(id)!))),
    h(
      "div",
      { className: "block-actions" },
      h("button", { onclick: () => askAbout(block, changes) }, icon("sparkle"), "Ask Claude"),
      reviewed
        ? h("button", { textContent: "Mark as not reviewed", onclick: () => setReviewed(g, block, false) })
        : h("button", { className: "primary", onclick: () => setReviewed(g, block, true) }, icon("check"), "Reviewed"),
    ),
  );
  el.append(body);
  return el;
}

function changeButton(g: Guide, change: Change): HTMLElement {
  const where = changeLines(change);
  const partly = change.proven.length > 0;
  return h(
    "button",
    {
      className: "change",
      title: `${change.path}:${where}${partly ? ` · ${change.proven.length} of its lines are proven` : ""}`,
      onclick: () => goTo(g, change),
    },
    icon("file"),
    h("span", { className: "path", textContent: change.path }),
    h("span", { className: "lines", textContent: where }),
  );
}

// "12–18" on the head side, or the removed lines when nothing was added.
function changeLines(change: Change): string {
  const [start, count, suffix] = change.newCount > 0 ? [change.newStart, change.newCount, ""] : [change.oldStart, change.oldCount, " (removed)"];
  return (count > 1 ? `${start}–${start + count - 1}` : `${start}`) + suffix;
}

function renderProof(triage: Triage): HTMLElement {
  const moves = new Map<string, number>();
  let whitespace = 0;
  const generated = new Set<string>();
  for (const change of triage.changes) {
    for (const line of change.proven) {
      if (line.kind === "moved" && line.side === "RIGHT") {
        const from = line.detail.replace(/^Moved from /, "").replace(/:\d+$/, "");
        const key = `${from} → ${change.path}`;
        moves.set(key, (moves.get(key) ?? 0) + 1);
      } else if (line.kind === "whitespace") {
        whitespace++;
      } else if (line.kind === "generated") {
        generated.add(change.path);
      }
    }
  }
  const items: HTMLElement[] = [];
  const section = (title: string, explain: string, rows: string[]) => {
    if (rows.length === 0) return;
    items.push(
      h("div", { className: "proof-title", textContent: title }),
      h("div", { className: "proof-explain", textContent: explain }),
      h("ul", {}, ...rows.map((row) => h("li", { textContent: row, title: row }))),
    );
  };
  section(
    "Moved",
    "Removed from one file and added to another line for line, with one indentation shift for the whole block.",
    [...moves].map(([pair, n]) => `${pair} · ${n} line${n === 1 ? "" : "s"}`),
  );
  section(
    "Renamed",
    "Lines that differ only by these names. Each old name is gone from the repository, and each new one appeared nowhere before.",
    triage.renames.map(({ from, to }) => `${from} → ${to}`),
  );
  section(
    "Whitespace",
    "Blank lines, and lines whose code is unchanged once whitespace is ignored (except indentation in Python and YAML).",
    whitespace ? [`${whitespace} line${whitespace === 1 ? "" : "s"}`] : [],
  );
  section("Generated", "Lockfiles, and files .gitattributes marks as linguist-generated.", [...generated]);
  if (items.length === 0) return h("div");
  return h("details", { className: "proof" }, h("summary", {}, icon("chevron"), "What was set aside, and why"), ...items);
}

// --- Actions ------------------------------------------------------------------

function openBlock(g: Guide, id: string | undefined, scroll: boolean): void {
  g.current = id;
  render();
  updateMarks();
  const block = g.blocks?.find((b) => b.id === id);
  const first = block && g.triage?.changes.find((change) => change.id === block.changes[0]);
  if (scroll && first) goTo(g, first);
}

function setReviewed(g: Guide, block: ReviewBlock, reviewed: boolean): void {
  if (reviewed) g.reviewed.add(block.id);
  else g.reviewed.delete(block.id);
  void save(reviewedKey(g), [...g.reviewed]);
  if (!reviewed) return render();
  const blocks = g.blocks ?? [];
  const after = blocks.slice(blocks.indexOf(block) + 1).concat(blocks);
  openBlock(g, after.find((b) => !g.reviewed.has(b.id))?.id, true);
}

function goTo(g: Guide, change: Change): void {
  const firstReviewLine = (side: "LEFT" | "RIGHT", start: number, count: number) => {
    for (let line = start; line < start + count; line++) {
      if (!change.proven.some((p) => p.side === side && p.line === line)) return line;
    }
    return count > 0 ? start : undefined;
  };
  const right = firstReviewLine("RIGHT", change.newStart, change.newCount);
  const anchor = right !== undefined
    ? lineAnchor(change.fileHash, "RIGHT", right)
    : lineAnchor(change.fileHash, "LEFT", firstReviewLine("LEFT", change.oldStart, change.oldCount) ?? change.oldStart);
  scrollToLine(anchor, `/${g.pr.owner}/${g.pr.repo}/pull/${g.pr.number}/files`);
}

function askAbout(block: ReviewBlock, changes: Map<string, Change>): void {
  const list = block.changes.map((id) => {
    const change = changes.get(id)!;
    return `- ${change.path}:${changeLines(change)}`;
  });
  askClaude(
    `Walk me through the block "${block.title}" of this PR. It claims: ${block.intent}\n\nIts changes:\n${list.join("\n")}\n\n` +
      "Check the code against that claim, and flag anything wrong or missing.",
    `Explain block: ${block.title}`,
  );
}

function updateMarks(): void {
  const g = guide;
  if (!g?.triage) return setMarks(null);
  const proven = new Map<string, string>();
  for (const change of g.triage.changes) {
    for (const line of change.proven) proven.set(lineAnchor(change.fileHash, line.side, line.line), line.detail);
  }
  const focus = new Set<string>();
  const block = g.blocks?.find((b) => b.id === g.current);
  for (const id of block?.changes ?? []) {
    const change = g.triage.changes.find((c) => c.id === id);
    if (!change) continue;
    for (let line = change.oldStart; line < change.oldStart + change.oldCount; line++) focus.add(lineAnchor(change.fileHash, "LEFT", line));
    for (let line = change.newStart; line < change.newStart + change.newCount; line++) focus.add(lineAnchor(change.fileHash, "RIGHT", line));
  }
  setMarks({ proven, focus, dim });
}

// --- Storage --------------------------------------------------------------------

function startedKey(pr: PrRef): string {
  return `guide-started ${prKey(pr)}`;
}

// Reviewed blocks belong to one grouping of one head: a push or a regroup starts over.
function reviewedKey(g: Guide): string {
  return `guide-reviewed ${prKey(g.pr)}@${g.triage?.headSha} ${g.blocks?.map((b) => b.changes.join(",")).join("|")}`;
}

async function load(key: string): Promise<unknown> {
  try {
    return (await browser.storage.local.get(key))[key];
  } catch {
    return undefined;
  }
}

async function save(key: string, value: unknown): Promise<void> {
  try {
    await browser.storage.local.set({ [key]: value });
  } catch {
    // Without storage, the review state lasts until the page reloads.
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
