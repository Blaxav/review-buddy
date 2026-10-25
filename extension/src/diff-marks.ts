import type { Side } from "../../shared/protocol";

// Marks on GitHub's own diff: proven lines are dimmed, and a bar runs beside
// the lines of the block under review. GitHub renders diff rows lazily and
// drops them when they scroll away, so marks are applied as rows appear. They
// are data attributes, not classes: React rewrites a cell's class when it
// re-renders the row.

const PROVEN = "data-review-ai-proven";
const FOCUS = "data-review-ai-focus";
const FOCUS_EDGE = "data-review-ai-edge";
const TITLED = "data-review-ai-title";
const MARKS = [PROVEN, FOCUS, FOCUS_EDGE, TITLED];
const MARKED = MARKS.map((name) => `[${name}]`).join(", ");
const DOCKED = "review-ai-docked";

// The line-number cell of each diff line: `data-line-anchor` in GitHub's
// current diff view, the cell's id in the classic one.
const LINE_CELLS = "td[data-line-anchor], td[id^='diff-']";

const STYLE = `
td[${PROVEN}] { opacity: 0.35; transition: opacity 0.15s; }
tr:hover > td[${PROVEN}] { opacity: 1; }
td[${FOCUS}] { background-image: linear-gradient(rgb(217 119 87 / 0.08), rgb(217 119 87 / 0.08)) !important; }
td[${FOCUS_EDGE}] { box-shadow: inset 4px 0 0 #d97757 !important; }
html.${DOCKED} body { margin-right: 452px; }
@media (max-width: 1100px) { html.${DOCKED} body { margin-right: 0; } }
`;

// `proven` maps a line's anchor to why it needs no review.
export type LineMarks = { proven: Map<string, string>; focus: Set<string>; dim: boolean };

let marks: LineMarks = { proven: new Map(), focus: new Set(), dim: true };
let observer: MutationObserver | null = null;

export function lineAnchor(fileHash: string, side: Side, line: number): string {
  return `diff-${fileHash}${side === "LEFT" ? "L" : "R"}${line}`;
}

export function setMarks(next: LineMarks | null): void {
  marks = next ?? { proven: new Map(), focus: new Set(), dim: true };
  ensureStyle();
  for (const el of document.querySelectorAll(MARKED)) clear(el);
  for (const cell of document.querySelectorAll(LINE_CELLS)) mark(cell);
  if (!observer) {
    observer = new MutationObserver((records) => {
      if (marks.proven.size === 0 && marks.focus.size === 0) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(LINE_CELLS)) mark(node);
          for (const cell of node.querySelectorAll(LINE_CELLS)) mark(cell);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}

// Makes room for the panel, so it doesn't cover the diff.
export function setDocked(docked: boolean): void {
  ensureStyle();
  document.documentElement.classList.toggle(DOCKED, docked);
}

// Scrolls GitHub's diff to a line; a line not rendered yet is reached through
// the URL hash, which GitHub follows on the files tab.
export function scrollToLine(anchor: string, filesUrl: string): void {
  const cell = document.querySelector(`td[data-line-anchor="${anchor}"], td[id="${anchor}"]`);
  if (cell) {
    cell.scrollIntoView({ block: "center", behavior: "smooth" });
  } else if (/\/pull\/\d+\/(files|changes)/.test(location.pathname)) {
    location.hash = anchor;
  } else {
    location.href = `${filesUrl}#${anchor}`;
  }
}

function anchorOf(cell: Element): string | null {
  return cell.getAttribute("data-line-anchor") ?? (cell.id.startsWith("diff-") ? cell.id : null);
}

function mark(cell: Element): void {
  const anchor = anchorOf(cell);
  if (!anchor) return;
  const why = marks.proven.get(anchor);
  const focus = marks.focus.has(anchor);
  if (!why && !focus) return;
  const cells = lineCells(cell, anchor);
  for (const el of cells) {
    el.toggleAttribute(PROVEN, why !== undefined && marks.dim);
    el.toggleAttribute(FOCUS, focus);
  }
  cells[0]!.toggleAttribute(FOCUS_EDGE, focus);
  if (why) {
    cell.setAttribute("title", why);
    cell.toggleAttribute(TITLED, true);
  }
}

// The cells showing one line, from its left edge: in the current view, the
// cells of its side; in the classic unified view, the whole row; in the classic
// split view, the number cell and the cells after it up to the other side's.
function lineCells(cell: Element, anchor: string): Element[] {
  const row = cell.parentElement;
  if (!row) return [cell];
  const side = ["left-side", "right-side"].find((name) => cell.classList.contains(name));
  if (side) return [...row.querySelectorAll(`:scope > td.${side}`)];
  if (!cell.closest("table")?.classList.contains("file-diff-split")) return [...row.children];
  const cells = [cell];
  for (let next = cell.nextElementSibling; next; next = next.nextElementSibling) {
    const other = next.matches(LINE_CELLS) ? anchorOf(next) : null;
    if (other && other !== anchor) break;
    cells.push(next);
  }
  return cells;
}

function clear(el: Element): void {
  if (el.hasAttribute(TITLED)) el.removeAttribute("title");
  for (const name of MARKS) el.removeAttribute(name);
}

// Re-added when missing: GitHub's navigation can rebuild <head>.
function ensureStyle(): void {
  if (document.getElementById("review-ai-diff-marks")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "review-ai-diff-marks", textContent: STYLE }));
}
