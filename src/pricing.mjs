// Pricing per 1M tokens (USD). Updated June 2026.

import { color, bold, dim } from './colors.mjs';

export const PRICING = {
  'deepseek-v4-pro': { input: 0.435, output: 0.87, cache: 0.003625 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cache: 0.0012 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cache: 0.0046 },
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
  ];

  // Show cache breakdown when cache hits were reported
  const cached = usage.cachedPromptTokens || 0;
  if (cached > 0 && dsPricing.cache) {
    const cacheCost = (cached / 1_000_000) * dsPricing.cache;
    const computePromptTokens = usage.promptTokens - cached;
    const computePricing = { ...dsPricing };
    // Compute cost uses cache-miss (input) rate for non-cached prompt tokens
    computePricing.cache = undefined;
    const computeCost = calculateCost(computePromptTokens, usage.completionTokens, computePricing);
    lines.push(
      `  ${dim('cache')} ${dim(formatCost(cacheCost))} + ${dim('compute')} ${dim(formatCost(computeCost))}`
    );
  }

  lines.push(
    `${color('green', 'saved')} ${bold(formatCost(saved))} ${color('green', '(' + pct + '%)')}  │  ${dim(usage.totalTokens.toLocaleString() + ' tokens')} ${dim('(' + usage.promptTokens.toLocaleString() + 'p + ' + usage.completionTokens.toLocaleString() + 'c)')}`,
    dim('────────────────────────────────'),
  );

  return lines.join('\n');
}
