import { expect, test } from "bun:test";
import type { Change, Triage } from "../shared/protocol";
import { assembleGuide } from "./guide";

const change = (id: string, { proven = false, importsOnly = false, path = "a.ts" } = {}): Change => ({
  id,
  path,
  fileHash: "",
  oldStart: 1,
  oldCount: 0,
  newStart: 1,
  newCount: 1,
  proven: proven ? [{ side: "RIGHT", line: 1, kind: "moved", detail: "" }] : [],
  importsOnly,
});

const triage: Triage = { headSha: "h", changes: [change("c1"), change("c2"), change("c3"), change("c4", { proven: true })], renames: [] };

const step = (changes: string[], more: Record<string, unknown> = {}) => ({ changes, anchor: "", note: "", check: "", skim: false, outside_intent: false, ...more });

test("each change to review lands in exactly one step, and the rest in a last block", () => {
  const guide = assembleGuide(
    {
      summary: " Does a. ",
      focus: [],
      blocks: [
        { title: "First", intent: "Does a", steps: [step(["c2", "c9", "c4"], { note: "n", check: " x ", outside_intent: true }), step(["c2"], { note: "again" })] },
        { title: "Empty", intent: "", steps: [] },
      ],
    },
    triage,
  );
  expect(guide.summary).toBe("Does a.");
  expect(guide.blocks).toEqual([
    { id: "b1", title: "First", intent: "Does a", steps: [{ changes: ["c2"], anchor: "c2", note: "n", check: "x", skim: false, outsideIntent: true }] },
    {
      id: "b2",
      title: "Left out of the blocks",
      intent: expect.any(String),
      steps: [
        { changes: ["c1"], anchor: "c1", note: "", check: "", skim: false, outsideIntent: false },
        { changes: ["c3"], anchor: "c3", note: "", check: "", skim: false, outsideIntent: false },
      ],
    },
  ]);
});

test("output that isn't a guide puts everything in the last block", () => {
  const guide = assembleGuide("nonsense", triage);
  expect(guide.summary).toBe("");
  expect(guide.blocks.flatMap((b) => b.steps.flatMap((s) => s.changes))).toEqual(["c1", "c2", "c3"]);
});

const withImports: Triage = {
  headSha: "h",
  changes: [
    change("c1", { importsOnly: true, path: "a.py" }),
    change("c2", { path: "a.py" }),
    change("c3", { path: "a.py" }),
    change("c4", { importsOnly: true, path: "a.py" }),
    change("c5", { importsOnly: true, path: "b.py" }),
  ],
  renames: [],
};

test("a step scrolls to the change its note is about, never to an import", () => {
  const blocks = assembleGuide(
    { blocks: [{ title: "T", intent: "", steps: [step(["c1", "c2", "c3"], { anchor: "c3" }), step(["c4", "c5"], { anchor: "c4" })] }] },
    withImports,
  ).blocks;
  expect(blocks[0]!.steps.map((s) => [s.anchor, s.skim])).toEqual([
    ["c3", false],
    ["c4", true],
  ]);
  const fallback = assembleGuide({ blocks: [{ title: "T", intent: "", steps: [step(["c1", "c2", "c3", "c4", "c5"], { anchor: "c1" })] }] }, withImports);
  expect(fallback.blocks[0]!.steps[0]!.anchor).toBe("c2");
});

test("an import change left out joins a step in its file", () => {
  const blocks = assembleGuide({ blocks: [{ title: "T", intent: "", steps: [step(["c2", "c3"])] }] }, withImports).blocks;
  expect(blocks[0]!.steps[0]!.changes).toEqual(["c2", "c3", "c1", "c4"]);
  expect(blocks[1]!.steps.map((s) => s.changes)).toEqual([["c5"]]);
});

test("the briefing keeps at most one focus point per step, on placed code, with a reason", () => {
  const { focus } = assembleGuide(
    {
      focus: [
        { change: "c2", why: "Check the default." },
        { change: "c3", why: "Same step as c2." },
        { change: "c1", why: "An import." },
        { change: "c9", why: "Unknown." },
        { change: "c5", why: "" },
      ],
      blocks: [{ title: "T", intent: "", steps: [step(["c1", "c2", "c3"]), step(["c4", "c5"])] }],
    },
    withImports,
  );
  expect(focus).toEqual([{ change: "c2", why: "Check the default." }]);
});
