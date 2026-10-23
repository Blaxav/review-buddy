import type { DiffRow, LineSelection } from "../shared/protocol";

export type ChangedFile = { oldPath: string; newPath: string };

// Parses `git diff --name-status -z -M`: "M\0path\0" or "R087\0old\0new\0".
export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++]!;
    const oldPath = fields[i++]!;
    const newPath = status.startsWith("R") || status.startsWith("C") ? fields[i++]! : oldPath;
    files.push({ oldPath, newPath });
  }
  return files;
}

// Parses the diff of one file into rows; run with full context, it holds every
// line, so a selection made after expanding context on GitHub still resolves.
export function parseDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldLine++, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    }
  }
  return rows;
}

// The rows GitHub highlights for a selection: from its first line to its last, in diff order.
export function selectRows(rows: DiffRow[], selection: LineSelection): DiffRow[] {
  const find = (side: LineSelection["side"], line: number) =>
    rows.findIndex((row) => (side === "LEFT" ? row.oldLine : row.newLine) === line);
  const start = find(selection.startSide, selection.startLine);
  const end = find(selection.side, selection.line);
  if (start < 0 || end < 0) return [];
  return rows.slice(Math.min(start, end), Math.max(start, end) + 1);
}
