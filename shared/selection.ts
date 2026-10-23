import type { LineSelection, Side } from "./protocol";

// GitHub writes the selected diff lines into the URL hash: #diff-<sha256 of
// the path>R12 for one line, #diff-<sha256>L3-R5 for a range.
const HASH = /^#diff-([0-9a-f]{64})([LR])(\d+)(?:-([LR])(\d+))?$/;

export function parseSelectionHash(hash: string): LineSelection | null {
  const match = HASH.exec(hash);
  if (!match) return null;
  const startSide = toSide(match[2]!);
  const startLine = Number(match[3]);
  const side = match[4] ? toSide(match[4]) : startSide;
  const line = match[5] ? Number(match[5]) : startLine;
  // A range selected upwards on one side ends where it starts.
  if (side === startSide && line < startLine) {
    return { fileHash: match[1]!, startSide, startLine: line, side, line: startLine };
  }
  return { fileHash: match[1]!, startSide, startLine, side, line };
}

export function selectionKey(selection: LineSelection): string {
  const { fileHash, startSide, startLine, side, line } = selection;
  return `${fileHash}:${startSide[0]}${startLine}-${side[0]}${line}`;
}

export function isSingleLine(selection: LineSelection): boolean {
  return selection.startSide === selection.side && selection.startLine === selection.line;
}

function toSide(letter: string): Side {
  return letter === "L" ? "LEFT" : "RIGHT";
}
