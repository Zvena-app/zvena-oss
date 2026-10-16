// Server-Sent Events response with a heartbeat for streaming routes.
// Comments (": ping") keep proxies (a CDN, nginx)
// from closing an idle stream; the client parser only reads `data:` lines.

export interface SseWriter {
  send(obj: unknown): void;
  /** True once the client went away or the stream was closed. */
  readonly closed: boolean;
}

export function sseResponse(signal: AbortSignal, run: (w: SseWriter) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const hb = setInterval(() => write(": ping\n\n"), 15_000);
      const onAbort = () => {
        closed = true;
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const w: SseWriter = {
        send: (obj) => write(`data: ${JSON.stringify(obj)}\n\n`),
        get closed() {
          return closed || signal.aborted;
        },
      };
      try {
        await run(w);
      } catch {
        w.send({ error: "stream failed" });
      } finally {
        clearInterval(hb);
        signal.removeEventListener("abort", onAbort);
        write("data: [DONE]\n\n");
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
