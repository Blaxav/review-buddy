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
import { setNotes, type DiffNote } from "./diff-notes";
import css from "./guide.css" with { type: "text" };
import { icon, type IconName } from "./icons";
import { GUIDE_PORT } from "./messages";
import noteCss from "./note.css" with { type: "text" };
import { basename, PlaceCard, prose } from "./place-card";
import theme from "./theme.css" with { type: "text" };
import { h } from "./ui";

// The smart review extends a manual review of GitHub's diff. Claude's notes
// sit in the diff itself, in a card under the lines they are about, and the
// walk goes from one place worth checking to the next: Next scrolls the diff
// there and opens its card, where the reviewer can talk with Claude about the
// lines, comment on them, and mark the place checked. Mechanical steps get a
// one-line note in the diff and no stop. A small bar keeps the walk in reach
// while the reader scrolls, and opens an overview of the whole PR.

export const guideCss = css;

// A place worth checking: a step that isn't mechanical, or that the briefing
// asks to read closely. `anchor` is the change its note is about.
type Stop = { block: ReviewBlock; step: ReviewStep; anchor: Change; focus?: FocusPoint; card: PlaceCard };

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
  // The anchors of the places marked checked.
  checked: Set<string>;
  // The current place's card is folded to one line.
  minimized: boolean;
  overview: boolean;
  // Set when the current place couldn't be found in the page.
  lost?: string;
  port: Browser.Runtime.Port | null;
};

const KINDS: { kind: ProvenKind; label: string }[] = [
  { kind: "moved", label: "moved" },
  { kind: "renamed", label: "renamed" },
  { kind: "whitespace", label: "whitespace" },
  { kind: "generated", label: "generated" },
];

const NOTE_CSS = theme + noteCss;

const guides = new Map<string, Guide>();
let guide: Guide | null = null;
let dim = true;

export const guideStarter = h(
  "button",
  {
    className: "starter",
    title: "Find the places in this PR worth checking, and walk them in the diff",
    hidden: true,
    onclick: () => guide && start(guide, false),
  },
  icon("sparkle"),
  "Smart review",
);
export const guideBar = h("div", { className: "review-bar", hidden: true });
guideBar.setAttribute("role", "region");
guideBar.setAttribute("aria-label", "Smart review");
// Announces each stop to screen readers; it outlives the bar's rebuilds.
export const guideLive = h("div", { className: "visually-hidden" });
guideLive.setAttribute("aria-live", "polite");

export function initGuide(): void {
  document.addEventListener("keydown", onKey, true);
}

