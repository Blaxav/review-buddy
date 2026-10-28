import { commentFromAnswer, stripDraftComments } from "../../shared/drafts";
import { prKey, type LineSelection, type PrRef } from "../../shared/protocol";
import { selectionFromAnchors, selectionKey } from "../../shared/selection";
import css from "./comment-box.css" with { type: "text" };
import { icon } from "./icons";
import { CHECK_PROMPT, DRAFT_PROMPT, EXPLAIN_PROMPT, improvePrompt, LineChat, type Turn } from "./line-chat";
import { parsePrPath } from "./pr-path";
import theme from "./theme.css" with { type: "text" };
import { autoGrow, h, isolateEvents, renderMarkdown } from "./ui";

// GitHub's box for a new review comment on the lines selected in the diff.
const BOX = '[data-marker-id="new-comment"]';
const STRIP = "review-ai-strip";

// The conversation about one range of lines. It outlives the box: GitHub
// unmounts diff rows scrolled out of view, and the box can be closed and reopened.
type BoxChat = {
  line: LineChat;
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
  let chat = chats.get(key);
  if (chat) {
    Object.assign(chat, { box, turnsEl, sendButton });
  } else {
    const created: BoxChat = {
      line: new LineChat(pr, selection, () => scheduleRender(created), (comment) => fillComment(created, comment)),
      box,
      turnsEl,
      sendButton,
    };
    chat = created;
    chats.set(key, chat);
  }
  const current = chat;
  const ask = (question: string, label: string, fill: boolean) => current.line.ask(question, label, fill);

  const submit = () => {
    const text = input.value.trim();
    if (!text || current.line.busy) return;
    input.value = "";
    resizeInput();
    ask(text, text, false);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  sendButton.onclick = () => (current.line.busy ? current.line.stop() : submit());

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
        chip("Explain", "Explain these lines", () => ask(EXPLAIN_PROMPT, "Explain", false)),
        chip("Find problems", "Look for bugs in these lines", () => ask(CHECK_PROMPT, "Find problems", false)),
        chip("Draft comment", "Write the comment from the conversation", () => ask(DRAFT_PROMPT, "Draft comment", true), "chip key"),
        chip("Improve my comment", "Rewrite what you typed below", () => improve(current)),
      ),
      turnsEl,
      h("div", { className: "ask" }, h("div", { className: "input-box" }, input, sendButton)),
    ),
  );
  box.prepend(host);
  render(current);
  current.line.warm();
}

function improve(chat: BoxChat): void {
  const comment = chat.box.querySelector("textarea")?.value.trim();
  if (comment) chat.line.ask(improvePrompt(comment), "Improve my comment", true);
  else chat.line.fail("Write a comment in the box below first.");
}

// Writes into GitHub's own textarea. insertText goes through the browser's
// editing path, so GitHub's React state sees the change and ⌘Z restores the
// previous text.
function fillComment(chat: BoxChat, text: string): void {
  const textarea = chat.box.isConnected ? chat.box.querySelector("textarea") : null;
  if (!textarea) return chat.line.fail("The comment box is closed: open it on these lines again, then use the answer.");
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
  turnsEl.replaceChildren(...chat.line.turns.map((turn) => renderTurn(chat, turn)));
  if (chat.line.error) turnsEl.append(h("div", { className: "error", textContent: chat.line.error }));
  turnsEl.hidden = turnsEl.childElementCount === 0;
  chat.sendButton.replaceChildren(icon(chat.line.busy ? "stop" : "send"));
  chat.sendButton.title = chat.line.busy ? "Stop" : "Ask (Enter)";
  if (atBottom) turnsEl.scrollTop = turnsEl.scrollHeight;
}

function renderTurn(chat: BoxChat, turn: Turn): HTMLElement {
  const el = h("div", { className: "turn" }, h("div", { className: "question", textContent: turn.label }));
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
