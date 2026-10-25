import type Browser from "webextension-polyfill";
import { parseDraftComments, stripDraftComments } from "../../shared/drafts";
import { prKey, type DraftComment, type PrRef, type StreamEvent } from "../../shared/protocol";
import { watchCommentBoxes } from "./comment-box";
import { setDocked } from "./diff-marks";
import { guideBar, guideCss, guideStarter, initGuide, setGuideDocked, setGuidePr } from "./guide";
import { ASK_PORT } from "./messages";
import { icon } from "./icons";
import css from "./overlay.css" with { type: "text" };
import { parsePrPath } from "./pr-path";
import theme from "./theme.css" with { type: "text" };
import { autoGrow, h, isolateEvents, renderMarkdown, request } from "./ui";

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
    h("span", { className: "mark" }, icon("sparkle")),
    h("div", { className: "heading" }, h("span", { className: "name", textContent: "Claude" }), titleEl),
    h("button", { className: "icon-button", title: "New chat", ariaLabel: "New chat", onclick: () => void newChat() }, icon("newChat")),
    h("button", { className: "icon-button", title: "Close (Esc)", ariaLabel: "Close", onclick: () => setPanelOpen(false) }, icon("close")),
  ),
  body,
);
const launcher = h(
  "button",
  { className: "launcher", title: "Ask Claude about this PR", ariaLabel: "Ask Claude", onclick: () => void setPanelOpen(true) },
  icon("sparkle"),
);
root.append(h("style", { textContent: theme + css + guideCss }), panel, launcher, guideStarter, guideBar);
panel.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setPanelOpen(false);
});

const messagesEl = h("div", { className: "messages" });
const input = h("textarea", { rows: 1, placeholder: "Ask about this PR…" });
const resizeInput = autoGrow(input);
const sendButton = h("button", { className: "send", title: "Send (Enter)", ariaLabel: "Send" });
const selectionEl = h("div", { className: "quote" });
const composer = h(
  "div",
  { className: "composer" },
  selectionEl,
  h("div", { className: "input-box" }, input, sendButton),
  h("div", { className: "hint", textContent: "Enter to send · Shift+Enter for a new line" }),
);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
input.addEventListener("input", () => renderComposer());
sendButton.addEventListener("click", () => (isStreaming() ? void stop() : submit()));

// --- Panel states -----------------------------------------------------------

async function setPanelOpen(open: boolean): Promise<void> {
  panel.hidden = !open;
  launcher.hidden = open;
  setDocked(open);
  setGuideDocked(open);
  if (!open) return;
  await connect();
  input.focus();
}

async function connect(): Promise<void> {
  const res = await request({ kind: "check" });
  if (res.ok) {
    renderChat();
    warm();
  } else {
    renderConnectionError(res.error);
  }
}

function renderConnectionError(error: string): void {
  body.replaceChildren(
    h(
      "div",
      { className: "setup" },
      h("div", { className: "error", textContent: error }),
      h("button", { textContent: "Try again", onclick: () => void connect() }),
    ),
  );
}

function renderChat(): void {
  if (!chat) return;
  body.replaceChildren(messagesEl, composer);
  if (chat.items.length === 0) {
    messagesEl.replaceChildren(
      h(
        "div",
        { className: "empty" },
        h("div", { className: "badge mark" }, icon("sparkle")),
        h("h2", { textContent: "What should we look at?" }),
        h("p", {
          textContent: "Claude has the whole repository checked out. For specific lines, open a review comment on them: Claude is in the comment box too.",
        }),
        suggestion("Explain this PR", "File by file, with the risky parts", EXPLAIN_PROMPT),
        suggestion("Review and draft comments", "Bugs, risky changes, missing tests", REVIEW_PROMPT),
      ),
    );
  } else {
    messagesEl.replaceChildren(...chat.items.map(renderItem));
  }
  renderComposer();
}

function suggestion(label: string, detail: string, prompt: string): HTMLButtonElement {
  return h(
    "button",
    { className: "suggestion", ariaLabel: label, onclick: () => ask(prompt, label) },
    h("span", {}, label, h("small", { textContent: detail })),
    icon("chevron"),
  );
}

function renderComposer(): void {
  const streaming = isStreaming();
  sendButton.replaceChildren(icon(streaming ? "stop" : "send"));
  sendButton.title = streaming ? "Stop" : "Send (Enter)";
  sendButton.disabled = !streaming && !input.value.trim();
  selectionEl.hidden = !selection;
  selectionEl.replaceChildren();
  if (selection) {
    selectionEl.append(
      h("code", { textContent: selection.replace(/\s+/g, " ") }),
      h("button", { className: "icon-button", title: "Drop the quoted code", ariaLabel: "Drop the quoted code", onclick: () => setSelection("") }, icon("close")),
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
    const count = `${answer.tools.length} step${answer.tools.length > 1 ? "s" : ""}`;
    el.append(
      h(
        "details",
        { className: "activity" },
        h("summary", {}, icon("chevron"), answer.streaming ? `Working · ${count}` : `Looked into the code · ${count}`),
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
  const el = h("div", { className: "draft" }, h("div", { className: "where", title: where }, icon("file"), h("span", { textContent: where })));

  if (draft.status === "posted") {
    el.append(
      h("div", { className: "posted" }, icon("check"), "Posted", h("a", { href: draft.url, target: "_blank", textContent: "View on GitHub" })),
    );
    return el;
  }
  const bodyInput = h("textarea", { value: comment.body, rows: 1 });
  bodyInput.oninput = () => (comment.body = bodyInput.value);
  const post = h("button", { className: "primary", textContent: draft.status === "posting" ? "Posting…" : "Post comment" });
  post.disabled = draft.status === "posting";
  post.onclick = () => void postDraft(answer, draft);
  const dismiss = h("button", { textContent: "Dismiss" });
  dismiss.onclick = () => {
    draft.status = "dismissed";
    renderItem(answer);
  };
  const actions = h("div", { className: "actions" }, dismiss, post);
  if (draft.error) actions.prepend(h("div", { className: "error", textContent: draft.error }));
  el.append(bodyInput, actions);
  requestAnimationFrame(() => autoGrow(bodyInput)());
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
  resizeInput();
  ask(text);
}

// `label`, when given, is what the conversation shows instead of the prompt.
function ask(text: string, label?: string): void {
  const current = chat;
  if (!current || current.port) return;
  const question = selection ? `About this code from the diff:\n\`\`\`\n${selection}\n\`\`\`\n\n${text}` : text;
  const answer: Answer = { kind: "assistant", text: "", tools: [], streaming: true, breakBeforeText: false, drafts: [] };
  current.items.push({ kind: "user", text: label ?? question }, answer);
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
    setDocked(false);
    setGuidePr(null);
    return;
  }
  if (!host.isConnected) {
    document.documentElement.append(host);
    setDocked(!panel.hidden);
  }
  setGuidePr(pr);
  const key = prKey(pr);
  if (chat && prKey(chat.pr) === key) return;
  chat = chats.get(key) ?? { pr, items: [], port: null, warmed: false };
  chats.set(key, chat);
  titleEl.textContent = key;
  if (!panel.hidden) void connect();
}

// A question about a step of the smart review goes to the chat.
initGuide(async (question, label) => {
  await setPanelOpen(true);
  ask(question, label);
});
sync();
setInterval(sync, 500);
watchCommentBoxes();
