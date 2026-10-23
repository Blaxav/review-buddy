// Messages exchanged between the extension and the local helper.

export const HELPER_PORT = 47823;
export const HELPER_URL = `http://127.0.0.1:${HELPER_PORT}`;

export type PrRef = { owner: string; repo: string; number: number };

export function prKey(pr: PrRef): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

// One line of the NDJSON stream returned by POST /ask.
export type StreamEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "done" }
  | { type: "error"; message: string };

// A review comment Claude proposes; it is only posted when the user clicks Post.
// `line` is a line of the head file (side RIGHT) or of the base file (side LEFT).
export type DraftComment = {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  body: string;
};

export type AskRequest = { pr: PrRef; question: string };
export type PrRequest = { pr: PrRef };
export type PostCommentRequest = { pr: PrRef; comment: DraftComment };
export type PostCommentResponse = { url: string };
