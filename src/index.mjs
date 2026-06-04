#!/usr/bin/env node
// MCP server: delegates heavy token tasks from Claude Code to DeepSeek.
// Zero dependencies — Node.js 20+ built-ins only.
// JSON-RPC 2.0 over stdio with Content-Length framing (MCP spec compliant).

import { createInterface } from 'readline';
import { handleToolCall, TOOLS } from './tools.mjs';
import { getDefaultModel } from './models.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'claude-code-deepseek-delegator';
const SERVER_VERSION = '2.0.0';

let buffer = '';
let initialized = false;
let shuttingDown = false;
const inFlightRequests = new Set();

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
    const promise = handle(msg.method, msg.id, msg.params || {}).catch((err) => {
      if (msg.id !== undefined) error(msg.id, -32603, err.message);
    });
    inFlightRequests.add(promise);
    promise.finally(() => inFlightRequests.delete(promise));
  });
  buffer = remainder;
});

// Graceful shutdown: wait up to 5s for in-flight requests to complete
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`${signal || 'stdin end'} received, shutting down gracefully...\n`);

  if (inFlightRequests.size > 0) {
    process.stderr.write(`Waiting for ${inFlightRequests.size} in-flight request(s) to complete (max 5s)...\n`);
    const GRACEFUL_TIMEOUT = 5000;
    const timeout = new Promise((r) =>
      setTimeout(() => {
        process.stderr.write('Graceful shutdown timeout reached, exiting.\n');
        r();
      }, GRACEFUL_TIMEOUT)
    );
    await Promise.race([
      Promise.allSettled([...inFlightRequests]),
      timeout,
    ]);
  }

  process.exit(0);
}

process.stdin.on('end', () => gracefulShutdown('stdin end'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Startup log to stderr (not stdout — MCP uses stdout for JSON-RPC)
process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} ready. Default model: ${getDefaultModel()}\n`);
