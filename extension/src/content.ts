import DOMPurify from "dompurify";
import { marked } from "marked";
import type Browser from "webextension-polyfill";
import { parseDraftComments, stripDraftComments } from "../../shared/drafts";
import {
  prKey,
  type DiffRow,
  type DraftComment,
  type LineSelection,
  type PrRef,
  type StreamEvent,
  type ThreadInfo,
} from "../../shared/protocol";
import { isSingleLine, parseSelectionHash, selectionKey } from "../../shared/selection";
import { ASK_PORT, type BackgroundRequest, type BackgroundResponse } from "./messages";
import css from "./overlay.css" with { type: "text" };
import { parsePrPath } from "./pr-path";

const MAX_QUOTE_CHARS = 4000;

const EXPLAIN_PROMPT = "Explain what this PR changes and why, file by file. Flag anything risky.";
const REVIEW_PROMPT = "Review this PR: look for bugs, risky changes and missing tests, and propose review comments.";
const EXPLAIN_LINES_PROMPT = "Explain what these lines do and why they changed.";
const CHECK_LINES_PROMPT = "Is anything wrong with these lines? Check how they're used elsewhere in the repository.";
const DRAFT_PROMPT =
  "Draft the review comment on the selected lines, based on what we discussed. Keep it short and include a suggested fix when there is one.";

type Draft = { comment: DraftComment; status: "draft" | "posting" | "posted" | "dismissed"; url?: string; error?: string };

type Question = { kind: "user"; text: string; el?: HTMLElement };
type Answer = {
  kind: "assistant";
  text: string;
  tools: string[];
  status?: string;
  error?: string;
  streaming: boolean;
  // Claude's text after a tool call starts a new paragraph.
  breakBeforeText: boolean;
  drafts: Draft[];
  el?: HTMLElement;
};
// A comment the user writes on a thread's lines without asking Claude.
type CommentItem = { kind: "comment"; draft: Draft; el?: HTMLElement };
type Item = Question | Answer | CommentItem;

// Lines selected in the diff; `hash` is the URL hash GitHub gave them.
type Thread = { selection: LineSelection; hash: string; info?: ThreadInfo; error?: string };

// A conversation: the PR chat (no thread) or a line thread.
type Chat = { pr: PrRef; thread: Thread | null; items: Item[]; port: Browser.Runtime.Port | null; warmed: boolean };

type PrChats = { pr: PrRef; main: Chat; threads: Chat[]; active: Chat };

const prChats = new Map<string, PrChats>();
let prState: PrChats | null = null;
let chat: Chat | null = null;
let quote = "";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

function request(req: BackgroundRequest): Promise<BackgroundResponse> {
  return browser.runtime.sendMessage(req) as Promise<BackgroundResponse>;
}

// --- Overlay skeleton -------------------------------------------------------

const host = h("div", { id: "review-ai-overlay" });
const root = host.attachShadow({ mode: "open" });
// Events from inside the shadow root reach GitHub retargeted to the host, so its
// keyboard shortcuts would fire while typing here.
for (const type of ["keydown", "keyup", "keypress"]) root.addEventListener(type, (e) => e.stopPropagation());

const titleEl = h("span", { className: "title" });
const tabsEl = h("div", { className: "tabs", hidden: true });
const body = h("div", { className: "body" });
const panel = h(
  "div",
  { className: "panel", hidden: true },
  h(
    "div",
    { className: "header" },
    titleEl,
    h("button", { className: "ghost", textContent: "New chat", onclick: () => void newChat() }),
    h("button", { className: "ghost", textContent: "✕", title: "Close", onclick: () => closePanel() }),
  ),
  tabsEl,
  body,
);
const launcher = h("button", { className: "launcher primary", textContent: "Ask Claude", onclick: () => togglePanel() });
const pill = h("button", { className: "pill primary", hidden: true });
root.append(h("style", { textContent: css }), panel, launcher, pill);

