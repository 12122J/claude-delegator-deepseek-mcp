// Task routing, proven end to end: a mock OpenAI-compatible server captures
// what actually hits the wire, so these tests pin the full chain
// task → delegator.json routing → registry → HTTP body.model.

import { test, before, after } from 'node:test';
import { ok, equal, match } from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProviders } from '../src/providers/registry.mjs';
import { resolveDelegation, handleToolCall } from '../src/tools.mjs';

let server;
let port;
let captured; // last request body the mock provider received

before(async () => {
  // Mock OpenAI-compatible endpoint that records the model it was asked for.
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured = { path: req.url, body: JSON.parse(body), auth: req.headers.authorization };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: captured.body.model,
        choices: [{ message: { content: `answered by ${captured.body.model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  // Sandbox home: a mock provider with a small + big model, routed by task.
  const home = mkdtempSync(join(tmpdir(), 'delg-route-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  process.env.CLAUDE_DELEGATOR_HOME = home;
  writeFileSync(join(home, '.claude', 'delegator-providers.json'), JSON.stringify({
    name: 'Mock', id: 'mock', type: 'openai-compat',
    api_key: 'sk-mock', api_endpoint: `http://127.0.0.1:${port}/v1`,
    default_large_model_id: 'mock-big', default_small_model_id: 'mock-small',
    models: [
      { id: 'mock-small', name: 'S', cost_per_1m_in: 0.1, cost_per_1m_out: 0.2, context_window: 128000, default_max_tokens: 4096 },
      { id: 'mock-big', name: 'B', cost_per_1m_in: 1, cost_per_1m_out: 2, context_window: 128000, default_max_tokens: 4096 },
    ],
  }));
  writeFileSync(join(home, '.claude', 'delegator.json'), JSON.stringify({
    provider: 'mock',
    routing: { read: 'mock-small', write: 'mock-big', reason: 'mock-big' },
    baseline: 'opus-4.8',
  }));
  loadProviders({ fresh: true });
});

after(() => {
  server.close();
  delete process.env.CLAUDE_DELEGATOR_HOME;
  loadProviders({ fresh: true });
});

// ── the precedence truth table (no network) ────────────────────────────────

test('task routing resolves each task to its configured model', () => {
  equal(resolveDelegation({ task: 'read' }).model.id, 'mock-small');
  equal(resolveDelegation({ task: 'write' }).model.id, 'mock-big');
  equal(resolveDelegation({ task: 'reason' }).model.id, 'mock-big');
});

test('no task ⇒ active provider default; explicit model beats task routing', () => {
  equal(resolveDelegation({}).model.id, 'mock-big', 'default_large_model_id');
  equal(resolveDelegation({ task: 'read', model: 'mock-big' }).model.id, 'mock-big', 'model wins over task');
  const cross = resolveDelegation({ task: 'read', model: 'deepseek:deepseek-v4-pro' });
  equal(cross.provider.id, 'deepseek', 'cross-provider model spec wins');
});

// ── the wire (full handleToolCall → HTTP → footer round trip) ──────────────

test('task:"read" puts the routed model id in the HTTP request', async () => {
  const res = await handleToolCall('delegate', { prompt: 'summarize this', task: 'read' });
  equal(captured.body.model, 'mock-small', 'the wire saw the routed model');
  equal(captured.path, '/v1/chat/completions');
  equal(captured.auth, 'Bearer sk-mock');
  const text = res.content[0].text;
  ok(text.includes('answered by mock-small'), 'response came from the mock');
  match(text, /delegate mock-small via mock · saved /, 'receipt names model and provider');
});

test('task:"reason" routes to the big model on the wire', async () => {
  await handleToolCall('delegate', { prompt: 'prove it', task: 'reason' });
  equal(captured.body.model, 'mock-big');
});

test('the v2 alias tool routes identically', async () => {
  await handleToolCall('deepseek', { prompt: 'hi', task: 'read' });
  equal(captured.body.model, 'mock-small');
});

test('an unknown routing target fails loudly, not silently', () => {
  const bad = { provider: 'mock', routing: { read: 'no-such-model', write: 'mock-big', reason: 'mock-big' }, baseline: 'opus-4.8' };
  let threw = false;
  try { resolveDelegation({ task: 'read' }, { ...bad, mode: 'auto', shortlist: [] }); }
  catch (e) { threw = true; ok(e.message.includes('no-such-model'), 'names the bad id'); }
  ok(threw, 'misconfigured routing throws');
});
