import type Browser from "webextension-polyfill";
import {
  linesToRead,
  linesToReview,
  prKey,
  type Change,
  type FocusPoint,
  type GuideEvent,
  type GuideRequest,
  type PrRef,
  type ProvenKind,
  type ReviewBlock,
  type ReviewGuide,
  type ReviewStep,
  type Triage,
} from "../../shared/protocol";
import { lineAnchor, scrollToLine, setMarks } from "./diff-marks";
import css from "./guide.css" with { type: "text" };
import { icon, type IconName } from "./icons";
import { GUIDE_PORT } from "./messages";
import { h } from "./ui";

// The smart review: a small bar at the bottom of the page that first briefs
// the reviewer on what the PR changes and where to read closely, then walks
// them through it in Claude's reading order, one click per step, while
// GitHub's diff dims the lines the helper proved need no review.

export const guideCss = css;

// One step on the walk, with its block, and the change the diff scrolls to.
type Stop = { block: ReviewBlock; blockIndex: number; step: ReviewStep; stepIndex: number; anchor: Change };

type Guide = {
  pr: PrRef;
  phase: "idle" | "running" | "done" | "error";
  status?: string;
  error?: string;
  triage?: Triage;
  review?: ReviewGuide;
  stops: Stop[];
  // The stop shown: -1 before the first, stops.length once past the last.
  at: number;
  furthest: number;
  outline: boolean;
  // Set when the current change couldn't be found in the page.
  lost?: string;
  // The change of the current step the diff shows, when not its anchor.
  shown?: string;
  port: Browser.Runtime.Port | null;
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

export const guideStarter = h(
  "button",
  {
    className: "starter",
    title: "Walk through this PR's changes, skipping moved and renamed code",
    hidden: true,
    onclick: () => guide && start(guide, false),
  },
  icon("sparkle"),
  "Smart review",
);
export const guideBar = h("div", { className: "review-bar", hidden: true });
guideBar.setAttribute("role", "region");
guideBar.setAttribute("aria-label", "Smart review");
// Announces each step to screen readers; it outlives the bar's rebuilds.
export const guideLive = h("div", { className: "visually-hidden" });
guideLive.setAttribute("aria-live", "polite");

// `ask` opens the chat on a question about a change.
export function initGuide(ask: (question: string, label: string) => void): void {
  askClaude = ask;
  document.addEventListener("keydown", onKey, true);
}

// ] and [ walk the steps, Escape closes the outline. Keys typed into a field
// are left alone, and so are GitHub's own shortcuts, which use other keys.
function onKey(event: KeyboardEvent): void {
  const g = guide;
  if (!g || g.phase !== "done" || g.stops.length === 0) return;
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return;
  if (event.key === "]" && g.at < g.stops.length) go(g, g.at + 1);
  else if (event.key === "[" && g.at > 0) go(g, g.at - 1);
  else if (event.key === "Escape" && g.outline) {
    g.outline = false;
    render();
  } else return;
  event.preventDefault();
  event.stopPropagation();
}

function isTyping(event: KeyboardEvent): boolean {
  const target = event.composedPath()[0];
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

// Moves the bar out from under the chat panel.
export function setGuideDocked(docked: boolean): void {
  guideBar.classList.toggle("docked", docked);
}

// Follows the PR shown on the page. A PR whose smart review was started
// before picks it up again: the helper keeps its result.
export function setGuidePr(pr: PrRef | null): void {
  if (!pr) {
    guide = null;
    render();
    updateMarks();
    return;
  }
  const key = prKey(pr);
  if (guide && prKey(guide.pr) === key) return;
  const existing = guides.get(key);
  guide = existing ?? { pr, phase: "idle", stops: [], at: -1, furthest: -1, outline: false, port: null };
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
  Object.assign(target, {
    phase: "running",
    status: "Starting…",
    error: undefined,
    triage: undefined,
    review: undefined,
    stops: [],
    at: -1,
    furthest: -1,
    outline: false,
  });
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

function end(target: Guide): void {
  target.port?.disconnect();
  Object.assign(target, { phase: "idle", port: null, triage: undefined, review: undefined, stops: [], at: -1, furthest: -1, outline: false });
  void save(startedKey(target.pr), false);
  if (target === guide) {
    render();
    updateMarks();
  }
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
    case "guide":
      target.review = event.guide;
      target.stops = walk(event.guide.blocks, target.triage!);
      target.phase = "done";
      finish(target);
      void load(progressKey(target)).then((saved) => {
        const { at, furthest } = (saved ?? {}) as { at?: number; furthest?: number };
        if (typeof at === "number") target.at = Math.min(at, target.stops.length);
        if (typeof furthest === "number") target.furthest = Math.min(furthest, target.stops.length);
        if (target !== guide) return;
        render();
        updateMarks();
        const stop = target.stops[target.at];
        if (stop && takePendingJump(target)) void goTo(target, stop.anchor);
      });
      break;
    case "error":
      target.phase = "error";
      target.error = event.message;
      finish(target);
      break;
  }
  if (target === guide) {
    render();
    if (event.type === "triage" || event.type === "guide") updateMarks();
  }
}

function finish(target: Guide): void {
  target.status = undefined;
  target.port?.disconnect();
  target.port = null;
}

function walk(blocks: ReviewBlock[], triage: Triage): Stop[] {
  const changes = new Map(triage.changes.map((change) => [change.id, change]));
  return blocks.flatMap((block, blockIndex) =>
    block.steps.flatMap((step, stepIndex) => {
      const anchor = changes.get(step.anchor) ?? changes.get(step.changes[0]!);
      return anchor ? [{ block, blockIndex, step, stepIndex, anchor }] : [];
    }),
  );
}

// --- The bar ------------------------------------------------------------------

function render(): void {
  const g = guide;
  guideStarter.hidden = !g || g.phase !== "idle";
  guideBar.hidden = !g || g.phase === "idle";
  if (!g || g.phase === "idle") return guideBar.replaceChildren();

  // Rebuilding the bar drops the focused button: put focus back on its successor.
  const focused = (guideBar.getRootNode() as ShadowRoot).activeElement;
  const refocus = focused instanceof HTMLElement && guideBar.contains(focused) ? focused.dataset.key : undefined;

  const close = iconButton("close", "End the smart review", () => end(g));
  let rows: HTMLElement[];
  if (g.phase === "running") {
    rows = [
      row(
        mark(),
        h("div", { className: "grow" }, h("div", { className: "title", textContent: headline(g) }), h("div", { className: "status", textContent: g.status ?? "Working…" })),
        close,
      ),
    ];
  } else if (g.phase === "error") {
    rows = [
      row(
        mark(),
        h("div", { className: "grow" }, h("div", { className: "title", textContent: "Smart review failed" }), h("div", { className: "error", textContent: g.error ?? "" })),
        h("button", { textContent: "Try again", onclick: () => start(g, false) }),
        close,
      ),
    ];
  } else if (g.stops.length === 0) {
    rows = [row(mark(), h("div", { className: "grow title", textContent: "Nothing to read: every changed line is proven." }), outlineButton(g), close)];
  } else if (g.at < 0) {
    const steps = g.stops.length;
    const read = g.triage!.changes.reduce((n, c) => n + linesToRead(c), 0);
    rows = [
      row(
        mark(),
        h(
          "div",
          { className: "grow title" },
          "Smart review",
          h("span", { className: "muted", textContent: ` · ${steps} step${steps === 1 ? "" : "s"}, ${fmt(read)} line${read === 1 ? "" : "s"} to read` }),
        ),
        close,
      ),
      ...renderBriefing(g),
      controls(h("span", { className: "grow" }), outlineButton(g), nextButton(g, "Start", "Start the walk")),
    ];
  } else if (g.at >= g.stops.length) {
    rows = [
      row(
        h("span", { className: "done-mark" }, icon("check")),
        h("div", { className: "grow title", textContent: `Walked all ${g.stops.length} steps` }),
        close,
      ),
      ...renderBriefing(g, false),
      controls(
        h("span", { className: "grow" }),
        outlineButton(g),
        backButton(g),
        h("button", { textContent: "From the start", onclick: () => go(g, 0) }),
      ),
    ];
  } else {
    rows = renderStop(g, g.stops[g.at]!, close);
  }
  guideBar.replaceChildren(...rows);
  if (g.outline) guideBar.prepend(renderOutline(g));
  if (refocus) guideBar.querySelector<HTMLElement>(`[data-key="${refocus}"]`)?.focus();
}

// The bar's last row: its buttons keep their place from one step to the next.
function controls(...children: (Node | string)[]): HTMLElement {
  return h("div", { className: "row controls" }, ...children);
}

function nextButton(g: Guide, label: string, title: string): HTMLButtonElement {
  const button = h("button", { className: "primary next", title: `${title} (])`, onclick: () => go(g, g.at + 1) }, label, icon("chevron"));
  button.dataset.key = "next";
  return button;
}

function backButton(g: Guide): HTMLButtonElement {
  const button = iconButton("back", "Previous step ([)", () => go(g, g.at - 1), g.at === 0);
  button.dataset.key = "back";
  return button;
}

function renderStop(g: Guide, stop: Stop, close: HTMLElement): HTMLElement[] {
  const { block, step, stepIndex } = stop;
  const blocks = g.review!.blocks.length;
  const rows = [
    row(
      h(
        "div",
        { className: "grow title" },
        block.title,
        blocks > 1 ? h("span", { className: "muted", textContent: ` · block ${stop.blockIndex + 1} of ${blocks}` }) : "",
      ),
      close,
    ),
  ];
  // Entering a block, its intent says what the steps add up to.
  if (stepIndex === 0 && block.intent) rows.push(row(h("span", { className: "grow intent" }, ...prose(block.intent))));

  // The anchor first: the walk lands there, and the rest follow in order.
  const changes = [stop.anchor, ...step.changes.filter((id) => id !== stop.anchor.id).map((id) => g.triage!.changes.find((change) => change.id === id)!)];
  const shown = changes.find((change) => change.id === g.shown) ?? stop.anchor;
  const focus = g.review!.focus.find((point) => step.changes.includes(point.change));
  const meta = row(
    h("button", { className: "where", title: `${location(shown)} · show it again`, onclick: () => void goTo(g, shown) }, shortLocation(shown)),
  );
  if (changes.length > 1) {
    const at = changes.indexOf(shown);
    const following = changes[(at + 1) % changes.length]!;
    const more = h(
      "button",
      {
        className: "more",
        title: `Show ${location(following)}`,
        onclick: () => {
          g.shown = following.id;
          render();
          void goTo(g, following);
        },
      },
      `${at + 1} of ${changes.length} changes`,
      icon("chevron"),
    );
    more.dataset.key = "more";
    meta.append(more);
  }
  if (focus) meta.append(h("span", { className: "tag focus", title: "One of the places the briefing asks you to read closely", textContent: "Read closely" }));
  else if (step.skim) meta.append(h("span", { className: "tag skim", title: "Mechanical: wiring, imports, fakes or docs", textContent: "Skim" }));
  if (step.outsideIntent) {
    meta.append(h("span", { className: "tag", title: "Neither the block's intent nor the PR description announces this change", textContent: "Not in the PR description" }));
  }
  rows.push(meta);
  if (step.note) rows.push(row(h("p", { className: "grow note" }, ...prose(step.note))));
  if (focus) rows.push(row(h("span", { className: "label verify-label", textContent: "Verify" }), h("span", { className: "grow verify" }, ...prose(focus.why))));
  if (step.check) rows.push(row(h("span", { className: "label check-label" }, icon("warning"), "Concern"), h("span", { className: "grow check" }, ...prose(step.check))));
  if (g.lost) rows.push(row(h("span", { className: "grow error", textContent: g.lost })));
  rows.push(
    controls(
      h("span", { className: "grow progress", textContent: `Step ${g.at + 1} of ${g.stops.length}` }),
      iconButton("sparkle", "Ask Claude about this step", () => askAbout(g, stop)),
      outlineButton(g),
      backButton(g),
      nextButton(g, g.at === g.stops.length - 1 ? "Finish" : "Next", g.at === g.stops.length - 1 ? "Finish the walk" : "Next step"),
    ),
  );
  return rows;
}

// What the reviewer reads before the walk: what the PR changes, and the
// places to read closely, each a link to its step.
function renderBriefing(g: Guide, withSummary = true): HTMLElement[] {
  const { summary, focus } = g.review!;
  const items: HTMLElement[] = [];
  if (summary && withSummary) items.push(h("p", { className: "summary-text" }, ...prose(summary)));
  const points = focus.flatMap((point) => focusItem(g, point));
  if (points.length > 0) items.push(h("div", { className: "focus-list" }, h("div", { className: "focus-head", textContent: "Read closely" }), ...points));
  return items;
}

function focusItem(g: Guide, point: FocusPoint): HTMLElement[] {
  const at = g.stops.findIndex((stop) => stop.step.changes.includes(point.change));
  const change = g.triage!.changes.find((c) => c.id === point.change);
  if (at < 0 || !change) return [];
  return [
    h(
      "button",
      {
        className: "focus-item",
        title: `Go to ${location(change)}`,
        onclick: () => {
          g.outline = false;
          go(g, at, change);
        },
      },
      h("span", { className: "where", textContent: shortLocation(change) }),
      h("span", { className: "grow why" }, ...prose(point.why)),
    ),
  ];
}

function renderOutline(g: Guide): HTMLElement {
  const outline = h("div", { className: "outline" });
  // Before the walk, the bar itself shows the briefing.
  if (g.review && g.at >= 0) outline.append(...renderBriefing(g));
  if (g.triage) outline.append(renderSummary(g.triage));
  if (g.review && g.review.blocks.length > 0) {
    const current = g.stops[g.at]?.block;
    const changes = new Map(g.triage!.changes.map((change) => [change.id, change]));
    outline.append(
      h(
        "div",
        { className: "outline-head" },
        h("span", { textContent: "Blocks" }),
        h("button", { className: "icon-button", title: "Ask Claude to group the changes again", ariaLabel: "Regroup", onclick: () => start(g, true) }, icon("refresh")),
      ),
      ...g.review.blocks.map((block, i) => {
        const indexes = g.stops.flatMap((s, at) => (s.block === block ? [at] : []));
        const walked = indexes.length > 0 && indexes[indexes.length - 1]! < g.furthest;
        const lines = block.steps.reduce((n, step) => n + step.changes.reduce((m, id) => m + linesToRead(changes.get(id)!), 0), 0);
        return h(
          "button",
          {
            className: `outline-block${block === current ? " current" : ""}${walked ? " walked" : ""}`,
            onclick: () => {
              g.outline = false;
              go(g, indexes[0] ?? 0);
            },
          },
          h("span", { className: "num" }, walked ? icon("check") : String(i + 1)),
          h("span", { className: "grow" }, h("span", { className: "block-title", textContent: block.title }), h("small", {}, ...prose(block.intent))),
          h("span", { className: "muted", textContent: `${lines} line${lines === 1 ? "" : "s"}` }),
        );
      }),
    );
  }
  if (g.triage) outline.append(renderProof(g.triage));
  return outline;
}

function renderSummary(triage: Triage): HTMLElement {
  const counts = new Map<ProvenKind, number>();
  for (const change of triage.changes) {
    for (const line of change.proven) counts.set(line.kind, (counts.get(line.kind) ?? 0) + 1);
  }
  const review = triage.changes.reduce((n, c) => n + linesToRead(c), 0);
  const imports = triage.changes.reduce((n, c) => n + linesToReview(c) - linesToRead(c), 0);
  const segment = (kind: string, n: number) => {
    const el = h("span", { className: `seg ${kind}` });
    el.style.flexGrow = String(n);
    return el;
  };
  const bar = h("div", { className: "bar" }, segment("review", review));
  const legend = h("div", { className: "legend" }, legendItem("review", `${fmt(review)} to read`));
  if (imports > 0) {
    bar.append(segment("imports", imports));
    legend.append(legendItem("imports", `${fmt(imports)} in imports, read with their step`));
  }
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
  return h("div", { className: "summary" }, bar, legend, h("label", { className: "toggle" }, toggle, "Dim the proven lines in the diff"));
}

function legendItem(kind: string, text: string): HTMLElement {
  return h("span", {}, h("span", { className: `dot ${kind}` }), text);
}

function renderProof(triage: Triage): HTMLElement {
  const moves = new Map<string, number>();
  let whitespace = 0;
  const generated = new Set<string>();
  for (const change of triage.changes) {
    for (const line of change.proven) {
      if (line.kind === "moved" && line.side === "RIGHT") {
        const key = `${line.detail.replace(/^Moved from /, "").replace(/:\d+$/, "")} → ${change.path}`;
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
      h("ul", {}, ...rows.map((text) => h("li", { textContent: text, title: text }))),
    );
  };
  section("Moved", "Removed from one file and added to another line for line, with one indentation shift per block.", [...moves].map(([pair, n]) => `${pair} · ${n}`));
  section("Renamed", "Each old name is gone from the repository; each new one existed nowhere before.", triage.renames.map(({ from, to }) => `${from} → ${to}`));
  section("Whitespace", "Blank lines, and code unchanged once whitespace is ignored (not indentation in Python or YAML).", whitespace ? [`${whitespace} lines`] : []);
  section("Generated", "Lockfiles, and files .gitattributes marks linguist-generated.", [...generated]);
  if (items.length === 0) return h("div");
  return h("details", { className: "proof" }, h("summary", {}, icon("chevron"), "What was set aside, and why"), ...items);
}

// Claude's text, with its `code` spans set in code.
function prose(text: string): (Node | string)[] {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 === 1 ? h("code", { textContent: part }) : part));
}

function row(...children: (Node | string)[]): HTMLElement {
  return h("div", { className: "row" }, ...children);
}

function mark(): HTMLElement {
  return h("span", { className: "mark" }, icon("sparkle"));
}

function iconButton(name: IconName, label: string, onclick: () => void, disabled = false): HTMLButtonElement {
  return h("button", { className: "icon-button", title: label, ariaLabel: label, disabled, onclick }, icon(name));
}

function outlineButton(g: Guide): HTMLButtonElement {
  const button = iconButton("list", g.outline ? "Hide the outline" : "Outline: the blocks, and what was set aside", () => {
    g.outline = !g.outline;
    render();
  });
  button.classList.toggle("active", g.outline);
  return button;
}

function headline(g: Guide): string {
  if (!g.triage) return "Smart review";
  const total = g.triage.changes.reduce((n, c) => n + c.oldCount + c.newCount, 0);
  const read = g.triage.changes.reduce((n, c) => n + linesToRead(c), 0);
  return `${fmt(read)} of ${fmt(total)} changed lines to read`;
}

// "12–18" on the head side, or the removed lines when nothing was added.
function changeLines(change: Change): string {
  const [start, count, suffix] = change.newCount > 0 ? [change.newStart, change.newCount, ""] : [change.oldStart, change.oldCount, " (removed)"];
  return (count > 1 ? `${start}–${start + count - 1}` : `${start}`) + suffix;
}

// "store.py:321–381", what a location chip shows.
function shortLocation(change: Change): string {
  return `${basename(change.path)}:${changeLines(change)}`;
}

function location(change: Change): string {
  return `${change.path}:${changeLines(change)}`;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// --- Actions ------------------------------------------------------------------

// `change` is where to scroll, when not the step's anchor.
function go(g: Guide, at: number, change?: Change): void {
  g.at = Math.max(0, Math.min(at, g.stops.length));
  g.lost = undefined;
  g.shown = change?.id;
  g.outline = false;
  g.furthest = Math.max(g.furthest, g.at);
  void save(progressKey(g), { at: g.at, furthest: g.furthest });
  render();
  updateMarks();
  const stop = g.stops[g.at];
  guideLive.textContent = stop
    ? `Step ${g.at + 1} of ${g.stops.length}: ${stop.block.title}, ${location(change ?? stop.anchor)}`
    : `Walked all ${g.stops.length} steps`;
  if (stop) void goTo(g, change ?? stop.anchor);
}

async function goTo(g: Guide, change: Change): Promise<void> {
  const firstToRead = (side: "LEFT" | "RIGHT", start: number, count: number) => {
    for (let line = start; line < start + count; line++) {
      if (!change.proven.some((p) => p.side === side && p.line === line)) return line;
    }
    return count > 0 ? start : undefined;
  };
  const right = firstToRead("RIGHT", change.newStart, change.newCount);
  const anchor =
    right !== undefined
      ? lineAnchor(change.fileHash, "RIGHT", right)
      : lineAnchor(change.fileHash, "LEFT", firstToRead("LEFT", change.oldStart, change.oldCount) ?? change.oldStart);
  const lost = g.lost;
  g.lost = undefined;
  if (lost) render();
  // Reaching the files tab can load a new page, which ends this script: the
  // next one finishes the jump.
  setPendingJump(g);
  const found = await scrollToLine(anchor, change.path, `/${g.pr.owner}/${g.pr.repo}/pull/${g.pr.number}/files`);
  if (found === "leaving") return;
  takePendingJump(g);
  if (found || !g.stops[g.at]?.step.changes.includes(change.id)) return;
  g.lost = `Couldn't find ${shortLocation(change)} in the page. If GitHub collapsed the file, expand it, then click the location.`;
  if (g === guide) render();
}

function askAbout(g: Guide, stop: Stop): void {
  const changes = new Map(g.triage!.changes.map((change) => [change.id, change]));
  const where = stop.step.changes.map((id) => location(changes.get(id)!)).join(", ");
  askClaude(
    `Explain the step at ${where}, part of "${stop.block.title}" (${stop.block.intent}). ` +
      "Say briefly what it does and whether anything is wrong with it.",
    `Explain ${shortLocation(stop.anchor)}`,
  );
}

// The lines of the current step carry a bar in the diff.
function updateMarks(): void {
  const g = guide;
  if (!g?.triage) return setMarks(null);
  const proven = new Map<string, string>();
  for (const change of g.triage.changes) {
    for (const line of change.proven) proven.set(lineAnchor(change.fileHash, line.side, line.line), line.detail);
  }
  const focus = new Set<string>();
  for (const id of g.stops[g.at]?.step.changes ?? []) {
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

// Progress belongs to one grouping of one head: a push or a regroup starts over.
function progressKey(g: Guide): string {
  return `guide-progress ${prKey(g.pr)}@${g.triage?.headSha} ${g.stops.map((s) => s.anchor.id).join(",")}`;
}

// Per tab, so a jump only resumes in the tab that started it.
const PENDING_JUMP = "review-ai-pending-jump";

function setPendingJump(g: Guide): void {
  try {
    sessionStorage.setItem(PENDING_JUMP, prKey(g.pr));
  } catch {
    // Without session storage, a jump that loads a new page stops there.
  }
}

function takePendingJump(g: Guide): boolean {
  try {
    const pending = sessionStorage.getItem(PENDING_JUMP) === prKey(g.pr);
    sessionStorage.removeItem(PENDING_JUMP);
    return pending;
  } catch {
    return false;
  }
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
