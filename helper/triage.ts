import type { Change, ProvenLine, Rename, Side } from "../shared/protocol";

// Sorts the changed lines of a PR into the ones a reviewer must read and the
// ones a check proves need no review: code moved to another file unchanged,
// a consistent rename, whitespace, and generated files. A line stays to review
// unless its check passes, so a wrong guess costs reading time, never a missed change.

export type DiffLine = { line: number; text: string };

// One hunk of `git diff --unified=0`. `path` names the file the change is in
// (its new path, or its old one when the PR deletes it).
export type RawChange = {
  path: string;
  oldPath: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  removed: DiffLine[];
  added: DiffLine[];
};

// A moved block must hold this many letters and digits, as in git's --color-moved.
const MIN_MOVED_ALNUM = 20;

// Files where leading whitespace is syntax.
const INDENT_SENSITIVE = /\.(py|pyi|ya?ml|haml|pug|jade|slim|sass|styl|coffee|nim)$|(^|\/)Makefile$|\.mk$/;

const LOCKFILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json",
  "uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock", "Cargo.lock", "go.sum", "Gemfile.lock",
  "composer.lock", "flake.lock", "mix.lock", "pubspec.lock", "Podfile.lock", "packages.lock.json",
]);

// Words a "rename" must not touch: swapping one for another changes the program.
const KEYWORDS = new Set(
  (
    "abstract and any as assert async await bigint bool boolean break byte case catch chan char class const " +
    "continue crate def default defer del delete do double dyn elif else enum except export extends extern " +
    "false final finally float fn for from func get global go goto if impl implements import in infer int " +
    "interface is keyof lambda let long loop match mod module move mut namespace never new nil none None " +
    "nonlocal not null number object of or override package pass private protected pub public raise range " +
    "readonly ref return satisfies select self Self set short static str string struct super switch symbol " +
    "this throw trait True False true try type typeof undefined unknown unsafe use var virtual void where " +
    "while with yield"
  ).split(" "),
);

const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\S/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// Splits code into tokens, ignoring whitespace outside string literals.
export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));
}

// Parses `git diff --unified=0 --src-prefix=a/ --dst-prefix=b/` into its hunks.
export function parseChanges(diff: string): RawChange[] {
  const changes: RawChange[] = [];
  let oldPath = "";
  let newPath = "";
  let change: RawChange | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      change = null;
      oldPath = newPath = "";
    } else if (!change && line.startsWith("--- ")) {
      oldPath = diffPath(line.slice(4), "a/");
    } else if (!change && line.startsWith("+++ ")) {
      newPath = diffPath(line.slice(4), "b/");
    } else if (line.startsWith("@@")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      change = {
        path: newPath || oldPath,
        oldPath: oldPath || newPath,
        oldStart: oldLine,
        oldCount: Number(hunk[2] ?? 1),
        newStart: newLine,
        newCount: Number(hunk[4] ?? 1),
        removed: [],
        added: [],
      };
      changes.push(change);
    } else if (change && line.startsWith("-")) {
      change.removed.push({ line: oldLine++, text: line.slice(1) });
    } else if (change && line.startsWith("+")) {
      change.added.push({ line: newLine++, text: line.slice(1) });
    }
  }
  return changes;
}

