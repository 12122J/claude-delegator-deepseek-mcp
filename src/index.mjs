#!/usr/bin/env node
// MCP server: delegates heavy token tasks from Claude Code to DeepSeek.
// Zero dependencies — Node.js 20+ built-ins only.
// JSON-RPC 2.0 over stdio with Content-Length framing (MCP spec compliant).

import { handleToolCall, TOOLS } from './tools.mjs';
import { getDefaultModel } from './models.mjs';
import { parseFrames } from './framing.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'claude-code-deepseek-delegator';
const SERVER_VERSION = '2.4.2';

// CLI subcommands. With NO subcommand — which is exactly how Claude Code spawns
// this binary — we skip all of this and fall through to the MCP server below.
const SUBCOMMAND = process.argv[2];
if (['init', 'setup', 'uninstall', 'remove', 'doctor', 'help', '--help', '-h', '--version', '-v'].includes(SUBCOMMAND)) {
  process.exit(await runCli(SUBCOMMAND, process.argv.slice(3)));
}

const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB — MCP messages should never exceed a few KB
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
  send({ jsonrpc: '2.0', id, error: { code, message: message ?? 'Internal error' } });
}

async function handle(method, id, params) {
  switch (method) {
    case 'initialize':
      if (initialized) return error(id, -32000, 'Already initialized');
      initialized = true;
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'ping':
      return respond(id, {});

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

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  if (buffer.length > MAX_BUFFER_SIZE) {
    process.stderr.write(`WARNING: buffer exceeded ${MAX_BUFFER_SIZE} bytes — flushing to prevent memory exhaustion\n`);
    buffer = '';
  }
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
if (!process.env.DEEPSEEK_API_KEY) {
  process.stderr.write(
    'WARNING: DEEPSEEK_API_KEY is not set. The server will start, but every ' +
    'deepseek tool call will fail with a 401 until you add the key to the "env" ' +
    'block of this server in your MCP config (e.g. ~/.claude/mcp.json).\n'
  );
}
process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} ready. Default model: ${getDefaultModel()}\n`);

// ── CLI handlers (only reached via the SUBCOMMAND branch above) ──
// Declarations are hoisted, so the early call works. Setup modules are loaded
// lazily so they never touch the hot server-startup path.
async function runCli(sub, args) {
  if (sub === 'init' || sub === 'setup') {
    const { runInit } = await import('./setup/init.mjs');
    return runInit(args);
  }
  if (sub === 'uninstall' || sub === 'remove') {
    const { runUninstall } = await import('./setup/uninstall.mjs');
    return runUninstall(args);
  }
  if (sub === 'doctor') {
    const { runDoctor } = await import('./setup/doctor.mjs');
    return runDoctor();
  }
  if (sub === '--version' || sub === '-v') {
    console.log(SERVER_VERSION);
    return 0;
  }
  printHelp();
  return 0;
}

function printHelp() {
  console.log(`
claude-code-deepseek-delegator — delegate heavy tasks from Claude Code to DeepSeek

Usage:
  npx claude-code-deepseek-delegator <command>

Commands:
  (no command)   Run the MCP server (this is how Claude Code launches it)
  init           Fully wire into Claude Code: MCP server + CLAUDE.md rules + hooks
  doctor         Verify the install and live-fire the gate hooks
  uninstall      Cleanly remove everything init added
  help           Show this help
  --version      Print version

init options:
  --dry-run      Show what would change, write nothing
  --no-hooks     Skip the settings.json hooks (rules-only, softer gate)
  --yes, -y      Non-interactive (don't prompt for the API key)
`);
}
