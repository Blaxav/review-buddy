import type Browser from "webextension-polyfill";
import { parseDraftComments, stripDraftComments } from "../../shared/drafts";
import { prKey, type DraftComment, type PrRef, type StreamEvent } from "../../shared/protocol";
import { watchCommentBoxes } from "./comment-box";
import { ASK_PORT, type BackgroundResponse } from "./messages";
import css from "./overlay.css" with { type: "text" };
import { parsePrPath } from "./pr-path";
import { h, isolateEvents, renderMarkdown, request } from "./ui";

const MAX_SELECTION_CHARS = 4000;

const EXPLAIN_PROMPT = "Explain what this PR changes and why, file by file. Flag anything risky.";
const REVIEW_PROMPT = "Review this PR: look for bugs, risky changes and missing tests, and propose review comments.";

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

type Chat = { pr: PrRef; items: (Question | Answer)[]; port: Browser.Runtime.Port | null; warmed: boolean };

const chats = new Map<string, Chat>();
let chat: Chat | null = null;
let selection = "";

// --- Overlay skeleton -------------------------------------------------------

const host = h("div", { id: "review-ai-overlay" });
const root = host.attachShadow({ mode: "open" });
isolateEvents(root, ["keydown", "keyup", "keypress"]);

const titleEl = h("span", { className: "title" });
const body = h("div", { className: "body" });
const panel = h(
  "div",
  { className: "panel", hidden: true },
  h(
    "div",
    { className: "header" },
    titleEl,
    h("button", { className: "ghost", textContent: "New chat", onclick: () => void newChat() }),
    h("button", { className: "ghost", textContent: "✕", title: "Close", onclick: () => (panel.hidden = true) }),
  ),
  body,
);
const launcher = h("button", { className: "launcher primary", textContent: "Ask Claude", onclick: () => togglePanel() });
root.append(h("style", { textContent: css }), panel, launcher);

const messagesEl = h("div", { className: "messages" });
const input = h("textarea", { placeholder: "Ask about this PR…  (Enter to send, Shift+Enter for a new line)" });
const sendButton = h("button", { className: "primary", textContent: "Send" });
const selectionEl = h("div", { className: "selection" });
const composer = h(
  "div",
  { className: "composer" },
  selectionEl,
  input,
  h("div", { className: "row" }, h("span", { className: "spacer" }), sendButton),
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
  panel.hidden = !panel.hidden;
  if (!panel.hidden) await connect();
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
  body.replaceChildren(messagesEl, composer);
  if (chat.items.length === 0) {
    messagesEl.replaceChildren(
      h(
        "div",
        { className: "empty" },
        h("div", {}, "Ask anything about this PR. To discuss specific lines, open a comment on them: Claude is in the comment box."),
        h("button", { textContent: "Explain this PR", onclick: () => ask(EXPLAIN_PROMPT) }),
        h("button", { textContent: "Review and draft comments", onclick: () => ask(REVIEW_PROMPT) }),
      ),
    );
  } else {
    messagesEl.replaceChildren(...chat.items.map(renderItem));
  }
  renderComposer();
}

function renderComposer(): void {
  sendButton.textContent = isStreaming() ? "Stop" : "Send";
  selectionEl.replaceChildren();
  if (selection) {
    selectionEl.append(
      "Selection: ",
      h("span", { textContent: selection.replace(/\s+/g, " ") }),
      h("button", { className: "ghost", textContent: "✕", title: "Drop selection", onclick: () => setSelection("") }),
    );
  }
}

function renderItem(item: Question | Answer): HTMLElement {
  const el = item.kind === "user" ? renderQuestion(item) : renderAnswer(item);
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
  el.append(renderMarkdown(stripDraftComments(answer.text)));
  if (answer.status) el.append(h("div", { className: "status", textContent: answer.status }));
  if (answer.error) el.append(h("div", { className: "error", textContent: answer.error }));
  for (const draft of answer.drafts) {
    if (draft.status !== "dismissed") el.append(renderDraft(answer, draft));
  }
  return el;
}

