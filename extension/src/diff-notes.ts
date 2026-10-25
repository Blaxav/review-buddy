import { findCell } from "./diff-marks";
import { isolateEvents } from "./ui";

// Notes inside GitHub's diff: a table row right after a line, holding a card in
// its own shadow root, the way GitHub shows a review thread. GitHub renders the
// diff with React and rebuilds a file's rows when it re-renders, so each row is
// put back after its line whenever the page changes.

// `after` is the line anchor of the row the note follows.
export type DiffNote = { key: string; after: string; content: HTMLElement };

const NOTE = "data-review-ai-note";
const LINE_ROW = "tr:has(td[data-line-anchor], td[id^='diff-'])";

type NoteRow = { row: HTMLTableRowElement; root: ShadowRoot; content?: HTMLElement };

let notes: DiffNote[] = [];
let style = "";
const rows = new Map<string, NoteRow>();
let observer: MutationObserver | null = null;
let queued = false;

export function setNotes(next: DiffNote[], css: string): void {
  notes = next;
  style = css;
  const keys = new Set(next.map((note) => note.key));
  for (const [key, { row }] of rows) {
    if (keys.has(key)) continue;
    row.remove();
    rows.delete(key);
  }
  place();
  if (!observer && next.length > 0) {
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        place();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}

// Focuses an element of a note's card, without scrolling to it.
export function focusInNote(key: string, selector: string): void {
  rows.get(key)?.root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
}

function place(): void {
  for (const note of notes) {
    const entry = rows.get(note.key) ?? create(note.key);
    if (entry.content !== note.content) {
      entry.root.replaceChildren(Object.assign(document.createElement("style"), { textContent: style }), note.content);
      entry.content = note.content;
    }
    const line = findCell(note.after)?.closest("tr");
    if (!line) {
      entry.row.remove();
      continue;
    }
    if (!follows(entry.row, line)) line.after(entry.row);
    const cell = entry.row.firstElementChild as HTMLTableCellElement;
    const span = columns(line);
    if (cell.colSpan !== span) cell.colSpan = span;
  }
}

// The table's width in columns. Rows differ: GitHub's hunk headers span more
// columns than a line of code fills.
function columns(line: HTMLTableRowElement): number {
  const rows = [...(line.parentElement?.children ?? [])].slice(0, 40) as HTMLTableRowElement[];
  return Math.max(...rows.map((row) => [...(row.cells ?? [])].reduce((n, c) => n + c.colSpan, 0)), 1);
}

// Whether the row already sits after `line`, among the rows GitHub puts under
// it (its own review threads) and before the next line of code. Leaving it there
// keeps the two from swapping places on every render.
function follows(row: HTMLTableRowElement, line: HTMLTableRowElement): boolean {
  for (let next = line.nextElementSibling; next && !next.matches(LINE_ROW); next = next.nextElementSibling) {
    if (next === row) return true;
  }
  return false;
}

function create(key: string): NoteRow {
  const row = document.createElement("tr");
  row.setAttribute(NOTE, key);
  const cell = row.insertCell();
  const host = document.createElement("div");
  cell.append(host);
  const root = host.attachShadow({ mode: "open" });
  // GitHub's diff takes keys and clicks for its own grid navigation.
  isolateEvents(root, ["keydown", "keyup", "keypress", "mousedown", "click"]);
  const entry: NoteRow = { row, root };
  rows.set(key, entry);
  return entry;
}