// ] and [ walk the places, Escape closes the overview. Keys typed into a field
// are left alone, and so are GitHub's own shortcuts, which use other keys.
function onKey(event: KeyboardEvent): void {
  const g = guide;
  if (!g || g.phase !== "done" || g.stops.length === 0) return;
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return;
  if (event.key === "]" && g.at < g.stops.length) go(g, g.at + 1);
  else if (event.key === "[" && g.at > 0) go(g, g.at - 1);
  else if (event.key === "Escape" && g.overview) setOverview(g, false);
  else return;
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
    return;
  }
  const key = prKey(pr);
  if (guide && prKey(guide.pr) === key) return;
  const existing = guides.get(key);
  guide = existing ?? { pr, phase: "idle", stops: [], at: -1, checked: new Set(), minimized: false, overview: false, port: null };
  guides.set(key, guide);
  render();
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
    checked: new Set(),
    minimized: false,
    overview: false,
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
  Object.assign(target, { phase: "idle", port: null, triage: undefined, review: undefined, stops: [], at: -1, checked: new Set(), minimized: false, overview: false });
  void save(startedKey(target.pr), false);
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
    case "guide":
      target.review = event.guide;
      target.stops = walk(target, event.guide, target.triage!);
      target.phase = "done";
      finish(target);
      void load(progressKey(target)).then((saved) => {
        const { at, checked } = (saved ?? {}) as { at?: number; checked?: string[] };
        if (typeof at === "number") target.at = Math.min(at, target.stops.length);
        if (Array.isArray(checked)) target.checked = new Set(checked);
        // A first look opens on the briefing.
        target.overview = target.at < 0;
        if (target !== guide) return;
        render();
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
  if (target === guide) render();
}

function finish(target: Guide): void {
  target.status = undefined;
  target.port?.disconnect();
  target.port = null;
}

function walk(g: Guide, review: ReviewGuide, triage: Triage): Stop[] {
  const changes = new Map(triage.changes.map((change) => [change.id, change]));
  const stops: Stop[] = [];
  for (const block of review.blocks) {
    let first = true;
    for (const step of block.steps) {
      const anchor = changes.get(step.anchor);
      const focus = review.focus.find((point) => step.changes.includes(point.change));
      if (!anchor || (step.skim && !focus)) continue;
      // The step's other changes: those in the anchor's file carry the same
      // bar in the diff, so the card counts them; the others get a link.
      const others = step.changes.filter((id) => id !== anchor.id).map((id) => changes.get(id)!).filter((change) => !change.importsOnly);
      const at = stops.length;
      const card = new PlaceCard(
        {
          pr: g.pr,
          anchor,
          title: block.title,
          intent: first ? block.intent : "",
          note: step.note,
          verify: focus?.why ?? "",
          concern: step.check,
          outsideIntent: step.outsideIntent,
          here: others.filter((change) => change.path === anchor.path).length,
          elsewhere: [...new Map(others.filter((change) => change.path !== anchor.path).map((change) => [change.path, change])).values()],
        },
        {
          open: () => go(g, at, false, false),
          minimize: () => {
            g.minimized = true;
            render();
          },
          setChecked: (checked) => setChecked(g, at, checked),
          previous: () => go(g, at - 1, true),
          next: () => go(g, at + 1, true),
          jump: (change) => void jump(g, change),
        },
      );
      stops.push({ block, step, anchor, focus, card });
      first = false;
    }
  }
  return stops;
}

function render(): void {
  renderBar();
  renderNotes();
  updateMarks();
}

// --- The bar ------------------------------------------------------------------

function renderBar(): void {
  const g = guide;
  guideStarter.hidden = !g || g.phase !== "idle";
  guideBar.hidden = !g || g.phase === "idle";
  if (!g || g.phase === "idle") return guideBar.replaceChildren();

  const close = iconButton("close", "End the smart review", () => end(g));
  let row: HTMLElement;
  if (g.phase === "running") {
    row = h(
      "div",
      { className: "row" },
      mark(),
      h("div", { className: "grow" }, h("div", { className: "title", textContent: headline(g) }), h("div", { className: "status", textContent: g.status ?? "Working…" })),
      close,
    );
  } else if (g.phase === "error") {
    row = h(
      "div",
      { className: "row" },
      mark(),
      h("div", { className: "grow" }, h("div", { className: "title", textContent: "Smart review failed" }), h("div", { className: "error", textContent: g.error ?? "" })),
      h("button", { textContent: "Try again", onclick: () => start(g, false) }),
      close,
    );
  } else {
    row = h("div", { className: "row" }, mark(), h("div", { className: "grow title" }, ...barTitle(g)), overviewButton(g), ...walkButtons(g), close);
  }
  const rows: HTMLElement[] = [row];
  if (g.lost) rows.push(h("div", { className: "row error", textContent: g.lost }));
  guideBar.replaceChildren(...rows);
  if (g.overview && g.phase === "done") guideBar.prepend(renderOverview(g));
}

function barTitle(g: Guide): (Node | string)[] {
  const total = g.stops.length;
  if (total === 0) return ["Nothing stands out", muted(" · the notes in the diff cover the rest")];
  if (g.at < 0) return ["Smart review", muted(` · ${total} place${total === 1 ? "" : "s"} worth checking`)];
  if (g.at >= total) {
    const left = total - g.checked.size;
    return left === 0 ? ["All places checked", muted(` · ${total} of ${total}`)] : ["End of the walk", muted(` · ${left} not checked yet`)];
  }
  const stop = g.stops[g.at]!;
  return [h("span", { className: "position", textContent: `${g.at + 1} of ${total}` }), " ", stop.block.title];
}

function walkButtons(g: Guide): HTMLElement[] {
  const total = g.stops.length;
  if (total === 0) return [];
  if (g.at < 0) return [h("button", { className: "primary next", title: "Go to the first place (])", onclick: () => go(g, 0) }, "Start", icon("chevron"))];
  const back = iconButton("back", "Previous place ([)", () => go(g, g.at - 1), g.at === 0);
  if (g.at >= total) {
    const unchecked = g.stops.findIndex((stop) => !g.checked.has(stop.anchor.id));
    return [back, h("button", { textContent: unchecked < 0 ? "From the start" : "First not checked", onclick: () => go(g, Math.max(unchecked, 0)) })];
  }
  return [back, h("button", { className: "primary next", title: "Next place (])", onclick: () => go(g, g.at + 1) }, g.at === total - 1 ? "Finish" : "Next", icon("chevron"))];
}

function overviewButton(g: Guide): HTMLButtonElement {
  const button = iconButton("list", g.overview ? "Hide the overview" : "Overview: what the PR changes, and every place worth checking", () => setOverview(g, !g.overview));
  button.classList.toggle("active", g.overview);
  return button;
}

function setOverview(g: Guide, open: boolean): void {
  g.overview = open;
  renderBar();
}

// --- The overview -----------------------------------------------------------------

function renderOverview(g: Guide): HTMLElement {
  const review = g.review!;
  const overview = h("div", { className: "overview" });
  if (review.summary) overview.append(h("p", { className: "summary-text" }, ...prose(review.summary)));
  if (g.stops.length > 0) {
    overview.append(
      h("div", { className: "section-head" }, "Worth checking", muted(` · ${g.checked.size} of ${g.stops.length} checked`)),
      h(
        "ol",
        { className: "places" },
        ...g.stops.map((stop, i) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                className: `place${i === g.at ? " current" : ""}${g.checked.has(stop.anchor.id) ? " checked" : ""}`,
                onclick: () => go(g, i),
              },
              h("span", { className: "num" }, g.checked.has(stop.anchor.id) ? icon("check") : String(i + 1)),
              h(
                "span",
                { className: "grow" },
                h("span", { className: "place-title" }, stop.block.title, stop.focus ? h("span", { className: "tag focus", textContent: "Look closely" }) : ""),
                h("small", {}, ...prose(stop.focus?.why || stop.step.note || stop.block.intent)),
              ),
              stop.step.check ? h("span", { className: "concern-mark", title: "Claude found a concern here" }, icon("warning")) : "",
            ),
          ),
        ),
      ),
    );
  }
  const skims = skimSteps(g);
  if (skims.length > 0) {
    overview.append(
      h(
        "details",
        { className: "skims" },
        h("summary", {}, icon("chevron"), `Also changed, safe to skim (${skims.length})`),
        h(
          "ul",
          {},
          ...skims.map(({ step, anchor }) =>
            h("li", {}, h("button", { className: "skim-link", onclick: () => void jump(g, anchor) }, ...prose(step.note || "Mechanical change"))),
          ),
        ),
      ),
    );
  }
  overview.append(renderSummary(g.triage!), renderProof(g.triage!));
  overview.append(
    h(
      "button",
      { className: "regroup", title: "Ask Claude to look at the PR again", onclick: () => start(g, true) },
      icon("refresh"),
      "Review again",
    ),
  );
  return overview;
}

