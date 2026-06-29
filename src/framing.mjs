// Content-Length framed JSON-RPC reader (MCP stdio transport).
//
// Pure, side-effect-free: this module is safe to import from tests without
// booting the server. index.mjs imports parseFrames from here.

/**
 * Parse as many complete Content-Length framed messages as are available in
 * `input`. Calls `onMessage(parsedJson)` for each valid frame and returns the
 * list of consumed raw bodies plus the unparsed remainder (a partial frame
 * still waiting for more bytes).
 */
export function parseFrames(input, onMessage) {
  let buf = input;
  const consumed = [];

  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buf.slice(0, headerEnd);
    // Reject frames with duplicate Content-Length headers (RFC 9112 §6.5.7)
    const clMatches = header.match(/^Content-Length:\s*(\d+)/gim);
    if (!clMatches) {
      // No Content-Length header — discard this header block as malformed.
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    if (clMatches.length > 1) {
      // Malformed: multiple Content-Length headers — we can't trust the body
      // boundary, so drop only this header block and keep going. Clearing the
      // whole buffer would also discard valid frames already queued behind it
      // (protocol desync). Same recovery as the no-Content-Length case above.
      buf = buf.slice(headerEnd + 4);
      continue;
    }

    const contentLengthMatch = header.match(/^Content-Length:\s*(\d+)/im);
    const contentLength = parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + contentLength) break;

    const body = buf.slice(bodyStart, bodyStart + contentLength);
    buf = buf.slice(bodyStart + contentLength);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }

    consumed.push(body);
    if (onMessage) onMessage(msg);
  }

  return { consumed, remainder: buf };
}
