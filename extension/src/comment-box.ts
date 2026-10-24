import { commentFromAnswer, stripDraftComments } from "../../shared/drafts";
import { prKey, type AskRequest, type LineSelection, type PrRef, type StreamEvent } from "../../shared/protocol";
import { selectionFromAnchors, selectionKey } from "../../shared/selection";
import css from "./comment-box.css" with { type: "text" };
import { icon } from "./icons";
import { ASK_PORT } from "./messages";
import { parsePrPath } from "./pr-path";
import theme from "./theme.css" with { type: "text" };
import { autoGrow, h, isolateEvents, renderMarkdown, request } from "./ui";
import type Browser from "webextension-polyfill";

// GitHub's box for a new review comment on the lines selected in the diff.
const BOX = '[data-marker-id="new-comment"]';
const STRIP = "review-ai-strip";

const EXPLAIN_PROMPT = "Explain what these lines do and why they changed.";
const CHECK_PROMPT = "Is anything wrong with these lines? Check how they're used elsewhere in the repository.";
const WRITE_RULES =
  "Reply with only the comment body in Markdown: no preamble and no review-comments block. " +
  "When you propose replacement code for exactly the selected lines, put it in a ```suggestion block.";
const DRAFT_PROMPT = `Write the review comment on the selected lines, based on what we discussed. Keep it short and specific. ${WRITE_RULES}`;

function improvePrompt(comment: string): string {
  return `Here is my draft review comment on these lines:\n<draft>\n${comment}\n</draft>\n\nRewrite it to be clear, specific and kind, keeping my intent, and correct anything it gets wrong about the code. ${WRITE_RULES}`;
}

type Turn = {
  label: string;
  answer: string;
  status?: string;
  error?: string;
  streaming: boolean;
  // Claude's text after a tool call starts a new paragraph.
  breakBeforeText: boolean;
  // The answer is the comment: write it into GitHub's box when it completes.
  fill: boolean;
};

// The conversation about one range of lines. It outlives the box: GitHub
// unmounts diff rows scrolled out of view, and the box can be closed and reopened.
type BoxChat = {
  pr: PrRef;
  selection: LineSelection;
  turns: Turn[];
  port: Browser.Runtime.Port | null;
  warmed: boolean;
  error?: string;
  box: Element;
  turnsEl: HTMLElement;
  sendButton: HTMLButtonElement;
};

const chats = new Map<string, BoxChat>();

export function watchCommentBoxes(): void {
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
}

function scan(): void {
  const pr = parsePrPath(location.pathname);
  if (!pr) return;
  for (const box of document.querySelectorAll(BOX)) {
    if (!box.querySelector(`:scope > .${STRIP}`)) mount(pr, box);
  }
}

// The box sits in the last selected row; the range starts at the first row of
// the selected run. In the split view, the box's cell says which side it is on.
function boxSelection(box: Element): LineSelection | null {
  const cell = box.closest("td");
  const row = cell?.closest("tr");
  if (!cell || !row) return null;
  const side = cell.classList.contains("right-side") ? "right-side" : "left-side";
  const anchor = (tr: Element) => tr.querySelector(`td.${side}[data-line-anchor]`)?.getAttribute("data-line-anchor");
  let first: Element = row;
  if (row.getAttribute("data-row-selected") === "true") {
    while (first.previousElementSibling?.getAttribute("data-row-selected") === "true") first = first.previousElementSibling;
  }
  const start = anchor(first);
  const end = anchor(row);
  return start && end ? selectionFromAnchors(start, end) : null;
}

