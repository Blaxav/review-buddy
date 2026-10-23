// Messages exchanged between the extension and the local helper.

export const HELPER_PORT = 47823;
export const HELPER_URL = `http://127.0.0.1:${HELPER_PORT}`;

export type PrRef = { owner: string; repo: string; number: number };

export type Side = "LEFT" | "RIGHT";

// Diff lines the user selected on GitHub. `fileHash` is the SHA-256 of the
// file path, which is how GitHub names a file in its diff anchors.
export type LineSelection = { fileHash: string; startSide: Side; startLine: number; side: Side; line: number };

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
  side: Side;
  startLine?: number;
  startSide?: Side;
  body: string;
};

// One row of a file's diff; removed rows have only `oldLine`, added rows only `newLine`.
export type DiffRow = { kind: "context" | "add" | "del"; oldLine?: number; newLine?: number; text: string };

// The selected lines of a line thread, resolved against the checkout.
export type ThreadInfo = { path: string; rows: DiffRow[] };

// `selection` scopes the request to the line thread on those lines; without
// it, the request is about the PR chat.
export type AskRequest = { pr: PrRef; question: string; selection?: LineSelection };
export type PrRequest = { pr: PrRef; selection?: LineSelection };
export type ThreadRequest = { pr: PrRef; selection: LineSelection };
export type PostCommentRequest = { pr: PrRef; comment: DraftComment };
export type PostCommentResponse = { url: string };