const messagesEl = h("div", { className: "messages" });
const input = h("textarea");
const sendButton = h("button", { className: "primary", textContent: "Send" });
const draftButton = h("button", {
  textContent: "Draft comment",
  title: "Ask Claude to write the review comment on these lines",
  onclick: () => ask(DRAFT_PROMPT),
});
const commentButton = h("button", {
  textContent: "Comment",
  title: "Write a review comment on these lines yourself",
  onclick: () => addComment(),
});
const quoteEl = h("div", { className: "quote" });
const composer = h(
  "div",
  { className: "composer" },
  quoteEl,
  input,
  h("div", { className: "row" }, draftButton, commentButton, h("span", { className: "spacer" }), sendButton),
);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
sendButton.addEventListener("click", () => (isStreaming() ? void stop() : submit()));

// --- Panel states -----------------------------------------------------------

async function togglePanel(): Promise<void> {
  if (!panel.hidden) return closePanel();
  panel.hidden = false;
  updatePill();
  await connect();
}

function closePanel(): void {
  panel.hidden = true;
  updatePill();
}

async function connect(): Promise<void> {
  const res = await request({ kind: "check" });
  if (res.ok) {
    renderChat();
    warm();
  } else {
    renderSetup(res);
  }
}

function renderSetup(res: Extract<BackgroundResponse, { ok: false }>): void {
  tabsEl.hidden = true;
  if (res.reason === "token") {
    const tokenInput = h("input", { type: "password", placeholder: "Helper token" });
    const save = h("button", { className: "primary", textContent: "Connect" });
    const errorEl = h("div", { className: "error" });
    save.onclick = async () => {
      const result = await request({ kind: "set-token", token: tokenInput.value });
      if (result.ok) await connect();
      else errorEl.textContent = result.error;
    };
    body.replaceChildren(
      h(
        "div",
        { className: "setup" },
        h("div", {}, "Connect to the local helper. Get its token with ", h("code", { textContent: "bun run token" }), "."),
        tokenInput,
        save,
        errorEl,
      ),
    );
  } else {
    body.replaceChildren(
      h(
        "div",
        { className: "setup" },
        h("div", { className: "error", textContent: res.error }),
        h("button", { textContent: "Retry", onclick: () => void connect() }),
      ),
    );
  }
}

function renderChat(): void {
  if (!chat) return;
  renderTabs();
  body.replaceChildren(...(chat.thread ? [renderThreadHead(chat.thread)] : []), messagesEl, composer);
  if (chat.items.length === 0) {
    messagesEl.replaceChildren(renderEmpty(chat));
  } else {
    messagesEl.replaceChildren(...chat.items.map(renderItem));
  }
  renderComposer();
}

function renderEmpty(owner: Chat): HTMLElement {
  if (owner.thread) {
    return h(
      "div",
      { className: "empty" },
      h("div", {}, "Ask about these lines, then draft the comment with Claude or write it yourself."),
      h("button", { textContent: "Explain these lines", onclick: () => ask(EXPLAIN_LINES_PROMPT) }),
      h("button", { textContent: "Look for problems", onclick: () => ask(CHECK_LINES_PROMPT) }),
    );
  }
  return h(
    "div",
    { className: "empty" },
    h("div", {}, "Ask anything about this PR. To discuss specific lines, select them in the diff: click a line number, shift-click another."),
    h("button", { textContent: "Explain this PR", onclick: () => ask(EXPLAIN_PROMPT) }),
    h("button", { textContent: "Review and draft comments", onclick: () => ask(REVIEW_PROMPT) }),
  );
}

function renderTabs(): void {
  if (!prState) return;
  tabsEl.hidden = prState.threads.length === 0;
  tabsEl.replaceChildren(renderTab(prState.main), ...prState.threads.map(renderTab));
}

function renderTab(owner: Chat): HTMLElement {
  const label = owner.thread ? threadLabel(owner.thread) : "PR";
  const tab = h(
    "span",
    { className: owner === chat ? "tab active" : "tab" },
    h("button", { className: "ghost", textContent: label, title: label, onclick: () => activate(owner) }),
  );
  if (owner.thread) {
    tab.append(h("button", { className: "ghost", textContent: "✕", title: "Close thread", onclick: () => void closeThread(owner) }));
  }
  return tab;
}

