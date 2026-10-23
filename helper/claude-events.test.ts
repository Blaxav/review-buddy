import { expect, test } from "bun:test";
import { mapClaudeLine } from "./claude-events";

// Lines as `claude -p --output-format stream-json --verbose --include-partial-messages` prints them.
test("maps text deltas, tool calls and the final result", () => {
  const lines = [
    { type: "system", subtype: "init", session_id: "s1" },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/a.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "1\thello" }] } },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "It says " } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello." } } },
    { type: "assistant", message: { content: [{ type: "text", text: "It says hello." }] } },
    { type: "result", subtype: "success", is_error: false, result: "It says hello." },
  ];
  expect(lines.flatMap(mapClaudeLine)).toEqual([
    { type: "tool", name: "Read", detail: "/repo/a.ts" },
    { type: "status", message: "Thinking…" },
    { type: "text", text: "It says " },
    { type: "text", text: "hello." },
    { type: "done" },
  ]);
});

test("reports a failed result as an error", () => {
  expect(mapClaudeLine({ type: "result", subtype: "error_during_execution", is_error: true })).toEqual([
    { type: "error", message: "error_during_execution" },
  ]);
});
