import { expect, test } from "bun:test";
import { classify, parseChanges, tokenize, type NameLookup } from "./triage";

const noNames: NameLookup = async () => new Set();

function diff(...files: string[]): string {
  return files.join("");
}

function file(oldPath: string | null, newPath: string | null, hunks: string): string {
  const a = oldPath ? `a/${oldPath}` : "/dev/null";
  const b = newPath ? `b/${newPath}` : "/dev/null";
  return `diff --git a/${oldPath ?? newPath} b/${newPath ?? oldPath}\nindex 1..2 100644\n--- ${a}\n+++ ${b}\n${hunks}`;
}

async function kinds(text: string, lookup = noNames, generated: string[] = []) {
  const { changes, renames } = await classify(parseChanges(text), (p) => generated.includes(p), lookup);
  return {
    renames,
    lines: changes.map((c) => `${c.path} ${c.proven.map((l) => `${l.side[0]}${l.line}:${l.kind}`).join(" ")}`.trim()),
  };
}

test("parses hunks with their line numbers", () => {
  const changes = parseChanges(file("a.ts", "a.ts", "@@ -2 +2,2 @@ ctx\n-old\n+new\n+more\n@@ -9,0 +11 @@\n+tail\n"));
  expect(changes).toEqual([
    { path: "a.ts", oldPath: "a.ts", oldStart: 2, oldCount: 1, newStart: 2, newCount: 2, removed: [{ line: 2, text: "old" }], added: [{ line: 2, text: "new" }, { line: 3, text: "more" }] },
    { path: "a.ts", oldPath: "a.ts", oldStart: 9, oldCount: 0, newStart: 11, newCount: 1, removed: [], added: [{ line: 11, text: "tail" }] },
  ]);
});

test("names a deleted file by its old path", () => {
  expect(parseChanges(file("gone.ts", null, "@@ -1 +0,0 @@\n-x\n"))[0]!.path).toBe("gone.ts");
});

test("tokens ignore whitespace but keep it inside strings", () => {
  expect(tokenize(`foo( "a  b",x )`)).toEqual(["foo", "(", `"a  b"`, ",", "x", ")"]);
});

const MOVED = [
  "export function formatPrice(value: number): string {",
  "  return value.toFixed(2) + ' EUR';",
  "}",
];

test("code moved to another file, reindented, is proven on both sides", async () => {
  const text = diff(
    file("a.ts", "a.ts", `@@ -6,4 +5,0 @@\n-\n${MOVED.map((l) => `-${l}`).join("\n")}\n`),
    file(null, "c.ts", `@@ -0,0 +1,3 @@\n${MOVED.map((l) => `+  ${l}`).join("\n")}\n`),
  );
  expect((await kinds(text)).lines).toEqual([
    "a.ts L6:whitespace L7:moved L8:moved L9:moved",
    "c.ts R1:moved R2:moved R3:moved",
  ]);
});

test("a moved block whose lines changed indentation unevenly stays to review", async () => {
  const text = diff(
    file("a.py", "a.py", "@@ -1,2 +0,0 @@\n-for item in all_the_items:\n-    total_value += item\n"),
    file(null, "b.py", "@@ -0,0 +1,2 @@\n+for item in all_the_items:\n+total_value += item\n"),
  );
  expect((await kinds(text)).lines).toEqual(["a.py L1:moved", "b.py R1:moved"]);
});

test("statements reordered within a file stay to review", async () => {
  const text = file("b.ts", "b.ts", "@@ -2 +1,0 @@\n-  validateTheIncomingRequest(request);\n@@ -3,0 +3 @@\n+  validateTheIncomingRequest(request);\n");
  expect((await kinds(text)).lines).toEqual(["b.ts", "b.ts"]);
});

test("short lines don't count as a move", async () => {
  const text = diff(file("a.ts", "a.ts", "@@ -1 +0,0 @@\n-  return x;\n"), file("b.ts", "b.ts", "@@ -0,0 +1 @@\n+  return x;\n"));
  expect((await kinds(text)).lines).toEqual(["a.ts", "b.ts"]);
});

test("rewrapped code is whitespace, a changed token is not", async () => {
  const text = file("a.ts", "a.ts", "@@ -1 +1,3 @@\n-call(a, b)\n+call(\n+  a,\n+  b)\n@@ -5 +7 @@\n-call(a, 1)\n+call(a, 2)\n");
  expect((await kinds(text)).lines).toEqual(["a.ts L1:whitespace R1:whitespace R2:whitespace R3:whitespace", "a.ts"]);
});

test("reindenting Python is not whitespace", async () => {
  const text = file("a.py", "a.py", "@@ -2 +2 @@\n-    run()\n+        run()\n");
  expect((await kinds(text)).lines).toEqual(["a.py"]);
});

test("a consistent rename to a fresh name is proven", async () => {
  const text = diff(
    file("a.ts", "a.ts", "@@ -1 +1 @@\n-export function computeTotal(items) {\n+export function computeSum(items) {\n"),
    file("b.ts", "b.ts", "@@ -3 +3 @@\n-  const t = computeTotal(cart);\n+  const t = computeSum(cart);\n"),
  );
  const result = await kinds(text);
  expect(result.lines).toEqual(["a.ts L1:renamed R1:renamed", "b.ts L3:renamed R3:renamed"]);
  expect(result.renames).toEqual([{ from: "computeTotal", to: "computeSum" }]);
});

test("a rename is not proven when the old name is still used or the new one existed", async () => {
  const text = file("a.ts", "a.ts", "@@ -1 +1 @@\n-  return computeTotal(cart);\n+  return computeSum(cart);\n");
  const stillUsed: NameLookup = async (names, at) => new Set(at === "head" ? names : []);
  const existed: NameLookup = async (names, at) => new Set(at === "base" ? names : []);
  expect((await kinds(text, stillUsed)).lines).toEqual(["a.ts"]);
  expect((await kinds(text, existed)).lines).toEqual(["a.ts"]);
});

test("inconsistent renames, keywords and string changes are not renames", async () => {
  const inconsistent = diff(
    file("a.ts", "a.ts", "@@ -1 +1 @@\n-run(alpha)\n+run(beta)\n"),
    file("b.ts", "b.ts", "@@ -1 +1 @@\n-run(alpha)\n+run(gamma)\n"),
  );
  expect((await kinds(inconsistent)).lines).toEqual(["a.ts", "b.ts"]);
  expect((await kinds(file("a.ts", "a.ts", "@@ -1 +1 @@\n-let x = 1;\n+const x = 1;\n"))).lines).toEqual(["a.ts"]);
  expect((await kinds(file("a.ts", "a.ts", "@@ -1 +1 @@\n-mode = 'read'\n+mode = 'write'\n"))).lines).toEqual(["a.ts"]);
});

test("generated files are proven whole", async () => {
  const text = file("bun.lock", "bun.lock", "@@ -1 +1 @@\n-a\n+b\n");
  expect((await kinds(text, noNames, ["bun.lock"])).lines).toEqual(["bun.lock L1:generated R1:generated"]);
});
