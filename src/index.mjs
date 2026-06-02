#!/usr/bin/env node
// MCP server: delegates heavy token tasks from Claude Code to DeepSeek.
// Zero dependencies — Node.js 20+ built-ins only.
// JSON-RPC 2.0 over stdio with Content-Length framing (MCP spec compliant).

import { createInterface } from 'readline';
import { handleToolCall, TOOLS } from './tools.mjs';
import { getDefaultModel } from './models.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'deepseek-mcp';
const SERVER_VERSION = '2.0.0';

let buffer = '';

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
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'notifications/initialized':
      return;

    case 'tools/list':
      return respond(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await handleToolCall(name, args || {});
        return respond(id, result);
      } catch (err) {
        return respond(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
  }
}

// Content-Length framed JSON-RPC reader
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!contentLengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }

    handle(msg.method, msg.id, msg.params || {}).catch((err) => {
      if (msg.id !== undefined) error(msg.id, -32603, err.message);
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Startup log to stderr (not stdout — MCP uses stdout for JSON-RPC)
process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} ready. Default model: ${getDefaultModel()}\n`);
