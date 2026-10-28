import { stripDraftComments } from "../../shared/drafts";
import type { Change, DraftComment, LineSelection, PrRef } from "../../shared/protocol";
import { icon, type IconName } from "./icons";
import { CHECK_PROMPT, DRAFT_PROMPT, EXPLAIN_PROMPT, improvePrompt, LineChat, type Turn } from "./line-chat";
import { autoGrow, h, renderMarkdown, request } from "./ui";

// One place of the smart review, as a card in GitHub's diff: what Claude says
// about the change, a conversation with Claude about its lines, a comment to
// post on them, and the walk's controls. It is built once and updated in
// place, so a half-typed question or comment survives every re-render.

// What the smart review says about the place. `here` counts the step's other
// changes in the anchor's file; `elsewhere` holds one change per other file.
export type PlaceInfo = {
  pr: PrRef;
  anchor: Change;
  title: string;
  intent: string;
  note: string;
  verify: string;
  concern: string;
  outsideIntent: boolean;
  here: number;
  elsewhere: Change[];
};

export type PlaceView = { position: number; total: number; open: boolean; checked: boolean };

export type PlaceActions = {
  open(): void;
  minimize(): void;
  setChecked(checked: boolean): void;
  previous(): void;
  next(): void;
  jump(change: Change): void;
};

type Posted = { url: string; body: string };

export class PlaceCard {
  readonly el = h("div");
  private view: PlaceView = { position: 0, total: 0, open: false, checked: false };
  private readonly chat: LineChat;
  private panel: "none" | "claude" | "comment" = "none";
  private posted: Posted[] = [];
  private posting = false;
  private postError?: string;
  private queued = false;

  // Parts rebuilt on each update; the inputs between them never move.
  private readonly line = h("button", { className: "card closed" });
  private readonly header = h("header");
  private readonly turns = h("div", { className: "turns" });
  private readonly askInput = h("textarea", { rows: 1, placeholder: "Ask Claude about these lines…" });
  private readonly sendButton = h("button", { className: "send" });
  private readonly claude: HTMLElement;
  private readonly commentInput = h("textarea", { rows: 3, placeholder: "Comment on these lines…" });
  private readonly commentStatus = h("div", { className: "comment-status" });
  private readonly commentButtons = h("div", { className: "comment-actions" });
  private readonly comment: HTMLElement;
  private readonly footer = h("footer");
  private readonly card: HTMLElement;
  private readonly resizeAsk = autoGrow(this.askInput);
  private readonly resizeComment = autoGrow(this.commentInput);

