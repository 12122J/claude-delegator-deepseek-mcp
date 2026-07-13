// Cost math + the receipt footer. Model prices come from the provider
// registry (catwalk schema: cost_per_1m_in / cost_per_1m_out /
// cost_per_1m_in_cached, USD per 1M tokens) — there is no separate pricing
// table to keep in sync anymore.

import { dim } from './colors.mjs';

// Savings comparison baselines (USD per 1M tokens). "What would this have cost
// if Claude had done it in-context?" — configurable per install because
// "saved 94% vs Opus" and "saved 60% vs Sonnet" are different claims.
export const BASELINES = {
  'opus-4.8': { input: 5.0, output: 25.0, label: 'Opus' },
  'sonnet-5': { input: 3.0, output: 15.0, label: 'Sonnet' },
};

export function calculateCost(inputTokens, outputTokens, pricing) {
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// Cost of a call given the registry model entry, billing cached prompt tokens
// at the cached rate when the provider reported them.
export function modelCost(usage, model) {
  const cached = usage.cachedTokens > 0 && typeof model.cost_per_1m_in_cached === 'number'
    ? usage.cachedTokens : 0;
  const freshIn = Math.max(0, (usage.promptTokens ?? 0) - cached);
  return (freshIn / 1_000_000) * (model.cost_per_1m_in ?? 0)
    + (cached / 1_000_000) * model.cost_per_1m_in_cached
    + ((usage.completionTokens ?? 0) / 1_000_000) * (model.cost_per_1m_out ?? 0);
}

export function formatCost(amount) {
  if (amount > 0 && amount < 0.0001) return '<$0.0001'; // never render a real cost as $0.0000
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatSavings(delegatedCost, claudeCost) {
  const saved = claudeCost - delegatedCost;
  const pct = claudeCost > 0 ? Math.round((saved / claudeCost) * 100) : 0;
  return { saved, pct };
}

export function buildFooter(result, { provider, model, baseline = 'opus-4.8' }) {
  const usage = result.usage;
  if (!usage) return '';

  const cost = modelCost(usage, model);
  const base = BASELINES[baseline];
  const claudeCost = base ? calculateCost(usage.promptTokens ?? 0, usage.completionTokens ?? 0, base) : 0;
  // No baseline ⇒ no savings claim at all (not a negative "saving").
  const { saved, pct } = base ? formatSavings(cost, claudeCost) : { saved: 0, pct: 0 };

  const costStr = formatCost(cost);
  const totalStr = (usage.totalTokens ?? 0).toLocaleString();

  // One clean line, styled to sit under the tool call like Claude Code's own
  // `⎿` result lines. This same text is what the PostToolUse hook surfaces to
  // the user as a native systemMessage, so the transcript and the hook match.
  const summary = base
    ? `delegate ${model.id} via ${provider.id} · saved ${formatCost(saved)} (${pct}% vs ${base.label}) · spent ${costStr} · ${totalStr} tokens`
    : `delegate ${model.id} via ${provider.id} · spent ${costStr} · ${totalStr} tokens`;

  // Machine-readable marker consumed by the PostToolUse cost hook (wiring.mjs),
  // which surfaces `line` to the user as a systemMessage. The hook matches
  // /deepseek-cost:(\{.*?\})/ — non-greedy, stops at the FIRST "}" — so the
  // object must stay flat (no nested braces) and `line` must never contain
  // braces. Kept on its own line so nothing can split the JSON. The marker
  // name is frozen for compatibility with hooks installed by v2.
  const meta = {
    v: 2,
    provider: provider.id,
    model: model.id,
    cost: Number(cost.toFixed(6)),
    claudeCost: Number(claudeCost.toFixed(6)),
    saved: Number(saved.toFixed(6)),
    pct,
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    line: summary,
  };

  const lines = [
    '',
    dim(`⎿ ${summary}`),
    `deepseek-cost:${JSON.stringify(meta)}`,
  ];

  return lines.join('\n');
}
