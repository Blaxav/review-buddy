import { expect, test } from "bun:test";
import { isSingleLine, parseSelectionHash, selectionFromAnchors, selectionKey } from "./selection";

const HASH = "2b7814d3fca2e99e56c51b6ff2aa313ea6e9da6424804240aa8ad891fdfe0900";

test("parses a single line", () => {
  const selection = parseSelectionHash(`#diff-${HASH}R12`);
  expect(selection).toEqual({ fileHash: HASH, startSide: "RIGHT", startLine: 12, side: "RIGHT", line: 12 });
  expect(isSingleLine(selection!)).toBe(true);
});

test("parses a range across both sides", () => {
  const selection = parseSelectionHash(`#diff-${HASH}L3-R5`);
  expect(selection).toEqual({ fileHash: HASH, startSide: "LEFT", startLine: 3, side: "RIGHT", line: 5 });
  expect(isSingleLine(selection!)).toBe(false);
  expect(selectionKey(selection!)).toBe(`${HASH}:L3-R5`);
});

test("orders a range selected upwards", () => {
  expect(parseSelectionHash(`#diff-${HASH}R15-R12`)).toMatchObject({ startLine: 12, line: 15 });
});

test("ignores file anchors and other hashes", () => {
  for (const hash of [`#diff-${HASH}`, "#discussion_r1", "", `#diff-${HASH}R`]) {
    expect(parseSelectionHash(hash)).toBeNull();
  }
});

test("builds a selection from the anchors of its first and last rows", () => {
  expect(selectionFromAnchors(`diff-${HASH}R17`, `diff-${HASH}R18`)).toEqual({
    fileHash: HASH, startSide: "RIGHT", startLine: 17, side: "RIGHT", line: 18,
  });
  expect(selectionFromAnchors(`diff-${HASH}L20`, `diff-${HASH}L20`)).toMatchObject({ startSide: "LEFT", line: 20 });
  expect(selectionFromAnchors(`diff-${HASH}R1`, `diff-${"0".repeat(64)}R2`)).toBeNull();
});
