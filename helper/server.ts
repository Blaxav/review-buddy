import {
  HELPER_PORT as PORT,
  type AskRequest,
  type PostCommentRequest,
  type PostCommentResponse,
  type PrRequest,
  type StreamEvent,
} from "../shared/protocol";
import { loadToken } from "./config";
import { postComment } from "./github";
import { BusyError, getSession, resetSession } from "./session";

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

function ask({ pr, question }: AskRequest): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        if (event.type === "done" || event.type === "error") controller.close();
      };
      send({ type: "status", message: "Preparing checkout…" });
      try {
        const session = await getSession(pr);
        session.ask(question, send);
      } catch (error) {
        send({ type: "error", message: errorMessage(error) });
      }
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
      case "POST /warm": {
        const { pr } = (await req.json()) as PrRequest;
        (await getSession(pr)).start();
        return json({ ok: true });
      }
      case "POST /stop": {
        const { pr } = (await req.json()) as PrRequest;
        (await getSession(pr)).stop();
        return json({ ok: true });
      }
      case "POST /reset": {
        const { pr } = (await req.json()) as PrRequest;
        await resetSession(pr);
        return json({ ok: true });
      }
      case "POST /comments": {
        const { pr, comment } = (await req.json()) as PostCommentRequest;
        const session = await getSession(pr);
        const response: PostCommentResponse = { url: await postComment(pr, session.headSha, comment) };
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
