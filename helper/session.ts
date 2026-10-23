import type { Subprocess } from "bun";
import { prKey, type LineSelection, type PrRef, type StreamEvent, type ThreadInfo } from "../shared/protocol";
import { selectionKey } from "../shared/selection";
import { mapClaudeLine } from "./claude-events";
import { checkoutPr, fetchThread, type Checkout } from "./github";
import { systemPrompt, threadPrompt } from "./prompt";

const IDLE_TIMEOUT_MS = 30 * 60_000;

// Read-only tools: Claude explores the checkout but cannot change it or reach the network.
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git blame:*)"];

export class BusyError extends Error {
  constructor() {
    super("Claude is still answering the previous question");
  }
}

type ClaudeProcess = Subprocess<"pipe", "pipe", "inherit">;

// One long-lived `claude` process per conversation (the PR chat, or a line
// thread), so follow-up questions skip its multi-second startup. After an idle
// timeout or a stop, the process exits and the next question restarts it with
// --resume, keeping the conversation.
export class PrSession {
  private proc: ClaudeProcess | null = null;
  private claudeSessionId: string | null = null;
  private listener: ((event: StreamEvent) => void) | null = null;
  private idleTimer: Timer | null = null;

  constructor(
    readonly checkout: Checkout,
    private readonly prompt: string,
    readonly thread?: ThreadInfo,
  ) {}

  start(): void {
    this.ensureProcess();
  }

  ask(question: string, onEvent: (event: StreamEvent) => void): void {
    if (this.listener) throw new BusyError();
    this.listener = onEvent;
    const proc = this.ensureProcess();
    proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: question } }) + "\n");
    proc.stdin.flush();
  }

  stop(): void {
    this.emit({ type: "done" });
    this.proc?.kill();
    this.proc = null;
  }

  private ensureProcess(): ClaudeProcess {
    this.touch();
    if (this.proc) return this.proc;
    const args = [
      "claude", "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Skip the user's settings, plugins and MCP servers: they add seconds to startup.
      "--setting-sources", "",
      "--strict-mcp-config",
      "--allowedTools", ...ALLOWED_TOOLS,
      "--append-system-prompt", this.prompt,
    ];
    if (this.claudeSessionId) args.push("--resume", this.claudeSessionId);
    const proc = Bun.spawn(args, { cwd: this.checkout.dir, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    this.proc = proc;
    void this.pump(proc);
    return proc;
  }

  private async pump(proc: ClaudeProcess): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (proc === this.proc) this.handleLine(line);
      }
    }
    if (proc === this.proc) {
      this.proc = null;
      this.emit({ type: "error", message: `Claude exited (code ${await proc.exited})` });
    }
  }

  private handleLine(line: string): void {
    let json: { type?: string; subtype?: string; session_id?: string };
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    if (json.type === "system" && json.subtype === "init" && json.session_id) {
      this.claudeSessionId = json.session_id;
    }
    for (const event of mapClaudeLine(json)) this.emit(event);
    this.touch();
  }

  private emit(event: StreamEvent): void {
    const listener = this.listener;
    if (!listener) return;
    if (event.type === "done" || event.type === "error") this.listener = null;
    listener(event);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.listener) return this.touch();
      this.proc?.kill();
      this.proc = null;
    }, IDLE_TIMEOUT_MS);
  }
}

const checkouts = new Map<string, Promise<Checkout>>();
const sessions = new Map<string, Promise<PrSession>>();

function cached<T>(map: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  let value = map.get(key);
  if (!value) {
    value = create();
    value.catch(() => map.delete(key));
    map.set(key, value);
  }
  return value;
}

export function getCheckout(pr: PrRef): Promise<Checkout> {
  return cached(checkouts, prKey(pr), () => checkoutPr(pr));
}

function sessionKey(pr: PrRef, selection?: LineSelection): string {
  return selection ? `${prKey(pr)} ${selectionKey(selection)}` : prKey(pr);
}

export function getSession(pr: PrRef, selection?: LineSelection): Promise<PrSession> {
  return cached(sessions, sessionKey(pr, selection), async () => {
    const checkout = await getCheckout(pr);
    if (!selection) return new PrSession(checkout, systemPrompt(pr, checkout.info));
    const thread = await fetchThread(checkout, selection);
    return new PrSession(checkout, threadPrompt(pr, checkout.info, thread, selection), thread);
  });
}

// Drops the conversation. Resetting the PR chat also makes the next question
// check out the PR's latest head.
export async function resetSession(pr: PrRef, selection?: LineSelection): Promise<void> {
  const key = sessionKey(pr, selection);
  const session = sessions.get(key);
  sessions.delete(key);
  if (!selection) checkouts.delete(prKey(pr));
  (await session?.catch(() => null))?.stop();
}
