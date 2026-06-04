// DeepSeek model registry
// Each entry defines model capabilities, context window, and pricing tier.
// NOTE: Models must stay in sync with pricing.mjs — add entries to both files.

export const MODELS = {
  'deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    thinking: true,
    description: 'Smartest model with thinking capability. Best for complex analysis, code generation, architecture, and multi-step reasoning.',
  },
  'deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    thinking: true,
    description: 'Faster and cheaper model. Best for simpler tasks, quick answers, and when latency matters more than depth.',
  },
  'deepseek-reasoner': {
    name: 'DeepSeek Reasoner',
    contextWindow: 65536,
    maxOutputTokens: 8192,
    thinking: true,
    description: 'Specialized reasoning model. Best for math, logic, and problems requiring step-by-step deduction.',
  },
};

export function getDefaultModel() {
  return 'deepseek-v4-pro';
}

export function listModels() {
  return Object.entries(MODELS).map(([id, info]) => ({
    id,
    name: info.name,
    contextWindow: info.contextWindow,
    maxOutputTokens: info.maxOutputTokens,
    thinking: info.thinking,
    description: info.description,
  }));
}
