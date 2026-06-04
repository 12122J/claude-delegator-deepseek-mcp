#!/usr/bin/env node
// MCP server: delegates heavy token tasks from Claude Code to DeepSeek.
// Zero dependencies — Node.js 20+ built-ins only.
// JSON-RPC 2.0 over stdio with Content-Length framing (MCP spec compliant).

import { handleToolCall, TOOLS } from './tools.mjs';
import { getDefaultModel } from './models.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'claude-code-deepseek-delegator';
const SERVER_VERSION = '2.0.0';

let buffer = '';
let initialized = false;

function send(msg) {
  const payload = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(method, id, params) {
  switch (method) {
    case 'initialize':
      initialized = true;
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'notifications/initialized':
      return;

    case 'tools/list':
      if (!initialized) return error(id, -32002, 'Server not initialized');
      return respond(id, { tools: TOOLS });

    case 'tools/call': {
      if (!initialized) return error(id, -32002, 'Server not initialized');
      const { name, arguments: args } = params;
      try {
        const result = await handleToolCall(name, args || {});
        return respond(id, result);
      } catch (err) {
        return error(id, -32000, err.message);
      }
    }

    default:
      if (!initialized) {
        if (id !== undefined) error(id, -32002, 'Server not initialized');
        return;
      }
      if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
  }
}

// Content-Length framed JSON-RPC reader
// Exported for testing
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
      // No Content-Length header — discard as malformed
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    if (clMatches.length > 1) {
      // Malformed: multiple Content-Length headers — discard frame
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

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const { remainder } = parseFrames(buffer, (msg) => {
    handle(msg.method, msg.id, msg.params || {}).catch((err) => {
      if (msg.id !== undefined) error(msg.id, -32603, err.message);
    });
  });
  buffer = remainder;
});

// Graceful shutdown
process.stdin.on('end', () => {
  process.stderr.write('stdin closed, shutting down\n');
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Startup log to stderr (not stdout — MCP uses stdout for JSON-RPC)
process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} ready. Default model: ${getDefaultModel()}\n`);