function renderThreadHead(thread: Thread): HTMLElement {
  const label = thread.info ? `${thread.info.path}:${rangeLabel(thread.selection)}` : linesLabel(thread.selection);
  const el = h(
    "div",
    { className: "thread" },
    h("button", { className: "ghost where", textContent: label, title: "Show in the diff", onclick: () => reveal(thread) }),
  );
  if (thread.error) el.append(h("div", { className: "error", textContent: thread.error }));
  else if (!thread.info) el.append(h("div", { className: "status", textContent: "Loading the selected lines…" }));
  else el.append(h("div", { className: "code" }, ...thread.info.rows.map(renderRow)));
  return el;
}

function renderRow(row: DiffRow): HTMLElement {
  const marker = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  return h(
    "div",
    { className: `line ${row.kind}` },
    h("span", { className: "num", textContent: String(row.newLine ?? row.oldLine) }),
    h("span", { textContent: `${marker} ${row.text}` }),
  );
}

function renderComposer(): void {
  const thread = chat?.thread;
  sendButton.textContent = isStreaming() ? "Stop" : "Send";
  input.placeholder = `${thread ? "Ask about these lines…" : "Ask about this PR…"}  (Enter to send, Shift+Enter for a new line)`;
  draftButton.hidden = commentButton.hidden = !thread;
  draftButton.disabled = isStreaming();
  commentButton.disabled = !thread?.info;
  quoteEl.replaceChildren();
  if (quote) {
    quoteEl.append(
      "Selection: ",
      h("span", { textContent: quote.replace(/\s+/g, " ") }),
      h("button", { className: "ghost", textContent: "✕", title: "Drop selection", onclick: () => setQuote("") }),
    );
  }
}

function renderItem(item: Item): HTMLElement {
  const el = item.kind === "user" ? renderQuestion(item) : item.kind === "assistant" ? renderAnswer(item) : renderComment(item);
  item.el?.replaceWith(el);
  item.el = el;
  return el;
}

function renderQuestion(question: Question): HTMLElement {
  return h("div", { className: "user", textContent: question.text });
}

function renderAnswer(answer: Answer): HTMLElement {
  const el = h("div", { className: "assistant" });
  if (answer.tools.length > 0) {
    el.append(
      h(
        "details",
        { className: "tools" },
        h("summary", { textContent: `Looked at ${answer.tools.length} thing${answer.tools.length > 1 ? "s" : ""}` }),
        ...answer.tools.map((tool) => h("div", { textContent: tool, title: tool })),
      ),
    );
  }
  const markdown = h("div");
  markdown.innerHTML = DOMPurify.sanitize(marked.parse(stripDraftComments(answer.text), { async: false }));
  el.append(markdown);
  if (answer.status) el.append(h("div", { className: "status", textContent: answer.status }));
  if (answer.error) el.append(h("div", { className: "error", textContent: answer.error }));
  for (const draft of answer.drafts) {
    if (draft.status !== "dismissed") el.append(renderDraft(answer, draft));
  }
  return el;
}

function renderComment(item: CommentItem): HTMLElement {
  const el = h("div");
  if (item.draft.status !== "dismissed") el.append(renderDraft(item, item.draft));
  return el;
}

function renderDraft(owner: Item, draft: Draft): HTMLElement {
  const { comment } = draft;
  const lines = comment.startLine ? `${comment.startLine}-${comment.line}` : `${comment.line}`;
  const where = `${comment.path}:${lines}${comment.side === "LEFT" ? " (old)" : ""}`;
  const el = h("div", { className: "draft" }, h("div", { className: "where", textContent: where }));

  if (draft.status === "posted") {
    el.append(h("div", { className: "posted" }, "Posted · ", h("a", { href: draft.url, target: "_blank", textContent: "view" })));
    return el;
  }
  const bodyInput = h("textarea", { value: comment.body, rows: 4, placeholder: "Leave a comment" });
  bodyInput.oninput = () => (comment.body = bodyInput.value);
  const post = h("button", { className: "primary", textContent: draft.status === "posting" ? "Posting…" : "Post" });
  post.disabled = draft.status === "posting";
  post.onclick = () => void postDraft(owner, draft);
  const dismiss = h("button", { textContent: "Dismiss" });
  dismiss.onclick = () => {
    draft.status = "dismissed";
    renderItem(owner);
  };
  el.append(bodyInput, h("div", { className: "actions" }, post, dismiss));
  if (draft.error) el.append(h("div", { className: "error", textContent: draft.error }));
  return el;
}

