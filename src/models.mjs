// DeepSeek model registry
// deepseek-v4-pro is the one and only model used for everything — 1M context,
// 384K max output. (deepseek-chat / deepseek-reasoner are deprecated by DeepSeek
// on 2026/07/24; deepseek-v4-flash is the cheaper sibling we don't use here.)
// NOTE: Models must stay in sync with pricing.mjs — add entries to both files.

export const MODELS = {
  'deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    description: 'Smartest model. Best for complex analysis, code generation, architecture, and multi-step reasoning.',
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
    description: info.description,
  }));
}
