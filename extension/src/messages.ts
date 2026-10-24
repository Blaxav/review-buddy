import type Browser from "webextension-polyfill";
import type { DraftComment, LineSelection, PrRef, ThreadInfo } from "../../shared/protocol";

// Safari exposes the promise-based `browser` namespace natively.
declare global {
  const browser: Browser.Browser;
}

// Requests from the content script to the background script, which owns the
// helper token and talks to the helper (content scripts are bound by GitHub's CSP).
export type BackgroundRequest =
  | { kind: "check" }
  | { kind: "set-token"; token: string }
  | { kind: "warm"; pr: PrRef }
  | { kind: "thread"; pr: PrRef; selection: LineSelection }
  | { kind: "stop"; pr: PrRef; selection?: LineSelection }
  | { kind: "reset"; pr: PrRef }
  | { kind: "post-comment"; pr: PrRef; comment: DraftComment };

export type BackgroundResponse =
  | { ok: true; url?: string; thread?: ThreadInfo }
  | { ok: false; error: string; reason?: "unreachable" | "token" };

export const ASK_PORT = "ask";