function skimSteps(g: Guide): { step: ReviewStep; anchor: Change }[] {
  const walked = new Set(g.stops.map((stop) => stop.step));
  return g.review!.blocks.flatMap((block) =>
    block.steps.flatMap((step) => {
      const anchor = g.triage!.changes.find((change) => change.id === step.anchor);
      return walked.has(step) || !anchor ? [] : [{ step, anchor }];
    }),
  );
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
  const legend = h("div", { className: "legend" }, legendItem("review", `${fmt(review)} lines to read`));
  if (imports > 0) {
    bar.append(segment("imports", imports));
    legend.append(legendItem("imports", `${fmt(imports)} in imports`));
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
  return h("div", { className: "summary" }, bar, legend, h("label", { className: "toggle" }, toggle, "Dim the lines proven to need no review"));
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

// --- Notes in the diff ------------------------------------------------------------

// Every step gets a note under its lines: the current place opens in a card,
// the other places show one line that opens them, and mechanical steps a quiet
// line saying so.
function renderNotes(): void {
  const g = guide;
  if (!g || g.phase !== "done") return setNotes([], NOTE_CSS);
  const notes: DiffNote[] = g.stops.map((stop, i) => {
    stop.card.update({ position: i + 1, total: g.stops.length, open: i === g.at && !g.minimized, checked: g.checked.has(stop.anchor.id) });
    return { key: stop.anchor.id, after: lastLine(stop.anchor), content: stop.card.el };
  });
  for (const { step, anchor } of skimSteps(g)) {
    notes.push({
      key: anchor.id,
      after: lastLine(anchor),
      content: h("div", { className: "skim" }, mark(), h("span", { className: "skim-label", textContent: "Skim" }), h("span", {}, ...prose(step.note || "Mechanical change"))),
    });
  }
  setNotes(notes, NOTE_CSS);
}

// The line a change's note goes under: its last added line, or its last removed one.
function lastLine(change: Change): string {
  return change.newCount > 0
    ? lineAnchor(change.fileHash, "RIGHT", change.newStart + change.newCount - 1)
    : lineAnchor(change.fileHash, "LEFT", change.oldStart + change.oldCount - 1);
}

// "store.py, lines 375–381": where a change is, in words.
function linesLabel(change: Change): string {
  const [start, count] = change.newCount > 0 ? [change.newStart, change.newCount] : [change.oldStart, change.oldCount];
  return count > 1 ? `${basename(change.path)}, lines ${start}–${start + count - 1}` : `${basename(change.path)}, line ${start}`;
}

// --- Shared parts -------------------------------------------------------------------

function mark(): HTMLElement {
  return h("span", { className: "mark" }, icon("sparkle"));
}

function muted(text: string): HTMLElement {
  return h("span", { className: "muted", textContent: text });
}

function iconButton(name: IconName, label: string, onclick: () => void, disabled = false): HTMLButtonElement {
  return h("button", { className: "icon-button", title: label, ariaLabel: label, disabled, onclick }, icon(name));
}

function headline(g: Guide): string {
  if (!g.triage) return "Smart review";
  const total = g.triage.changes.reduce((n, c) => n + c.oldCount + c.newCount, 0);
  const read = g.triage.changes.reduce((n, c) => n + linesToRead(c), 0);
  return `${fmt(read)} of ${fmt(total)} changed lines to read`;
}

// --- Actions ------------------------------------------------------------------

// Opens place `at` and, unless `scroll` is false, scrolls the diff to it.
// `fromCard` moves focus to the new card, for a reader walking from the keyboard.
function go(g: Guide, at: number, fromCard = false, scroll = true): void {
  g.at = Math.max(0, Math.min(at, g.stops.length));
  g.lost = undefined;
  g.overview = false;
  g.minimized = false;
  saveProgress(g);
  render();
  const stop = g.stops[g.at];
  guideLive.textContent = stop ? `Place ${g.at + 1} of ${g.stops.length}: ${stop.block.title}` : "End of the walk";
  if (!stop) return;
  if (fromCard) stop.card.focus(g.checked.has(stop.anchor.id) ? "[data-key='next']" : "[data-key='check']");
  if (scroll) void goTo(g, stop.anchor);
}

// Checking a place folds its card and moves on to the next place not checked
// yet; the folded card stays in the diff, to open again.
function setChecked(g: Guide, at: number, checked: boolean): void {
  const id = g.stops[at]!.anchor.id;
  if (!checked) {
    g.checked.delete(id);
    saveProgress(g);
    render();
    return;
  }
  g.checked.add(id);
  const after = [...g.stops.keys()].slice(at + 1).concat([...g.stops.keys()].slice(0, at));
  const next = after.find((i) => !g.checked.has(g.stops[i]!.anchor.id));
  go(g, next ?? g.stops.length, true);
}

function saveProgress(g: Guide): void {
  void save(progressKey(g), { at: g.at, checked: [...g.checked] });
}

// Scrolls to a change without moving the walk.
async function jump(g: Guide, change: Change): Promise<void> {
  g.overview = false;
  renderBar();
  await goTo(g, change);
}

async function goTo(g: Guide, change: Change): Promise<void> {
  const firstToRead = (side: "LEFT" | "RIGHT", start: number, count: number) => {
    for (let line = start; line < start + count; line++) {
      if (!change.proven.some((p) => p.side === side && p.line === line)) return line;
    }
    return count > 0 ? start : undefined;
  };
  // The removed lines first: the unified view shows them above the added ones,
  // and the split view on the same rows.
  const left = firstToRead("LEFT", change.oldStart, change.oldCount);
  const anchor =
    left !== undefined
      ? lineAnchor(change.fileHash, "LEFT", left)
      : lineAnchor(change.fileHash, "RIGHT", firstToRead("RIGHT", change.newStart, change.newCount) ?? change.newStart);
  if (g.lost) {
    g.lost = undefined;
    renderBar();
  }
  // Reaching the files tab can load a new page, which ends this script: the
  // next one finishes the jump.
  setPendingJump(g);
  const found = await scrollToLine(anchor, change.path, `/${g.pr.owner}/${g.pr.repo}/pull/${g.pr.number}/files`);
  if (found === "leaving") return;
  takePendingJump(g);
  if (found) return;
  g.lost = `${linesLabel(change)} isn't in the page: GitHub may have collapsed ${change.path}. Expand it, then press Next again.`;
  if (g === guide) renderBar();
}

// Proven lines are dimmed, and the lines of the current place carry a bar.
function updateMarks(): void {
  const g = guide;
  if (!g?.triage || g.phase !== "done") return setMarks(null);
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

// Progress belongs to one review of one head: a push or a new review starts over.
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
