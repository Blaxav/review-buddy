import { expect, test } from "bun:test";
import type { Change, Triage } from "../shared/protocol";
import { assembleBlocks } from "./guide";

const change = (id: string, proven = 0): Change => ({
  id,
  path: "a.ts",
  fileHash: "",
  oldStart: 1,
  oldCount: 0,
  newStart: 1,
  newCount: 1,
  proven: proven ? [{ side: "RIGHT", line: 1, kind: "moved", detail: "" }] : [],
});

const triage: Triage = { headSha: "h", changes: [change("c1"), change("c2"), change("c3"), change("c4", 1)], renames: [] };

test("each change to review lands in exactly one block, and the rest in a last block", () => {
  const blocks = assembleBlocks(
    {
      blocks: [
        { title: "First", intent: "Does a", changes: ["c2", "c9", "c4"], checks: ["x"], outside_intent: [{ change: "c2", note: "n" }, { change: "c1", note: "elsewhere" }] },
        { title: "Again", intent: "Repeats", changes: ["c2"], checks: [], outside_intent: [] },
      ],
    },
    triage,
  );
  expect(blocks).toEqual([
    { id: "b1", title: "First", intent: "Does a", changes: ["c2"], checks: ["x"], outsideIntent: [{ change: "c2", note: "n" }] },
    { id: "b2", title: "Changes left out of the blocks", intent: expect.any(String), changes: ["c1", "c3"], checks: [], outsideIntent: [] },
  ]);
});

test("output that isn't blocks puts everything in the last block", () => {
  expect(assembleBlocks("nonsense", triage).map((b) => b.changes)).toEqual([["c1", "c2", "c3"]]);
});
