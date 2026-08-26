/** Incremental Server-Sent Events parser; accepts arbitrary network chunk boundaries. */
export async function* parseSse(chunks: AsyncIterable<Uint8Array | string>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let firstLine = true;
  const consume = (line: string): string | undefined => {
    if (firstLine) {
      firstLine = false;
      line = line.replace(/^\uFEFF/, "");
    }
    if (line === "") {
      if (!data.length) return undefined;
      const event = data.join("\n");
      data = [];
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    return undefined;
  };
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    while (true) {
      const lf = buffer.indexOf("\n");
      const cr = buffer.indexOf("\r");
      let end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      if (end < 0) break;
      // A CR at a chunk boundary may be the first half of CRLF; retain it
      // until the next chunk rather than manufacturing an empty event.
      if (buffer[end] === "\r" && end === buffer.length - 1) break;
      const line = buffer.slice(0, end);
      if (buffer[end] === "\r" && buffer[end + 1] === "\n") end += 1;
      buffer = buffer.slice(end + 1);
      const event = consume(line);
      if (event !== undefined) yield event;
    }
  }
  buffer += decoder.decode();
  // A server may close without a trailing blank line. Dispatch the final
  // data block so the last completion is not silently lost.
  if (buffer) {
    if (buffer.endsWith("\r")) {
      const lineEvent = consume(buffer.slice(0, -1));
      if (lineEvent !== undefined) yield lineEvent;
      const blockEvent = consume("");
      if (blockEvent !== undefined) yield blockEvent;
    } else {
      const event = consume(buffer);
      if (event !== undefined) yield event;
    }
  }
  if (data.length) yield data.join("\n");
}