// --- Labels -----------------------------------------------------------------

function rangeLabel(selection: LineSelection): string {
  const { startSide, startLine, side, line } = selection;
  if (startSide !== side) return `L${startLine}–R${line}`;
  const old = side === "LEFT" ? " (old)" : "";
  return isSingleLine(selection) ? `${line}${old}` : `${startLine}–${line}${old}`;
}

function linesLabel(selection: LineSelection): string {
  return `${isSingleLine(selection) ? "line" : "lines"} ${rangeLabel(selection)}`;
}

function threadLabel(thread: Thread): string {
  if (!thread.info) return linesLabel(thread.selection);
  return `${thread.info.path.split("/").pop()}:${rangeLabel(thread.selection)}`;
}

// --- Actions ----------------------------------------------------------------

function isStreaming(): boolean {
  return chat?.port != null;
}

// Starts the conversation's Claude process ahead of the first question; for a
// line thread, this also loads its lines.
function warm(): void {
  const owner = chat;
  if (!owner || owner.warmed) return;
  owner.warmed = true;
  const thread = owner.thread;
  if (!thread) {
    void request({ kind: "warm", pr: owner.pr });
    return;
  }
  thread.error = undefined;
  void request({ kind: "thread", pr: owner.pr, selection: thread.selection }).then((res) => {
    if (res.ok) {
      thread.info = res.thread;
    } else {
      thread.error = res.error;
      owner.warmed = false;
    }
    if (owner === chat) renderChat();
  });
}

function activate(owner: Chat): void {
  if (!prState) return;
  prState.active = chat = owner;
  renderChat();
  warm();
  updatePill();
}

function openThread(selection: LineSelection, hash: string): void {
  if (!prState) return;
  const key = selectionKey(selection);
  let owner = prState.threads.find((c) => c.thread && selectionKey(c.thread.selection) === key);
  if (!owner) {
    owner = { pr: prState.pr, thread: { selection, hash }, items: [], port: null, warmed: false };
    prState.threads.push(owner);
  }
  prState.active = chat = owner;
  panel.hidden = false;
  updatePill();
  void connect();
  input.focus();
}

async function closeThread(owner: Chat): Promise<void> {
  if (!prState || !owner.thread) return;
  owner.port?.disconnect();
  owner.port = null;
  prState.threads = prState.threads.filter((c) => c !== owner);
  if (owner === chat) activate(prState.main);
  else renderTabs();
  await request({ kind: "reset", pr: owner.pr, selection: owner.thread.selection });
}

// Scrolls GitHub's diff back to a thread's lines.
function reveal({ selection, hash }: Thread): void {
  if (location.hash !== hash) location.hash = hash;
  const { fileHash, startSide, startLine } = selection;
  document.getElementById(`diff-${fileHash}${startSide[0]}${startLine}`)?.scrollIntoView({ block: "center" });
}

function addComment(): void {
  const owner = chat;
  const info = owner?.thread?.info;
  if (!owner?.thread || !info) return;
  const { selection } = owner.thread;
  const comment: DraftComment = { path: info.path, line: selection.line, side: selection.side, body: "" };
  if (!isSingleLine(selection)) {
    comment.startLine = selection.startLine;
    if (selection.startSide !== selection.side) comment.startSide = selection.startSide;
  }
  const item: CommentItem = { kind: "comment", draft: { comment, status: "draft" } };
  owner.items.push(item);
  renderChat();
  messagesEl.scrollTop = messagesEl.scrollHeight;
  item.el?.querySelector("textarea")?.focus();
}

function submit(): void {
  const text = input.value.trim();
  if (!text || isStreaming()) return;
  input.value = "";
  ask(text);
}

