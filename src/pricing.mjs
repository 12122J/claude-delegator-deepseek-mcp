// Pricing per 1M tokens (USD). Updated June 2026.

import { color, bold, dim } from './colors.mjs';

export const PRICING = {
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
};

// Claude comparison baseline (Sonnet 4)
export const CLAUDE_PRICING = { input: 3.00, output: 15.00 };

export function calculateCost(inputTokens, outputTokens, pricing) {
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export function formatCost(amount) {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatSavings(deepseekCost, claudeCost) {
  const saved = claudeCost - deepseekCost;
  const pct = claudeCost > 0 ? ((saved / claudeCost) * 100).toFixed(0) : 0;
  return { saved, pct };
}

export function buildFooter(result, model) {
  const usage = result.usage;
  if (!usage) return '';

  const dsPricing = PRICING[model] || PRICING['deepseek-v4-pro'];
  const dsCost = calculateCost(usage.promptTokens, usage.completionTokens, dsPricing);
  const claudeCost = calculateCost(usage.promptTokens, usage.completionTokens, CLAUDE_PRICING);
  const { saved, pct } = formatSavings(dsCost, claudeCost);

  const lines = [
    '',
    dim('─── claude-code-deepseek-delegator · cost ───'),
    `${color('green', 'deepseek')} ${dim(model.replace('deepseek-',''))} ${dim(formatCost(dsCost))}  │  ${color('yellow', 'claude sonnet 4')} ${dim(formatCost(claudeCost))}`,
    `${color('green', 'saved')} ${bold(formatCost(saved))} ${color('green', '(' + pct + '%)')}  │  ${dim(usage.totalTokens.toLocaleString() + ' tokens')} ${dim('(' + usage.promptTokens.toLocaleString() + 'p + ' + usage.completionTokens.toLocaleString() + 'c)')}`,
    dim('────────────────────────────────'),
  ];

  return lines.join('\n');
}
