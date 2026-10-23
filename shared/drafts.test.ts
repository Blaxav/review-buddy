import { describe, expect, test } from "bun:test";
import { parseDraftComments, stripDraftComments } from "./drafts";

const answer = `Two issues.

\`\`\`review-comments
[
  {"path": "src/a.ts", "line": 12, "side": "RIGHT", "body": "Off by one."},
  {"path": "src/b.ts", "line": 7, "start_line": 3, "side": "LEFT", "body": "Why remove this?"},
  {"path": "src/c.ts", "line": 0, "body": "invalid line"},
  {"line": 4, "body": "missing path"}
]
\`\`\`

That's it.`;

describe("parseDraftComments", () => {
  test("keeps valid comments and drops malformed ones", () => {
    expect(parseDraftComments(answer)).toEqual([
      { path: "src/a.ts", line: 12, side: "RIGHT", body: "Off by one." },
      { path: "src/b.ts", line: 7, startLine: 3, side: "LEFT", body: "Why remove this?" },
    ]);
  });

  test("defaults the side to RIGHT and ignores a start_line after line", () => {
    const text = '```review-comments\n[{"path": "a", "line": 2, "start_line": 5, "body": "x"}]\n```';
    expect(parseDraftComments(text)).toEqual([{ path: "a", line: 2, side: "RIGHT", body: "x" }]);
  });

  test("keeps a range that starts on the other side", () => {
    const text = '```review-comments\n[{"path": "a", "line": 2, "side": "RIGHT", "start_line": 9, "start_side": "LEFT", "body": "x"}]\n```';
    expect(parseDraftComments(text)).toEqual([{ path: "a", line: 2, side: "RIGHT", startLine: 9, startSide: "LEFT", body: "x" }]);
  });

  test("skips a block that isn't valid JSON", () => {
    expect(parseDraftComments("```review-comments\n[{oops\n```")).toEqual([]);
  });
});

describe("stripDraftComments", () => {
  test("removes complete blocks", () => {
    expect(stripDraftComments(answer)).toBe("Two issues.\n\n\n\nThat's it.");
  });

  test("hides a block that is still streaming in", () => {
    expect(stripDraftComments('Here:\n```review-comments\n[{"path": "a"')).toBe("Here:");
  });
});
