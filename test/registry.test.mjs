// Provider registry + delegation config. The compat contract lives here:
// no config file + DEEPSEEK_API_KEY ⇒ exactly v2 behavior.

import { test, beforeEach } from 'node:test';
import { ok, equal, deepEqual, throws } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadProviders, listProviders, getProvider, resolveApiKey, keyEnvVar, resolveModel,
} from '../src/providers/registry.mjs';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.mjs';

function sandboxHome() {
  const home = mkdtempSync(join(tmpdir(), 'delg-reg-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  process.env.CLAUDE_DELEGATOR_HOME = home;
  return home;
}

beforeEach(() => {
  delete process.env.CLAUDE_DELEGATOR_HOME;
  delete process.env.DELEGATOR_CONFIG;
  loadProviders({ fresh: true });
});

// ── vendored configs ────────────────────────────────────────────────────────

test('vendored providers load and include deepseek with both v4 models', () => {
  const ds = getProvider('deepseek');
  ok(ds, 'deepseek provider present');
  equal(ds.api_endpoint, 'https://api.deepseek.com/v1');
  ok(ds.models.some((m) => m.id === 'deepseek-v4-pro'));
  ok(ds.models.some((m) => m.id === 'deepseek-v4-flash'));
  ok(loadProviders().size >= 7, 'all vendored providers load');
});

test('every vendored provider has the fields the engine relies on', () => {
  for (const p of listProviders()) {
    ok(p.id && p.name && p.api_endpoint, `${p.id}: identity + endpoint`);
    ok(p.default_large_model_id, `${p.id}: default large model`);
    ok(p.models.length > 0, `${p.id}: has models`);
    for (const m of p.models) {
      ok(typeof m.cost_per_1m_in === 'number' && typeof m.cost_per_1m_out === 'number', `${p.id}/${m.id}: pricing`);
      ok(typeof m.context_window === 'number' && m.context_window > 0, `${p.id}/${m.id}: context window`);
    }
  }
});

// ── key resolution ──────────────────────────────────────────────────────────

test('resolveApiKey resolves $ENV references against the environment', () => {
  const ds = getProvider('deepseek');
  equal(keyEnvVar(ds), 'DEEPSEEK_API_KEY');
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-reg-test';
  equal(resolveApiKey(ds), 'sk-reg-test');
  delete process.env.DEEPSEEK_API_KEY;
  equal(resolveApiKey(ds), null, 'unset env ⇒ null');
  if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
});

test('resolveApiKey passes literal (non-$) keys through as-is', () => {
  equal(resolveApiKey({ api_key: 'sk-literal' }), 'sk-literal');
  equal(keyEnvVar({ api_key: 'sk-literal' }), null);
});

// ── model resolution ────────────────────────────────────────────────────────

test('empty spec resolves to the active provider default large model', () => {
  const { provider, model } = resolveModel(null, 'deepseek');
  equal(provider.id, 'deepseek');
  equal(model.id, 'deepseek-v4-pro');
});

test('provider:model spec works, including openrouter ids containing "/"', () => {
  const { provider, model } = resolveModel('openrouter:deepseek/deepseek-v4-pro', 'deepseek');
  equal(provider.id, 'openrouter');
  equal(model.id, 'deepseek/deepseek-v4-pro');
});

test('bare model id prefers the active provider, then searches all', () => {
  const inActive = resolveModel('deepseek-v4-flash', 'deepseek');
  equal(inActive.provider.id, 'deepseek');
  const elsewhere = resolveModel('kimi-k2.5', 'deepseek');
  equal(elsewhere.provider.id, 'moonshot');
});

test('resolution failures name the valid options', () => {
  throws(() => resolveModel('nope:whatever', 'deepseek'), /Unknown provider "nope"/);
  throws(() => resolveModel('deepseek:not-a-model', 'deepseek'), /Available:/);
  throws(() => resolveModel('totally-unknown-model', 'deepseek'), /provider:model-id/);
  throws(() => resolveModel(null, 'ghost-provider'), /Unknown provider "ghost-provider"/);
});

// ── user providers file ─────────────────────────────────────────────────────

test('delegator-providers.json adds a custom OpenAI-compatible endpoint', () => {
  const home = sandboxHome();
  writeFileSync(join(home, '.claude', 'delegator-providers.json'), JSON.stringify({
    name: 'Local Ollama', id: 'ollama', type: 'openai-compat',
    api_key: 'unused', api_endpoint: 'http://localhost:11434/v1',
    default_large_model_id: 'qwen3-coder',
    models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder', cost_per_1m_in: 0, cost_per_1m_out: 0, context_window: 128000, default_max_tokens: 8192 }],
  }));
  loadProviders({ fresh: true });
  const { provider, model } = resolveModel('ollama:qwen3-coder');
  equal(provider.api_endpoint, 'http://localhost:11434/v1');
  equal(model.id, 'qwen3-coder');
  ok(listProviders().find((p) => p.id === 'ollama').available, 'literal key ⇒ available');
});

test('a malformed user providers file is ignored, vendored providers survive', () => {
  const home = sandboxHome();
  writeFileSync(join(home, '.claude', 'delegator-providers.json'), '{ broken');
  const providers = loadProviders({ fresh: true });
  ok(providers.has('deepseek'), 'vendored registry unaffected');
});

// ── config defaults (the v2 compat contract) ────────────────────────────────

test('no config file ⇒ exact v2 defaults: deepseek, v4-pro everywhere, Opus baseline', () => {
  sandboxHome(); // empty .claude — no delegator.json
  const cfg = loadConfig();
  deepEqual(cfg, {
    provider: 'deepseek',
    mode: 'auto',
    shortlist: [],
    routing: { read: 'deepseek-v4-pro', write: 'deepseek-v4-pro', reason: 'deepseek-v4-pro' },
    baseline: 'opus-4.8',
  });
});

test('config file merges over defaults, unknown keys ignored, malformed tolerated', () => {
  const home = sandboxHome();
  const file = join(home, '.claude', 'delegator.json');
  writeFileSync(file, JSON.stringify({ provider: 'moonshot', routing: { read: 'kimi-k2.5' }, baseline: 'sonnet-5', junk: 1 }));
  const cfg = loadConfig();
  equal(cfg.provider, 'moonshot');
  equal(cfg.routing.read, 'kimi-k2.5');
  equal(cfg.routing.write, DEFAULT_CONFIG.routing.write, 'unspecified task keeps default');
  equal(cfg.baseline, 'sonnet-5');

  writeFileSync(file, 'not json');
  deepEqual(loadConfig(), structuredClone(DEFAULT_CONFIG), 'malformed ⇒ defaults');
});
