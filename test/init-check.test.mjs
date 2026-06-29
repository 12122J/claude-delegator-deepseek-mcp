// Tests: MCP spec initialization gate (issue #32)
// Verifies that non-initialize methods return -32002 ("Server not initialized")
// when called before the 'initialize' handshake.
//
// Run: node --test test/init-check.test.mjs

import { describe, it, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { deepStrictEqual, ok } from 'node:assert';

const SERVER_SCRIPT = new URL('../src/index.mjs', import.meta.url).pathname;
const TIMEOUT = 5000;

// ---------------------------------------------------------------------------
// Helpers — lightweight JSON-RPC client with Content-Length framing
// ---------------------------------------------------------------------------

function createConnection() {
  let server;
  let pending = new Map();
  let idCounter = 0;

  function sendFrame(method, params, hasId) {
    const id = hasId ? ++idCounter : undefined;
    const msg = { jsonrpc: '2.0', method, params };
    if (hasId) msg.id = id;
    const frame = JSON.stringify(msg) + '\n'; // newline-delimited (MCP stdio)

    return new Promise((resolve, reject) => {
      if (hasId) pending.set(id, resolve);
      server.stdin.write(frame);
      if (hasId) {
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method} (id=${id})`));
          }
        }, TIMEOUT);
      } else {
        // Notification — resolve after a tick
        setTimeout(resolve, 50);
      }
    });
  }

  let accumulator = '';

  function handler(data) {
    accumulator += data.toString('utf8');

    // Newline-delimited JSON: process each complete line.
    let nl;
    while ((nl = accumulator.indexOf('\n')) !== -1) {
      const line = accumulator.slice(0, nl).trim();
      accumulator = accumulator.slice(nl + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server start timeout')), TIMEOUT);

      server = spawn(process.execPath, [SERVER_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      server.stderr.on('data', (chunk) => {
        if (chunk.toString().includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });

      server.stdout.on('data', handler);
      server.on('error', reject);
    });
  }

  async function stop() {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.on('close', r));
    }
  }

  return {
    start,
    stop,
    request: (method, params = {}) => sendFrame(method, params, true),
    notify: (method, params = {}) => sendFrame(method, params, false),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP initialization gate (issue #32)', () => {

  describe('before initialize', () => {
    let conn;
    before(async () => { conn = createConnection(); await conn.start(); });
    after(async () => { await conn.stop(); });

    it('rejects tools/call with -32002', async () => {
      const res = await conn.request('tools/call', { name: 'deepseek', arguments: { prompt: 'hi' } });
      deepStrictEqual(res.error, { code: -32002, message: 'Server not initialized' });
    });

    it('rejects tools/list with -32002', async () => {
      const res = await conn.request('tools/list');
      deepStrictEqual(res.error, { code: -32002, message: 'Server not initialized' });
    });

    it('rejects unknown methods with -32002', async () => {
      const res = await conn.request('resources/read', { uri: 'file:///test' });
      deepStrictEqual(res.error, { code: -32002, message: 'Server not initialized' });
    });

    it('accepts initialize request even when uninitialized', async () => {
      const res = await conn.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      });
      deepStrictEqual(res.result.protocolVersion, '2024-11-05');
      deepStrictEqual(res.result.capabilities, { tools: {} });
      ok(res.result.serverInfo.name);
    });
  });

  describe('after initialize', () => {
    let conn;
    before(async () => {
      conn = createConnection();
      await conn.start();
      await conn.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      });
    });
    after(async () => { await conn.stop(); });

    it('allows tools/list after initialize', async () => {
      const res = await conn.request('tools/list');
      ok(Array.isArray(res.result.tools));
      ok(res.result.tools.length > 0);
    });

    it('allows tools/call (deepseek_models) after initialize', async () => {
      const res = await conn.request('tools/call', { name: 'deepseek_models', arguments: {} });
      ok(res.result.content);
      ok(res.result.content[0].type === 'text');
    });

    it('returns -32601 for unknown methods after initialize', async () => {
      const res = await conn.request('resources/read', { uri: 'file:///test' });
      deepStrictEqual(res.error.code, -32601);
    });
  });

  describe('notifications/initialized edge case', () => {
    let conn;
    before(async () => { conn = createConnection(); await conn.start(); });
    after(async () => { await conn.stop(); });

    it('does not crash when notifications/initialized sent first', async () => {
      await conn.notify('notifications/initialized');
      // Verify server still works by sending initialize
      const res = await conn.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      });
      ok(res.result.protocolVersion);
    });
  });
});
