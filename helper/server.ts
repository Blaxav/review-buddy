import {
  HELPER_PORT as PORT,
  type AskRequest,
  type GuideEvent,
  type GuideRequest,
  type PostCommentRequest,
  type PostCommentResponse,
  type PrRequest,
  type StreamEvent,
  type ThreadInfo,
  type ThreadRequest,
} from "../shared/protocol";
import { loadToken } from "./config";
import { postComment } from "./github";
import { streamGuide } from "./guide";
import { BusyError, getCheckout, getSession, resetSession } from "./session";

const TOKEN = loadToken();
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ask({ pr, question, selection }: AskRequest): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        if (event.type === "done" || event.type === "error") controller.close();
      };
      send({ type: "status", message: "Preparing checkout…" });
      try {
        const session = await getSession(pr, selection);
        session.ask(question, send);
      } catch (error) {
        send({ type: "error", message: errorMessage(error) });
      }
    },
  });
  return new Response(stream, { headers: { ...CORS_HEADERS, "Content-Type": "application/x-ndjson" } });
}

// Streams the smart review: the triage, Claude's progress, then the guide.
// The grouping goes on when the reader leaves, so a cancelled stream only stops sending.
function guide({ pr, regroup }: GuideRequest): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: GuideEvent) => {
        if (open) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        await streamGuide(pr, regroup ?? false, send);
      } catch (error) {
        send({ type: "error", message: errorMessage(error) });
      }
      if (open) controller.close();
      open = false;
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, { headers: { ...CORS_HEADERS, "Content-Type": "application/x-ndjson" } });
}

async function handle(req: Request): Promise<Response> {
  // Rejecting other Host headers blocks DNS-rebinding pages from reaching the helper.
  if (!ALLOWED_HOSTS.has(req.headers.get("host") ?? "")) return new Response("Forbidden", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ error: "Invalid token" }, 401);

  const { pathname } = new URL(req.url);
  try {
    switch (`${req.method} ${pathname}`) {
      case "GET /health":
        return json({ ok: true });
      case "POST /ask":
        return ask((await req.json()) as AskRequest);
      case "POST /guide":
        return guide((await req.json()) as GuideRequest);
      case "POST /warm": {
        const { pr, selection } = (await req.json()) as PrRequest;
        (await getSession(pr, selection)).start();
        return json({ ok: true });
      }
      case "POST /thread": {
        // Opens a line thread: resolves its lines and starts its Claude process.
        const { pr, selection } = (await req.json()) as ThreadRequest;
        const session = await getSession(pr, selection);
        session.start();
        return json(session.thread satisfies ThreadInfo | undefined);
      }
      case "POST /stop": {
        const { pr, selection } = (await req.json()) as PrRequest;
        (await getSession(pr, selection)).stop();
        return json({ ok: true });
      }
      case "POST /reset": {
        const { pr, selection } = (await req.json()) as PrRequest;
        await resetSession(pr, selection);
        return json({ ok: true });
      }
      case "POST /comments": {
        const { pr, comment } = (await req.json()) as PostCommentRequest;
        const { info } = await getCheckout(pr);
        const response: PostCommentResponse = { url: await postComment(pr, info.headRefOid, comment) };
        return json(response);
      }
      default:
        return json({ error: "Not found" }, 404);
    }
  } catch (error) {
    const status = error instanceof BusyError ? 409 : 500;
    return json({ error: errorMessage(error) }, status);
  }
}

Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: handle, idleTimeout: 0 });
console.log(`review-ai helper listening on http://127.0.0.1:${PORT}`);
