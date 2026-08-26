import type { Response } from "express";

/** Opens a Server-Sent Events response.
 *
 * `flushHeaders` matters: without it Express holds the response head until the
 * first `write`, so the client sees nothing until the model produces its first
 * token. `no-transform` + `X-Accel-Buffering` stop compression/proxy layers
 * from buffering the body, which is what makes "streaming" arrive in one lump.
 */
export function openSseStream(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

/** One SSE frame. Note the real newlines — a `"\\n"` in a double-quoted string
 * is a literal backslash-n and produces a frame no client can parse. */
function writeFrame(res: Response, body: string): void {
  res.write(`${body}\n\n`);
}

export type PumpResult = {
  /** Everything successfully produced by the model, including on abort. */
  text: string;
  /** True when the client hung up before the model finished. */
  aborted: boolean;
};

/**
 * Streams an async iterable of text chunks to the client as SSE `{ token }`
 * frames, then terminates with an `event: done` frame.
 *
 * Stops early when the client disconnects so an abandoned request doesn't keep
 * burning model tokens, and converts a mid-stream model failure into an
 * `{ error }` frame — throwing here would leave the socket open forever
 * because the headers have already been sent.
 */
export async function pumpTextStream(
  res: Response,
  textStream: AsyncIterable<string>
): Promise<PumpResult> {
  let text = "";
  let aborted = false;

  const onClose = () => {
    aborted = true;
  };
  res.on("close", onClose);

  try {
    for await (const chunk of textStream) {
      if (aborted || res.writableEnded) {
        aborted = true;
        break;
      }
      text += chunk;
      writeFrame(res, `data: ${JSON.stringify({ token: chunk })}`);
    }
  } catch (error) {
    if (!aborted && !res.writableEnded) {
      const message = error instanceof Error ? error.message : "Stream failed";
      writeFrame(res, `data: ${JSON.stringify({ error: message })}`);
    }
  } finally {
    res.off("close", onClose);
  }

  if (!aborted && !res.writableEnded) {
    writeFrame(res, "event: done\ndata: done");
    res.end();
  }

  return { text, aborted };
}
