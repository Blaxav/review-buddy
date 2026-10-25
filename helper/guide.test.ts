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

test("each change to review lands in exactly one step, and the rest in a last block", () => {
  const blocks = assembleBlocks(
    {
      blocks: [
        {
          title: "First",
          intent: "Does a",
          steps: [
            { changes: ["c2", "c9", "c4"], note: "n", check: " x ", outside_intent: true },
            { changes: ["c2"], note: "again", check: "", outside_intent: false },
          ],
        },
        { title: "Empty", intent: "", steps: [] },
      ],
    },
    triage,
  );
  expect(blocks).toEqual([
    { id: "b1", title: "First", intent: "Does a", steps: [{ changes: ["c2"], note: "n", check: "x", outsideIntent: true }] },
    {
      id: "b2",
      title: "Left out of the blocks",
      intent: expect.any(String),
      steps: [
        { changes: ["c1"], note: "", check: "", outsideIntent: false },
        { changes: ["c3"], note: "", check: "", outsideIntent: false },
      ],
    },
  ]);
});

test("output that isn't blocks puts everything in the last block", () => {
  expect(assembleBlocks("nonsense", triage).flatMap((b) => b.steps.flatMap((s) => s.changes))).toEqual(["c1", "c2", "c3"]);
});
