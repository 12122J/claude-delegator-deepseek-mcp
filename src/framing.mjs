// MCP stdio transport framing: newline-delimited JSON-RPC.
//
// Per the MCP spec, stdio messages are "delimited by newlines, and MUST NOT
// contain embedded newlines." Each line on stdin is one complete JSON-RPC
// message; each message we send is one JSON object followed by '\n'.
//
// (Earlier versions used LSP-style Content-Length framing, which MCP stdio does
// NOT use — that is why clients reported "failed to connect".)
//
// Pure and side-effect-free so it can be unit-tested without booting the server.

/**
 * Parse every complete newline-delimited JSON message available in `input`.
 * Calls `onMessage(parsedJson)` for each, and returns the raw message strings
 * consumed plus the remainder (a partial final line awaiting more bytes).
 *
 * Tolerates CRLF line endings and skips blank or non-JSON lines rather than
 * desyncing the stream.
 */
export function parseLines(input, onMessage) {
  let buf = input;
  const consumed = [];

  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    let line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);

    if (line.endsWith('\r')) line = line.slice(0, -1); // tolerate CRLF
    const trimmed = line.trim();
    if (!trimmed) continue; // ignore blank lines

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue; // ignore non-JSON lines instead of breaking the stream
    }

    consumed.push(trimmed);
    if (onMessage) onMessage(msg);
  }

  return { consumed, remainder: buf };
}