function renderDraft(answer: Answer, draft: Draft): HTMLElement {
  const { comment } = draft;
  const lines = comment.startLine ? `${comment.startLine}-${comment.line}` : `${comment.line}`;
  const where = `${comment.path}:${lines}${comment.side === "LEFT" ? " (old)" : ""}`;
  const el = h("div", { className: "draft" }, h("div", { className: "where", textContent: where }));

  if (draft.status === "posted") {
    el.append(h("div", { className: "posted" }, "Posted · ", h("a", { href: draft.url, target: "_blank", textContent: "view" })));
    return el;
  }
  const bodyInput = h("textarea", { value: comment.body, rows: 4 });
  bodyInput.oninput = () => (comment.body = bodyInput.value);
  const post = h("button", { className: "primary", textContent: draft.status === "posting" ? "Posting…" : "Post" });
  post.disabled = draft.status === "posting";
  post.onclick = () => void postDraft(answer, draft);
  const dismiss = h("button", { textContent: "Dismiss" });
  dismiss.onclick = () => {
    draft.status = "dismissed";
    renderItem(answer);
  };
  el.append(bodyInput, h("div", { className: "actions" }, post, dismiss));
  if (draft.error) el.append(h("div", { className: "error", textContent: draft.error }));
  return el;
}

// --- Actions ----------------------------------------------------------------

function isStreaming(): boolean {
  return chat?.port != null;
}

function warm(): void {
  if (!chat || chat.warmed) return;
  chat.warmed = true;
  void request({ kind: "warm", pr: chat.pr });
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
  const question = selection ? `About this code from the diff:\n\`\`\`\n${selection}\n\`\`\`\n\n${text}` : text;
  const answer: Answer = { kind: "assistant", text: "", tools: [], streaming: true, breakBeforeText: false, drafts: [] };
  current.items.push({ kind: "user", text: question }, answer);
  setSelection("");

  const port = browser.runtime.connect({ name: ASK_PORT });
  current.port = port;
  port.onMessage.addListener((event: unknown) => onEvent(current, answer, event as StreamEvent));
  port.onDisconnect.addListener(() => {
    if (answer.streaming) onEvent(current, answer, { type: "error", message: "Lost the connection to the extension." });
  });
  port.postMessage({ pr: current.pr, question });
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

async function postDraft(answer: Answer, draft: Draft): Promise<void> {
  if (!chat) return;
  draft.status = "posting";
  draft.error = undefined;
  renderItem(answer);
  const res = await request({ kind: "post-comment", pr: chat.pr, comment: draft.comment });
  if (res.ok) {
    draft.status = "posted";
    draft.url = res.url;
  } else {
    draft.status = "draft";
    draft.error = res.error;
  }
  renderItem(answer);
}

async function stop(): Promise<void> {
  if (chat) await request({ kind: "stop", pr: chat.pr });
}

async function newChat(): Promise<void> {
  if (!chat) return;
  chat.port?.disconnect();
  chat.port = null;
  chat.items = [];
  chat.warmed = false;
  await request({ kind: "reset", pr: chat.pr });
  renderChat();
  warm();
}

function setSelection(text: string): void {
  selection = text.slice(0, MAX_SELECTION_CHARS);
  renderComposer();
}

document.addEventListener("mouseup", (e) => {
  if (e.composedPath().includes(host)) return;
  const text = window.getSelection()?.toString().trim();
  if (text) setSelection(text);
});

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
  if (chat && prKey(chat.pr) === key) return;
  chat = chats.get(key) ?? { pr, items: [], port: null, warmed: false };
  chats.set(key, chat);
  titleEl.textContent = key;
  if (!panel.hidden) void connect();
}

sync();
setInterval(sync, 500);
watchCommentBoxes();
