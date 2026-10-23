import { expect, test } from "bun:test";
import { parseDiffRows, parseNameStatus, selectRows } from "./diff";

const DIFF = `diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,4 @@
 one
-two
+deux
+deux bis
 three
\\ No newline at end of file
`;

const select = (startSide: "LEFT" | "RIGHT", startLine: number, side: "LEFT" | "RIGHT", line: number) =>
  selectRows(parseDiffRows(DIFF), { fileHash: "", startSide, startLine, side, line });

test("numbers each row on its sides", () => {
  expect(parseDiffRows(DIFF)).toEqual([
    { kind: "context", oldLine: 1, newLine: 1, text: "one" },
    { kind: "del", oldLine: 2, text: "two" },
    { kind: "add", newLine: 2, text: "deux" },
    { kind: "add", newLine: 3, text: "deux bis" },
    { kind: "context", oldLine: 3, newLine: 4, text: "three" },
  ]);
});

test("selects a range within one side, and one that spans both", () => {
  expect(select("RIGHT", 2, "RIGHT", 3).map((row) => row.text)).toEqual(["deux", "deux bis"]);
  expect(select("LEFT", 2, "RIGHT", 2).map((row) => row.text)).toEqual(["two", "deux"]);
  expect(select("RIGHT", 4, "RIGHT", 4).map((row) => row.text)).toEqual(["three"]);
});

test("selects nothing for a line outside the diff", () => {
  expect(select("RIGHT", 2, "RIGHT", 40)).toEqual([]);
});

test("reads renames and plain changes from name-status", () => {
  expect(parseNameStatus("M\0a.ts\0R087\0old/b.ts\0new/b.ts\0D\0c.ts\0")).toEqual([
    { oldPath: "a.ts", newPath: "a.ts" },
    { oldPath: "old/b.ts", newPath: "new/b.ts" },
    { oldPath: "c.ts", newPath: "c.ts" },
  ]);
});