// "a/src/x.ts", "/dev/null", or a C-quoted "\"a/odd name\"".
function diffPath(raw: string, prefix: string): string {
  if (raw === "/dev/null") return "";
  let path = raw;
  if (path.startsWith('"')) {
    try {
      path = JSON.parse(path) as string;
    } catch {
      path = path.slice(1, -1);
    }
  }
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// Which of `names` appear anywhere in the repository at the PR head, or at its base.
export type NameLookup = (names: string[], at: "head" | "base") => Promise<Set<string>>;

type Work = { change: RawChange; removed: (ProvenLine | null)[]; added: (ProvenLine | null)[] };

export type Classified = { changes: Omit<Change, "id" | "fileHash">[]; renames: Rename[] };

export async function classify(
  changes: RawChange[],
  isGenerated: (path: string) => boolean,
  lookup: NameLookup,
): Promise<Classified> {
  const works: Work[] = changes.map((change) => ({
    change,
    removed: change.removed.map(() => null),
    added: change.added.map(() => null),
  }));
  for (const work of works) {
    if (!isGenerated(work.change.path)) continue;
    const proof = (side: Side, line: DiffLine): ProvenLine => ({ side, line: line.line, kind: "generated", detail: "Generated file" });
    work.removed = work.change.removed.map((line) => proof("LEFT", line));
    work.added = work.change.added.map((line) => proof("RIGHT", line));
  }
  findMoves(works);
  findWhitespace(works);
  const renames = await findRenames(works, lookup);
  return {
    changes: works.map(({ change, removed, added }) => ({
      path: change.path,
      oldStart: change.oldStart,
      oldCount: change.oldCount,
      newStart: change.newStart,
      newCount: change.newCount,
      proven: [...removed, ...added].filter((line): line is ProvenLine => line !== null),
    })),
    renames,
  };
}

// --- Moves --------------------------------------------------------------------

// Added lines that match removed lines of another file, in the same order and
// with one indentation shift for the whole block. Moves within a file stay to
// review: reordering statements can change what the code does.
function findMoves(works: Work[]): void {
  const index = new Map<string, { work: Work; at: number }[]>();
  for (const work of works) {
    work.change.removed.forEach((line, at) => {
      const key = line.text.trim();
      if (key && !work.removed[at]) index.set(key, [...(index.get(key) ?? []), { work, at }]);
    });
  }
  for (const work of works) {
    const { added } = work.change;
    let i = 0;
    while (i < added.length) {
      const key = added[i]!.text.trim();
      let best: { from: Work; at: number; length: number; alnum: number } | null = null;
      if (key && !work.added[i]) {
        for (const { work: from, at } of index.get(key) ?? []) {
          if (from.change.path === work.change.path) continue;
          const match = matchBlock(work, i, from, at);
          if (!best || match.alnum > best.alnum) best = { from, at, ...match };
        }
      }
      if (!best || best.alnum < MIN_MOVED_ALNUM) {
        i++;
        continue;
      }
      for (let k = 0; k < best.length; k++) {
        const removed = best.from.change.removed[best.at + k]!;
        const add = added[i + k]!;
        work.added[i + k] = { side: "RIGHT", line: add.line, kind: "moved", detail: `Moved from ${best.from.change.oldPath}:${removed.line}` };
        best.from.removed[best.at + k] = { side: "LEFT", line: removed.line, kind: "moved", detail: `Moved to ${work.change.path}:${add.line}` };
      }
      i += best.length;
    }
  }
}

function matchBlock(to: Work, i: number, from: Work, j: number): { length: number; alnum: number } {
  const added = to.change.added;
  const removed = from.change.removed;
  let shift: number | undefined;
  let alnum = 0;
  let length = 0;
  for (; i + length < added.length && j + length < removed.length; length++) {
    if (to.added[i + length] || from.removed[j + length]) break;
    const a = added[i + length]!.text;
    const r = removed[j + length]!.text;
    if (a.trim() !== r.trim()) break;
    if (!a.trim()) continue;
    const lineShift = indent(a) - indent(r);
    if (shift === undefined) shift = lineShift;
    else if (lineShift !== shift) break;
    alnum += a.replace(/[^A-Za-z0-9]/g, "").length;
  }
  // Blank lines at the end of a block are left to the whitespace check.
  while (length > 0 && !added[i + length - 1]!.text.trim()) length--;
  return { length, alnum };
}

function indent(text: string): number {
  return text.length - text.trimStart().length;
}

// --- Whitespace ---------------------------------------------------------------

// Blank lines, and changes whose code tokens are unchanged: reindenting,
// rewrapping, trailing spaces. In indentation-sensitive files, only lines
// whose indentation is unchanged qualify.
function findWhitespace(works: Work[]): void {
  for (const work of works) {
    const { change } = work;
    const sensitive = INDENT_SENSITIVE.test(change.path);
    const mark = (side: Side, line: DiffLine, detail: string): ProvenLine => ({ side, line: line.line, kind: "whitespace", detail });
    change.removed.forEach((line, i) => {
      if (!work.removed[i] && !line.text.trim()) work.removed[i] = mark("LEFT", line, "Blank line");
    });
    change.added.forEach((line, i) => {
      if (!work.added[i] && !line.text.trim()) work.added[i] = mark("RIGHT", line, "Blank line");
    });

    const removed = open(change.removed, work.removed);
    const added = open(change.added, work.added);
    if (removed.length === 0 || added.length === 0) continue;
    const joined = (lines: { line: DiffLine }[]) => tokenize(lines.map(({ line }) => line.text).join("\n")).join(" ");
    if (!sensitive && joined(removed) === joined(added)) {
      for (const { line, at } of removed) work.removed[at] = mark("LEFT", line, "Whitespace only");
      for (const { line, at } of added) work.added[at] = mark("RIGHT", line, "Whitespace only");
      continue;
    }
    if (removed.length !== added.length) continue;
    removed.forEach((r, k) => {
      const a = added[k]!;
      if (sensitive && indent(r.line.text) !== indent(a.line.text)) return;
      if (tokenize(r.line.text).join(" ") !== tokenize(a.line.text).join(" ")) return;
      work.removed[r.at] = mark("LEFT", r.line, "Whitespace only");
      work.added[a.at] = mark("RIGHT", a.line, "Whitespace only");
    });
  }
}

// The lines of one side no check has proven yet.
function open(lines: DiffLine[], proven: (ProvenLine | null)[]): { line: DiffLine; at: number }[] {
  return lines.flatMap((line, at) => (proven[at] ? [] : [{ line, at }]));
}

// --- Renames ------------------------------------------------------------------

// Pairs of lines that differ only by identifiers, where each identifier is
// renamed the same way across the whole PR, the old name no longer appears
// anywhere in the repository, and the new name appeared nowhere before. The
// last check catches a call switched to another existing function.
async function findRenames(works: Work[], lookup: NameLookup): Promise<Rename[]> {
  type Pair = { work: Work; removedAt: number; addedAt: number; swaps: Rename[] };
  const pairs: Pair[] = [];
  for (const work of works) {
    const sensitive = INDENT_SENSITIVE.test(work.change.path);
    const removed = open(work.change.removed, work.removed);
    const added = open(work.change.added, work.added);
    if (removed.length === 0 || removed.length !== added.length) continue;
    removed.forEach((r, k) => {
      const a = added[k]!;
      if (sensitive && indent(r.line.text) !== indent(a.line.text)) return;
      const swaps = identifierSwaps(r.line.text, a.line.text);
      if (swaps) pairs.push({ work, removedAt: r.at, addedAt: a.at, swaps });
    });
  }
  if (pairs.length === 0) return [];

  const targets = new Map<string, Set<string>>();
  const sources = new Map<string, Set<string>>();
  for (const { swaps } of pairs) {
    for (const { from, to } of swaps) {
      targets.set(from, (targets.get(from) ?? new Set()).add(to));
      sources.set(to, (sources.get(to) ?? new Set()).add(from));
    }
  }
  const consistent = [...targets].flatMap(([from, tos]) => {
    const to = [...tos][0]!;
    return tos.size === 1 && sources.get(to)!.size === 1 ? [{ from, to }] : [];
  });
  const [stillThere, alreadyThere] = await Promise.all([
    lookup(consistent.map((r) => r.from), "head"),
    lookup(consistent.map((r) => r.to), "base"),
  ]);
  const proven = new Map(consistent.filter((r) => !stillThere.has(r.from) && !alreadyThere.has(r.to)).map((r) => [r.from, r.to]));

  const used = new Map<string, Rename>();
  for (const { work, removedAt, addedAt, swaps } of pairs) {
    if (!swaps.every(({ from, to }) => proven.get(from) === to)) continue;
    const detail = `Renamed ${swaps.map((s) => `${s.from} → ${s.to}`).join(", ")}`;
    work.removed[removedAt] = { side: "LEFT", line: work.change.removed[removedAt]!.line, kind: "renamed", detail };
    work.added[addedAt] = { side: "RIGHT", line: work.change.added[addedAt]!.line, kind: "renamed", detail };
    for (const swap of swaps) used.set(swap.from, swap);
  }
  return [...used.values()];
}

// The identifiers that differ between two lines with otherwise identical
// tokens, or null when anything else differs.
function identifierSwaps(before: string, after: string): Rename[] | null {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length !== b.length) return null;
  const swaps = new Map<string, string>();
  for (let k = 0; k < a.length; k++) {
    if (a[k] === b[k]) continue;
    if (!isRenameable(a[k]!) || !isRenameable(b[k]!)) return null;
    if (swaps.has(a[k]!) && swaps.get(a[k]!) !== b[k]) return null;
    swaps.set(a[k]!, b[k]!);
  }
  if (swaps.size === 0) return null;
  return [...swaps].map(([from, to]) => ({ from, to }));
}

function isRenameable(token: string): boolean {
  return IDENTIFIER.test(token) && !KEYWORDS.has(token);
}
