import type { StreamEvent } from "../shared/protocol";

// The subset of `claude --output-format stream-json --include-partial-messages`
// lines the overlay needs.
type ClaudeLine =
  | {
      type: "stream_event";
      event: { type: string; content_block?: { type: string }; delta?: { type: string; text?: string } };
    }
  | { type: "assistant"; message: { content: { type: string; name?: string; input?: Record<string, unknown> }[] } }
  | { type: "result"; is_error: boolean; subtype?: string; result?: string }
  | { type: "other" };

export function mapClaudeLine(json: unknown): StreamEvent[] {
  const line = json as ClaudeLine;
  switch (line.type) {
    case "stream_event": {
      const { event } = line;
      if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
        return [{ type: "status", message: "Thinking…" }];
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        return [{ type: "text", text: event.delta.text ?? "" }];
      }
      return [];
    }
    case "assistant":
      return line.message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ type: "tool", name: block.name ?? "tool", detail: describeToolInput(block.input) }));
    case "result":
      return line.is_error
        ? [{ type: "error", message: line.result ?? line.subtype ?? "Claude failed" }]
        : [{ type: "done" }];
    default:
      return [];
  }
}

function describeToolInput(input: Record<string, unknown> | undefined): string {
  const value = input?.command ?? input?.file_path ?? input?.pattern ?? input?.path ?? "";
  return String(value).slice(0, 200);
}