  constructor(
    private readonly info: PlaceInfo,
    private readonly actions: PlaceActions,
  ) {
    this.chat = new LineChat(info.pr, rangeOf(info.anchor), () => this.schedule(), (text) => this.useAsComment(text), primer(info));
    this.line.onclick = () => actions.open();

    this.askInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submitQuestion();
      }
    });
    this.askInput.addEventListener("focus", () => this.chat.warm());
    this.sendButton.onclick = () => (this.chat.busy ? this.chat.stop() : this.submitQuestion());
    const chip = (label: string, title: string, run: () => void, className = "chip") => h("button", { className, textContent: label, title, onclick: run });
    this.claude = h(
      "div",
      { className: "section claude" },
      h(
        "div",
        { className: "chips" },
        chip("Explain", "Explain these lines", () => this.chat.ask(EXPLAIN_PROMPT, "Explain")),
        chip("Find problems", "Look for bugs in these lines, checking how they're used", () => this.chat.ask(CHECK_PROMPT, "Find problems")),
        chip("Draft a comment", "Write a review comment from the conversation", () => this.chat.ask(DRAFT_PROMPT, "Draft a comment", true), "chip key"),
      ),
      this.turns,
      h("div", { className: "input-box" }, this.askInput, this.sendButton),
    );

    this.commentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.post();
      }
    });
    this.commentInput.addEventListener("input", () => this.renderComment());
    this.comment = h(
      "div",
      { className: "section comment" },
      h("div", { className: "section-head" }, `Comment on ${linesLabel(commentTarget(info.anchor))}`),
      this.commentInput,
      h("div", { className: "comment-foot" }, this.commentStatus, this.commentButtons),
    );

    this.card = h("section", { className: "card open" }, this.header, ...this.staticBody(), this.claude, this.comment, this.footer);
    this.el.append(this.line, this.card);
  }

  update(view: PlaceView): void {
    this.view = view;
    this.render();
  }

  focus(selector: string): void {
    this.el.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }

  // What the smart review says, which doesn't change.
  private staticBody(): HTMLElement[] {
    const { intent, note, verify, concern, here, elsewhere } = this.info;
    const body: HTMLElement[] = [];
    if (intent) body.push(h("p", { className: "intent" }, ...prose(intent)));
    if (note) body.push(h("p", { className: "note" }, ...prose(note)));
    if (verify) body.push(labelled("verify", "Verify", verify));
    if (concern) body.push(labelled("concern", "Concern", concern, "warning"));
    if (here + elsewhere.length > 0) {
      const parts: (Node | string)[] = [];
      if (here > 0) parts.push(`${here} more change${here === 1 ? "" : "s"} in this file, marked in the margin`);
      if (elsewhere.length > 0) {
        parts.push(here > 0 ? "; also " : "Also ");
        elsewhere.forEach((change, k) => {
          if (k > 0) parts.push(", ");
          parts.push(h("button", { className: "link", title: `Show ${change.path}`, onclick: () => this.actions.jump(change) }, basename(change.path)));
        });
      }
      body.push(h("p", { className: "related" }, ...parts, "."));
    }
    return body;
  }

  private render(): void {
    const { position, total, open, checked } = this.view;
    const { title, note, concern, outsideIntent } = this.info;
    this.line.hidden = open;
    this.card.hidden = !open;
    this.line.classList.toggle("checked", checked);
    this.line.title = checked ? "Checked · open this place again" : "Open this place";
    const comments = this.posted.length;
    this.line.replaceChildren(
      checked ? h("span", { className: "check-mark" }, icon("check")) : mark(),
      h("span", { className: "position", textContent: `${position} of ${total}` }),
      h("span", { className: "card-title", textContent: title }),
      h("span", { className: "grow summary-line" }, ...prose(note)),
      comments > 0 ? h("span", { className: "muted", textContent: `${comments} comment${comments === 1 ? "" : "s"}` }) : "",
      concern && !checked ? icon("warning") : "",
    );
    if (!open) return;

    this.header.replaceChildren(
      mark(),
      h("span", { className: "position", textContent: `${position} of ${total}` }),
      h("span", { className: "grow card-title", textContent: title }),
      this.info.verify ? h("span", { className: "tag focus", textContent: "Look closely" }) : "",
      outsideIntent ? h("span", { className: "tag", title: "Neither its block nor the PR description announces this change", textContent: "Not in the PR description" }) : "",
      checked ? h("span", { className: "tag done", textContent: "Checked" }) : "",
      iconButton("minimize", "Minimize", () => this.actions.minimize()),
    );
    this.card.setAttribute("aria-label", `Smart review, place ${position} of ${total}: ${title}`);
    this.claude.hidden = this.panel !== "claude";
    this.comment.hidden = this.panel !== "comment";
    this.renderTurns();
    this.renderComment();

    const toggle = (panel: "claude" | "comment", iconName: IconName, label: string, title: string) => {
      const button = h("button", { className: `ghost${this.panel === panel ? " active" : ""}`, title, onclick: () => this.toggle(panel) }, icon(iconName), label);
      button.setAttribute("aria-pressed", String(this.panel === panel));
      return button;
    };
    const checkButton = checked
      ? h("button", { title: "Mark as not checked", onclick: () => this.actions.setChecked(false) }, "Uncheck")
      : h("button", { className: "primary", title: "Mark checked, fold this card and go to the next place to check", onclick: () => this.actions.setChecked(true) }, icon("check"), "Mark checked");
    checkButton.dataset.key = "check";
    const next = h("button", { title: "Next place (])", onclick: () => this.actions.next() }, position === total ? "Finish" : "Next", icon("chevron"));
    next.dataset.key = "next";
    this.footer.replaceChildren(
      toggle("claude", "sparkle", "Ask Claude", "Talk with Claude about these lines"),
      toggle("comment", "comment", comments > 0 ? `Comment (${comments})` : "Comment", "Comment on these lines in the PR"),
      h("span", { className: "grow" }),
      h("button", { textContent: "Previous", title: "Previous place ([)", disabled: position === 1, onclick: () => this.actions.previous() }),
      next,
      checkButton,
    );
  }

  private toggle(panel: "claude" | "comment"): void {
    this.panel = this.panel === panel ? "none" : panel;
    this.render();
    if (this.panel === "claude") {
      this.chat.warm();
      this.askInput.focus({ preventScroll: true });
    } else if (this.panel === "comment") {
      this.commentInput.focus({ preventScroll: true });
    }
    this.reveal();
  }

  // Scrolls just enough to show the whole card, as a section opens under the code.
  private reveal(): void {
    requestAnimationFrame(() => this.card.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  private submitQuestion(): void {
    const text = this.askInput.value.trim();
    if (!text || this.chat.busy) return;
    this.askInput.value = "";
    this.resizeAsk();
    this.chat.ask(text, text);
  }

  // Claude's answers stream token by token: render at most once per frame.
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  private renderTurns(): void {
    const atBottom = this.turns.scrollHeight - this.turns.scrollTop - this.turns.clientHeight < 40;
    this.turns.replaceChildren(...this.chat.turns.map((turn) => this.renderTurn(turn)));
    if (this.chat.error) this.turns.append(h("div", { className: "error", textContent: this.chat.error }));
    this.turns.hidden = this.turns.childElementCount === 0;
    this.sendButton.replaceChildren(icon(this.chat.busy ? "stop" : "send"));
    this.sendButton.title = this.chat.busy ? "Stop" : "Ask (Enter)";
    this.sendButton.ariaLabel = this.sendButton.title;
    if (atBottom) this.turns.scrollTop = this.turns.scrollHeight;
  }

  private renderTurn(turn: Turn): HTMLElement {
    const el = h("div", { className: "turn" }, h("div", { className: "question", textContent: turn.label }));
    if (turn.answer) el.append(renderMarkdown(stripDraftComments(turn.answer)));
    if (turn.status) el.append(h("div", { className: "status", textContent: turn.status }));
    if (turn.error) el.append(h("div", { className: "error", textContent: turn.error }));
    if (!turn.streaming && !turn.error && turn.answer && !turn.fill) {
      el.append(
        h("button", { className: "use", title: "Put this answer in the comment", onclick: () => this.useAsComment(stripDraftComments(turn.answer)) }, icon("insert"), "Use as comment"),
      );
    }
    return el;
  }

  private useAsComment(text: string): void {
    this.commentInput.value = text;
    this.resizeComment();
    this.panel = "comment";
    this.render();
    this.reveal();
  }

  private renderComment(): void {
    const body = this.commentInput.value.trim();
    this.commentStatus.replaceChildren(
      ...this.posted.map(({ url }) => h("a", { href: url, target: "_blank", rel: "noopener noreferrer", className: "posted" }, icon("check"), "Commented · view on GitHub")),
      this.postError ? h("span", { className: "error", textContent: this.postError }) : "",
    );
    const improve = h("button", {
      textContent: "Improve with Claude",
      title: "Ask Claude to make the comment clear, specific and kind",
      disabled: !body || this.chat.busy,
      onclick: () => {
        this.panel = "claude";
        this.chat.ask(improvePrompt(body), "Improve my comment", true);
      },
    });
    const post = h(
      "button",
      { className: "primary", title: "Post this comment on the PR (⌘Enter)", disabled: !body || this.posting, onclick: () => void this.post() },
      this.posting ? "Posting…" : "Comment",
    );
    this.commentButtons.replaceChildren(improve, post);
  }

  private async post(): Promise<void> {
    const body = this.commentInput.value.trim();
    if (!body || this.posting) return;
    this.posting = true;
    this.postError = undefined;
    this.render();
    const res = await request({ kind: "post-comment", pr: this.info.pr, comment: { ...commentTarget(this.info.anchor), body } });
    this.posting = false;
    if (res.ok) {
      this.posted.push({ url: res.url ?? "", body });
      this.commentInput.value = "";
      this.resizeComment();
    } else {
      this.postError = res.error;
    }
    this.render();
  }
}

// The lines Claude talks about: the whole change, from its first removed line
// to its last added one.
function rangeOf(change: Change): LineSelection {
  const { fileHash } = change;
  if (change.oldCount > 0 && change.newCount > 0) {
    return { fileHash, startSide: "LEFT", startLine: change.oldStart, side: "RIGHT", line: change.newStart + change.newCount - 1 };
  }
  const [side, start, count] = change.newCount > 0 ? (["RIGHT", change.newStart, change.newCount] as const) : (["LEFT", change.oldStart, change.oldCount] as const);
  return { fileHash, startSide: side, startLine: start, side, line: start + count - 1 };
}

// Where a comment goes: the change's added lines, so a ```suggestion applies to
// them, or its removed lines when it only removes.
function commentTarget(change: Change): Omit<DraftComment, "body"> {
  const [side, start, count] = change.newCount > 0 ? (["RIGHT", change.newStart, change.newCount] as const) : (["LEFT", change.oldStart, change.oldCount] as const);
  const end = start + count - 1;
  return count > 1 ? { path: change.path, side, line: end, startLine: start } : { path: change.path, side, line: end };
}

// What the smart review told the reviewer about these lines, given to Claude
// with the first question.
function primer(info: PlaceInfo): string {
  const lines = [`The smart review sent the reviewer to these lines as "${info.title}".`];
  if (info.note) lines.push(`Its note: ${info.note}`);
  if (info.verify) lines.push(`What it asks the reviewer to verify: ${info.verify}`);
  if (info.concern) lines.push(`The concern it raised: ${info.concern}`);
  return lines.join("\n");
}

function linesLabel({ path, line, startLine }: Omit<DraftComment, "body">): string {
  return startLine !== undefined ? `${basename(path)}, lines ${startLine}–${line}` : `${basename(path)}, line ${line}`;
}

function labelled(kind: string, label: string, text: string, iconName?: IconName): HTMLElement {
  return h("p", { className: `line ${kind}` }, h("span", { className: "label" }, iconName ? icon(iconName) : "", label), h("span", {}, ...prose(text)));
}

// Claude's text, with its `code` spans set in code.
export function prose(text: string): (Node | string)[] {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 === 1 ? h("code", { textContent: part }) : part));
}

function mark(): HTMLElement {
  return h("span", { className: "mark" }, icon("sparkle"));
}

function iconButton(name: IconName, label: string, onclick: () => void): HTMLButtonElement {
  return h("button", { className: "icon-button", title: label, ariaLabel: label, onclick }, icon(name));
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