function ask(text: string): void {
  const current = chat;
  if (!current || current.port) return;
  const question = quote ? `About this code from the diff:\n\`\`\`\n${quote}\n\`\`\`\n\n${text}` : text;
  const answer: Answer = { kind: "assistant", text: "", tools: [], streaming: true, breakBeforeText: false, drafts: [] };
  current.items.push({ kind: "user", text: question }, answer);
  setQuote("");

  const port = browser.runtime.connect({ name: ASK_PORT });
  current.port = port;
  port.onMessage.addListener((event: unknown) => onEvent(current, answer, event as StreamEvent));
  port.onDisconnect.addListener(() => {
    if (answer.streaming) onEvent(current, answer, { type: "error", message: "Lost the connection to the extension." });
  });
  port.postMessage({ pr: current.pr, question, selection: current.thread?.selection });
  if (current === chat) renderChat();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function onEvent(owner: Chat, answer: Answer, event: StreamEvent): void {
  switch (event.type) {
    case "status":
      answer.status = event.message;
      break;
    case "text":
      answer.text += (answer.breakBeforeText && answer.text ? "\n\n" : "") + event.text;
      answer.breakBeforeText = false;
      answer.status = undefined;
      break;
    case "tool":
      answer.tools.push(`${event.name} ${event.detail}`.trim());
      answer.breakBeforeText = true;
      answer.status = undefined;
      break;
    case "done":
    case "error":
      answer.streaming = false;
      answer.status = undefined;
      if (event.type === "error") answer.error = event.message;
      answer.drafts = parseDraftComments(answer.text).map((comment) => ({ comment, status: "draft" }));
      owner.port?.disconnect();
      owner.port = null;
      break;
  }
  if (owner !== chat) return;
  scheduleRender(answer);
}

let pendingRender: Answer | null = null;

// Text arrives token by token; re-render at most once per frame.
function scheduleRender(answer: Answer): void {
  if (pendingRender) return;
  pendingRender = answer;
  requestAnimationFrame(() => {
    pendingRender = null;
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    renderItem(answer);
    renderComposer();
    if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

async function postDraft(owner: Item, draft: Draft): Promise<void> {
  if (!chat) return;
  draft.status = "posting";
  draft.error = undefined;
  renderItem(owner);
  const res = await request({ kind: "post-comment", pr: chat.pr, comment: draft.comment });
  if (res.ok) {
    draft.status = "posted";
    draft.url = res.url;
  } else {
    draft.status = "draft";
    draft.error = res.error;
  }
  renderItem(owner);
}

async function stop(): Promise<void> {
  if (chat) await request({ kind: "stop", pr: chat.pr, selection: chat.thread?.selection });
}

async function newChat(): Promise<void> {
  if (!chat) return;
  chat.port?.disconnect();
  chat.port = null;
  chat.items = [];
  chat.warmed = false;
  await request({ kind: "reset", pr: chat.pr, selection: chat.thread?.selection });
  renderChat();
  warm();
}

function setQuote(text: string): void {
  quote = text.slice(0, MAX_QUOTE_CHARS);
  renderComposer();
}

document.addEventListener("mouseup", (e) => {
  if (e.composedPath().includes(host)) return;
  const text = window.getSelection()?.toString().trim();
  if (text) setQuote(text);
});

// Offers a thread on the lines selected in the diff, unless it is already open.
function updatePill(): void {
  const selection = prState ? parseSelectionHash(location.hash) : null;
  const shown = !panel.hidden && chat?.thread != null && selection != null && selectionKey(chat.thread.selection) === selectionKey(selection);
  pill.hidden = !selection || shown;
  if (!selection || shown) return;
  const hash = location.hash;
  pill.textContent = `Chat with Claude about ${linesLabel(selection)}`;
  pill.onclick = () => openThread(selection, hash);
}

// --- Following GitHub's client-side navigation ------------------------------

// GitHub swaps pages without reloading, and replaces <body> when it does; the
// overlay hangs off <html> and checks the URL instead of trusting page events.
function sync(): void {
  const pr = parsePrPath(location.pathname);
  if (!pr) {
    host.remove();
    return;
  }
  if (!host.isConnected) document.documentElement.append(host);
  const key = prKey(pr);
  if (!prState || prKey(prState.pr) !== key) {
    prState = prChats.get(key) ?? null;
    if (!prState) {
      const main: Chat = { pr, thread: null, items: [], port: null, warmed: false };
      prState = { pr, main, threads: [], active: main };
      prChats.set(key, prState);
    }
    chat = prState.active;
    titleEl.textContent = key;
    if (!panel.hidden) void connect();
  }
  updatePill();
}

sync();
setInterval(sync, 500);
window.addEventListener("hashchange", sync);
