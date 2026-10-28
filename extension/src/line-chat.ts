import browser, { type Runtime } from "webextension-polyfill";
import { commentFromAnswer } from "../../shared/drafts";
import type { AskRequest, LineSelection, PrRef, StreamEvent } from "../../shared/protocol";
import { ASK_PORT } from "./messages";
import { request } from "./ui";

// A conversation with Claude about one range of lines, shared by GitHub's
// comment box and the smart review's cards. The helper keeps one Claude
// process per range, so follow-up questions answer quickly.

export const EXPLAIN_PROMPT = "Explain what these lines do and why they changed.";
export const CHECK_PROMPT = "Is anything wrong with these lines? Check how they're used elsewhere in the repository.";
const WRITE_RULES =
  "Reply with only the comment body in Markdown: no preamble and no review-comments block. " +
  "When you propose replacement code for exactly the selected lines, put it in a ```suggestion block.";
export const DRAFT_PROMPT = `Write the review comment on the selected lines, based on what we discussed. Keep it short and specific. ${WRITE_RULES}`;

export function improvePrompt(comment: string): string {
  return `Here is my draft review comment on these lines:\n<draft>\n${comment}\n</draft>\n\nRewrite it to be clear, specific and kind, keeping my intent, and correct anything it gets wrong about the code. ${WRITE_RULES}`;
}

export type Turn = {
  label: string;
  answer: string;
  status?: string;
  error?: string;
  streaming: boolean;
  // Claude's text after a tool call starts a new paragraph.
  breakBeforeText: boolean;
  // The answer is a comment: hand it to `onComment` when it completes.
  fill: boolean;
};

export class LineChat {
  turns: Turn[] = [];
  error?: string;
  private port: Runtime.Port | null = null;
  private warmed = false;

  // `onChange` runs on every update, `onComment` with the comment an answer
  // asked to write. `context` prefixes the first question, then is dropped.
  constructor(
    readonly pr: PrRef,
    readonly selection: LineSelection,
    private readonly onChange: () => void,
    private readonly onComment: (comment: string) => void,
    private context = "",
  ) {}

  get busy(): boolean {
    return this.port !== null;
  }

  // Starts this range's Claude process while the reviewer reads, so the first answer is quick.
  warm(): void {
    if (this.warmed) return;
    this.warmed = true;
    void request({ kind: "thread", pr: this.pr, selection: this.selection }).then((res) => {
      if (res.ok) return;
      this.warmed = false;
      this.error = res.error;
      this.onChange();
    });
  }

  ask(question: string, label: string, fill = false): void {
    if (this.port) return;
    this.error = undefined;
    const turn: Turn = { label, answer: "", streaming: true, breakBeforeText: false, fill };
    this.turns.push(turn);
    const port = browser.runtime.connect({ name: ASK_PORT });
    this.port = port;
    port.onMessage.addListener((event: unknown) => this.onEvent(turn, event as StreamEvent));
    port.onDisconnect.addListener(() => {
      if (turn.streaming) this.onEvent(turn, { type: "error", message: "Lost the connection to the extension." });
    });
    const full = this.context ? `${this.context}\n\n${question}` : question;
    this.context = "";
    port.postMessage({ pr: this.pr, question: full, selection: this.selection } satisfies AskRequest);
    this.onChange();
  }

  stop(): void {
    void request({ kind: "stop", pr: this.pr, selection: this.selection });
  }

  fail(message: string): void {
    this.error = message;
    this.onChange();
  }

  private onEvent(turn: Turn, event: StreamEvent): void {
    switch (event.type) {
      case "status":
        turn.status = event.message;
        break;
      case "tool":
        turn.status = `${event.name} ${event.detail}`.trim();
        turn.breakBeforeText = true;
        break;
      case "text":
        turn.answer += (turn.breakBeforeText && turn.answer ? "\n\n" : "") + event.text;
        turn.breakBeforeText = false;
        turn.status = undefined;
        break;
      case "done":
      case "error":
        turn.streaming = false;
        turn.status = undefined;
        if (event.type === "error") turn.error = event.message;
        else if (turn.fill) this.onComment(commentFromAnswer(turn.answer));
        this.port?.disconnect();
        this.port = null;
        break;
    }
    this.onChange();
  }
}
