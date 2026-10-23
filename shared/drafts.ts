import type { DraftComment } from "./protocol";

// Claude returns proposed comments as JSON inside ```review-comments fences.
const FENCE = /```review-comments[^\n]*\n([\s\S]*?)```/g;

export function parseDraftComments(text: string): DraftComment[] {
  const drafts: DraftComment[] = [];
  for (const match of text.matchAll(FENCE)) {
    let items: unknown;
    try {
      items = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const draft = toDraft(item);
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}

// Removes the fences, including one still streaming in, so the drafts render
// only as cards.
export function stripDraftComments(text: string): string {
  return text.replace(FENCE, "").replace(/```review-comments[\s\S]*$/, "").trim();
}

function toDraft(item: unknown): DraftComment | null {
  if (typeof item !== "object" || item === null) return null;
  const { path, line, side, start_line, body } = item as Record<string, unknown>;
  if (typeof path !== "string" || typeof body !== "string") return null;
  if (!Number.isInteger(line) || (line as number) < 1) return null;
  const draft: DraftComment = {
    path,
    line: line as number,
    side: side === "LEFT" ? "LEFT" : "RIGHT",
    body,
  };
  if (Number.isInteger(start_line) && (start_line as number) < draft.line) {
    draft.startLine = start_line as number;
  }
  return draft;
}
