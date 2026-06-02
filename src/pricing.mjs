// Pricing per 1M tokens (USD). Updated June 2026.

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
  return `$${amount.toFixed(4)}`;
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

  return [
    '',
    '─── cost ───',
    `deepseek (${model}): ${formatCost(dsCost)}  |  claude sonnet 4: ${formatCost(claudeCost)}`,
    `saved: ${formatCost(saved)} (${pct}%)  |  ${usage.totalTokens.toLocaleString()} tokens (${usage.promptTokens.toLocaleString()}p + ${usage.completionTokens.toLocaleString()}c)`,
  ].join('\n');
}
