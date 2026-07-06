// Pricing per 1M tokens (USD). Updated June 2026.
// NOTE: Pricing must stay in sync with models.mjs — add entries to both files.

import { dim } from './colors.mjs';

export const PRICING = {
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
};

// Claude comparison baseline (Opus 4.8)
export const CLAUDE_PRICING = { input: 5.00, output: 25.00 };

export function calculateCost(inputTokens, outputTokens, pricing) {
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export function formatCost(amount) {
  if (amount > 0 && amount < 0.0001) return '<$0.0001'; // never render a real cost as $0.0000
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatSavings(deepseekCost, claudeCost) {
  const saved = claudeCost - deepseekCost;
  const pct = claudeCost > 0 ? Math.round((saved / claudeCost) * 100) : 0;
  return { saved, pct };
}

export function buildFooter(result, model) {
  const usage = result.usage;
  if (!usage) return '';

  const dsPricing = PRICING[model] || PRICING['deepseek-v4-pro'];
  const dsCost = calculateCost(usage.promptTokens, usage.completionTokens, dsPricing);
  const claudeCost = calculateCost(usage.promptTokens, usage.completionTokens, CLAUDE_PRICING);
  const { saved, pct } = formatSavings(dsCost, claudeCost);

  const modelStr = model.replace('deepseek-', '');
  const dsCostStr = formatCost(dsCost);
  const savedStr = formatCost(saved);
  const totalStr = (usage.totalTokens ?? 0).toLocaleString();

  // One clean line, styled to sit under the tool call like Claude Code's own
  // `⎿` result lines. This same text is what the PostToolUse hook surfaces to
  // the user as a native systemMessage, so the transcript and the hook match.
  const summary = `deepseek ${modelStr} · saved ${savedStr} (${pct}% vs Opus) · spent ${dsCostStr} · ${totalStr} tokens`;

  // Machine-readable marker consumed by the PostToolUse cost hook (wiring.mjs),
  // which surfaces `line` to the user as a systemMessage. The hook matches
  // /deepseek-cost:(\{.*?\})/ — non-greedy, stops at the FIRST "}" — so the
  // object must stay flat (no nested braces) and `line` must never contain
  // braces. Kept on its own line so nothing can split the JSON.
  const meta = {
    v: 1,
    model,
    cost: Number(dsCost.toFixed(6)),
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
