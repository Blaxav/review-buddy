import type { DraftComment, LineSelection, PrRef, ThreadInfo } from "../../shared/protocol";

// Requests from the content script to the background script, which owns the
// helper token and talks to the helper (content scripts are bound by GitHub's CSP).
export type BackgroundRequest =
  | { kind: "check" }
  | { kind: "warm"; pr: PrRef }
  | { kind: "thread"; pr: PrRef; selection: LineSelection }
  | { kind: "stop"; pr: PrRef; selection?: LineSelection }
  | { kind: "reset"; pr: PrRef }
  | { kind: "post-comment"; pr: PrRef; comment: DraftComment };

export type BackgroundResponse =
  | { ok: true; url?: string; thread?: ThreadInfo }
  | { ok: false; error: string };

// Streaming requests go over a port named after their helper endpoint: the
// content script posts one request and receives NDJSON events until "done",
// "blocks" or "error".
export const ASK_PORT = "ask";
export const GUIDE_PORT = "guide";
