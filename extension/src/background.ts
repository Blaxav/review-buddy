import type Browser from "webextension-polyfill";
import { HELPER_URL, type StreamEvent, type ThreadInfo } from "../../shared/protocol";
import { ASK_PORT, GUIDE_PORT, type BackgroundRequest, type BackgroundResponse } from "./messages";

// Set by scripts/build-extension.ts from ~/.review-ai/token.
declare const HELPER_TOKEN: string;

const UNREACHABLE = `The helper isn't reachable on ${HELPER_URL}. Start it with \`bun run helper\`.`;
const STALE_TOKEN = "The helper's token changed since this extension was built. Rebuild it with ./scripts/make-safari-app.sh.";

async function helperFetch(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(HELPER_URL + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${HELPER_TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(UNREACHABLE);
  }
  if (res.status === 401) throw new Error(STALE_TOKEN);
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error ?? `Helper error ${res.status}`);
  }
  return res;
}

async function handleRequest(request: BackgroundRequest): Promise<BackgroundResponse> {
  switch (request.kind) {
    case "check":
      await helperFetch("/health");
      return { ok: true };
    case "warm":
      await helperFetch("/warm", { pr: request.pr });
      return { ok: true };
    case "stop":
      await helperFetch("/stop", { pr: request.pr, selection: request.selection });
      return { ok: true };
    case "reset":
      await helperFetch("/reset", { pr: request.pr });
      return { ok: true };
    case "thread": {
      const res = await helperFetch("/thread", { pr: request.pr, selection: request.selection });
      return { ok: true, thread: (await res.json()) as ThreadInfo };
    }
    case "post-comment": {
      const res = await helperFetch("/comments", { pr: request.pr, comment: request.comment });
      const { url } = (await res.json()) as { url: string };
      return { ok: true, url };
    }
  }
}

browser.runtime.onMessage.addListener((message: unknown) =>
  handleRequest(message as BackgroundRequest).catch(
    (error: unknown): BackgroundResponse => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  ),
);

// Streams a helper endpoint to a port: the content script posts the request on
// the port and receives the endpoint's events. Closing the port cancels the fetch.
const STREAMS: Record<string, string> = { [ASK_PORT]: "/ask", [GUIDE_PORT]: "/guide" };

browser.runtime.onConnect.addListener((port: Browser.Runtime.Port) => {
  const path = STREAMS[port.name];
  if (!path) return;
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());
  const send = (event: unknown) => {
    if (!abort.signal.aborted) port.postMessage(event);
  };

  port.onMessage.addListener(async (message: unknown) => {
    try {
      const res = await helperFetch(path, message, abort.signal);
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line) send(JSON.parse(line));
      }
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) } satisfies StreamEvent);
    }
  });
});