function mount(pr: PrRef, box: Element): void {
  const selection = boxSelection(box);
  if (!selection) return;
  const host = h("div", { className: STRIP });
  const root = host.attachShadow({ mode: "open" });
  // Clicks too: GitHub's diff grid treats clicks in a row as line selection.
  isolateEvents(root, ["keydown", "keyup", "keypress", "mousedown", "mouseup", "pointerdown", "click"]);

  const input = h("textarea", { rows: 1, placeholder: "Ask Claude about these lines…" });
  const resizeInput = autoGrow(input);
  const sendButton = h("button", { className: "send", ariaLabel: "Ask" });
  const turnsEl = h("div", { className: "turns" });
  const key = `${prKey(pr)} ${selectionKey(selection)}`;
  const chat: BoxChat = chats.get(key) ?? { pr, selection, turns: [], port: null, warmed: false, box, turnsEl, sendButton };
  Object.assign(chat, { box, turnsEl, sendButton });
  chats.set(key, chat);

  const submit = () => {
    const text = input.value.trim();
    if (!text || chat.port) return;
    input.value = "";
    resizeInput();
    ask(chat, text, text, false);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  sendButton.onclick = () => (chat.port ? void request({ kind: "stop", pr, selection }) : submit());

  const chip = (label: string, title: string, run: () => void, className = "chip") =>
    h("button", { className, textContent: label, title, onclick: run });
  root.append(
    h("style", { textContent: theme + css }),
    h(
      "div",
      { className: "strip" },
      h(
        "div",
        { className: "bar" },
        h("span", { className: "brand" }, h("span", { className: "mark" }, icon("sparkle")), "Claude"),
        chip("Explain", "Explain these lines", () => ask(chat, EXPLAIN_PROMPT, "Explain", false)),
        chip("Find problems", "Look for bugs in these lines", () => ask(chat, CHECK_PROMPT, "Find problems", false)),
        chip("Draft comment", "Write the comment from the conversation", () => ask(chat, DRAFT_PROMPT, "Draft comment", true), "chip key"),
        chip("Improve my comment", "Rewrite what you typed below", () => improve(chat)),
      ),
      turnsEl,
      h("div", { className: "ask" }, h("div", { className: "input-box" }, input, sendButton)),
    ),
  );
  box.prepend(host);
  render(chat);
  warm(chat);
}

// Starts this range's Claude process while the reviewer reads, so the first answer is quick.
function warm(chat: BoxChat): void {
  if (chat.warmed) return;
  chat.warmed = true;
  void request({ kind: "thread", pr: chat.pr, selection: chat.selection }).then((res) => {
    if (res.ok) return;
    chat.warmed = false;
    chat.error = res.error;
    render(chat);
  });
}

function improve(chat: BoxChat): void {
  const comment = chat.box.querySelector("textarea")?.value.trim();
  if (comment) ask(chat, improvePrompt(comment), "Improve my comment", true);
  else showError(chat, "Write a comment in the box below first.");
}

function showError(chat: BoxChat, message: string): void {
  chat.error = message;
  render(chat);
}

function ask(chat: BoxChat, question: string, label: string, fill: boolean): void {
  if (chat.port) return;
  chat.error = undefined;
  const turn: Turn = { label, answer: "", streaming: true, breakBeforeText: false, fill };
  chat.turns.push(turn);
  const port = browser.runtime.connect({ name: ASK_PORT });
  chat.port = port;
  port.onMessage.addListener((event: unknown) => onEvent(chat, turn, event as StreamEvent));
  port.onDisconnect.addListener(() => {
    if (turn.streaming) onEvent(chat, turn, { type: "error", message: "Lost the connection to the extension." });
  });
  port.postMessage({ pr: chat.pr, question, selection: chat.selection } satisfies AskRequest);
  render(chat);
}

function onEvent(chat: BoxChat, turn: Turn, event: StreamEvent): void {
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
      else if (turn.fill) fillComment(chat, commentFromAnswer(turn.answer));
      chat.port?.disconnect();
      chat.port = null;
      break;
  }
  scheduleRender(chat);
}

// Writes into GitHub's own textarea. insertText goes through the browser's
// editing path, so GitHub's React state sees the change and ⌘Z restores the
// previous text.
function fillComment(chat: BoxChat, text: string): void {
  const textarea = chat.box.isConnected ? chat.box.querySelector("textarea") : null;
  if (!textarea) return showError(chat, "The comment box is closed: open it on these lines again, then use the answer.");
  textarea.focus();
  textarea.select();
  if (!document.execCommand("insertText", false, text)) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

const pending = new Set<BoxChat>();

// Text arrives token by token; re-render at most once per frame.
function scheduleRender(chat: BoxChat): void {
  if (pending.has(chat)) return;
  pending.add(chat);
  requestAnimationFrame(() => {
    pending.delete(chat);
    render(chat);
  });
}

function render(chat: BoxChat): void {
  const { turnsEl } = chat;
  const atBottom = turnsEl.scrollHeight - turnsEl.scrollTop - turnsEl.clientHeight < 40;
  turnsEl.replaceChildren(...chat.turns.map((turn) => renderTurn(chat, turn)));
  if (chat.error) turnsEl.append(h("div", { className: "error", textContent: chat.error }));
  turnsEl.hidden = turnsEl.childElementCount === 0;
  chat.sendButton.replaceChildren(icon(chat.port ? "stop" : "send"));
  chat.sendButton.title = chat.port ? "Stop" : "Ask (Enter)";
  if (atBottom) turnsEl.scrollTop = turnsEl.scrollHeight;
}

function renderTurn(chat: BoxChat, turn: Turn): HTMLElement {
  const el = h("div", { className: "turn" }, h("div", { className: "question", textContent: turn.label, title: turn.label }));
  if (turn.answer) el.append(renderMarkdown(stripDraftComments(turn.answer)));
  if (turn.status) el.append(h("div", { className: "status", textContent: turn.status }));
  if (turn.error) el.append(h("div", { className: "error", textContent: turn.error }));
  if (!turn.streaming && !turn.error && turn.answer) {
    el.append(
      h(
        "button",
        {
          className: "use",
          title: "Replace the comment below with this answer",
          onclick: () => fillComment(chat, commentFromAnswer(turn.answer)),
        },
        icon(turn.fill ? "check" : "insert"),
        turn.fill ? "In your comment · put it back" : "Use as comment",
      ),
    );
  }
  return el;
}
