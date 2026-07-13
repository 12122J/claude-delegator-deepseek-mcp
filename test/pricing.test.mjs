// Registry-driven cost math, baselines, and the frozen `deepseek-cost:` marker
// contract the installed v2 hooks depend on.

import { test } from 'node:test';
import { ok, equal, match } from 'node:assert/strict';
import { buildFooter, modelCost, BASELINES } from '../src/pricing.mjs';
import { resolveModel } from '../src/providers/registry.mjs';

const CTX = resolveModel('deepseek:deepseek-v4-pro');
const usage = (promptTokens, completionTokens, cachedTokens = 0) =>
  ({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens });

// The exact regex the installed PostToolUse hook uses (non-greedy, first "}").
const HOOK_RE = /deepseek-cost:(\{.*?\})/;

test('cost comes from the registry model entry', () => {
  // deepseek-v4-pro: $0.435 in / $0.87 out per 1M
  const cost = modelCost(usage(1_000_000, 1_000_000), CTX.model);
  ok(Math.abs(cost - (0.435 + 0.87)) < 1e-9);
});

test('cached prompt tokens bill at the cached input rate', () => {
  const cheap = modelCost(usage(1_000_000, 0, 1_000_000), CTX.model);
  ok(Math.abs(cheap - CTX.model.cost_per_1m_in_cached) < 1e-9, 'fully cached input costs the cached rate');
  const mixed = modelCost(usage(1_000_000, 0, 500_000), CTX.model);
  ok(Math.abs(mixed - (0.5 * 0.435 + 0.5 * CTX.model.cost_per_1m_in_cached)) < 1e-9);
});

test('opus baseline footer says "vs Opus", sonnet says "vs Sonnet"', () => {
  const opus = buildFooter({ usage: usage(10_000, 2_000) }, { ...CTX, baseline: 'opus-4.8' });
  ok(opus.includes('vs Opus'));
  const sonnet = buildFooter({ usage: usage(10_000, 2_000) }, { ...CTX, baseline: 'sonnet-5' });
  ok(sonnet.includes('vs Sonnet'));
  ok(!sonnet.includes('vs Opus'));
});

test('baseline "none" omits the savings claim entirely', () => {
  const footer = buildFooter({ usage: usage(10_000, 2_000) }, { ...CTX, baseline: 'none' });
  const meta = JSON.parse(footer.match(HOOK_RE)[1]);
  ok(!meta.line.includes('saved'), 'no savings claim in the visible line');
  ok(!meta.line.includes(' vs '), 'no comparison');
  ok(meta.line.includes('spent'), 'still shows spend');
  equal(meta.claudeCost, 0);
  equal(meta.saved, 0);
});

test('savings math against the baseline table', () => {
  const footer = buildFooter({ usage: usage(1_000_000, 1_000_000) }, CTX);
  const meta = JSON.parse(footer.match(HOOK_RE)[1]);
  const base = BASELINES['opus-4.8'];
  ok(Math.abs(meta.claudeCost - (base.input + base.output)) < 1e-6);
  ok(Math.abs(meta.saved - (meta.claudeCost - meta.cost)) < 1e-6);
  equal(meta.pct, Math.round((meta.saved / meta.claudeCost) * 100));
});

test('the marker stays flat, single-line, and hook-parseable, with provider id', () => {
  const footer = buildFooter({ usage: usage(12_345, 678) }, CTX);
  const markerLine = footer.split('\n').find((l) => l.startsWith('deepseek-cost:'));
  ok(markerLine, 'marker on its own line');
  const meta = JSON.parse(footer.match(HOOK_RE)[1]);
  equal(meta.provider, 'deepseek');
  equal(meta.model, 'deepseek-v4-pro');
  equal(meta.totalTokens, 13_023);
  match(meta.line, /^delegate deepseek-v4-pro via deepseek · saved/);
  ok(!meta.line.includes('{') && !meta.line.includes('}'), 'line must never contain braces');
  for (const v of Object.values(meta)) {
    ok(typeof v !== 'object', 'meta stays flat — nested braces would break the hook regex');
  }
});

test('cross-provider context prices with that provider entry', () => {
  const kimi = resolveModel('moonshot:kimi-k2.5');
  const footer = buildFooter({ usage: usage(10_000, 1_000) }, { ...kimi, baseline: 'opus-4.8' });
  const meta = JSON.parse(footer.match(HOOK_RE)[1]);
  equal(meta.provider, 'moonshot');
  ok(Math.abs(meta.cost - modelCost(usage(10_000, 1_000), kimi.model)) < 1e-9);
});

test('no usage ⇒ no footer', () => {
  equal(buildFooter({ usage: null }, CTX), '');
});
