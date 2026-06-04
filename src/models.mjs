// DeepSeek model registry
// Each entry defines model capabilities, context window, and pricing tier.
//
// DEPRECATED ALIASES (removed 2026-07-24):
//   deepseek-chat    → use deepseek-v4-pro
//   deepseek-reasoner → use deepseek-v4-pro (was r1 reasoning model, no longer available)

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
};

export function getDefaultModel() {
  return 'deepseek-v4-pro';
}

export function listModels() {
  return Object.entries(MODELS).map(([id, info]) => ({
    id,
    name: info.name,
    contextWindow: info.contextWindow,
    thinking: info.thinking,
    description: info.description,
  }));
}
