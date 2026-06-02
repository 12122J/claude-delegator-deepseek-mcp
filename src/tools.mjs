import { callDeepSeek } from './client.mjs';
import { listModels, getDefaultModel } from './models.mjs';
import { buildFooter } from './pricing.mjs';

export const TOOLS = [
  {
    name: 'deepseek',
    description:
      'Delegate heavy, token-intensive tasks to DeepSeek. Use when: analyzing large files (>300 lines), ' +
      'multi-file codebase reviews, generating outputs >200 lines, complex reasoning, math, architecture design, ' +
      'or anytime your response would exceed ~4000 tokens. Claude orchestrates; DeepSeek does the heavy lifting.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The full task/prompt to send to DeepSeek. Be thorough and specific.',
        },
        system: {
          type: 'string',
          description: 'Optional system prompt to set context/behavior',
        },
        model: {
          type: 'string',
          description: `DeepSeek model. Default: ${getDefaultModel()}. Options: deepseek-v4-pro (smartest, thinking), deepseek-v4-flash (fast/cheap), deepseek-reasoner (math/logic)`,
          default: getDefaultModel(),
        },
        temperature: {
          type: 'number',
          description: 'Temperature (0-2). Lower = more deterministic. Default: 0.7',
          default: 0.7,
        },
        maxTokens: {
          type: 'number',
          description: 'Max tokens in response. Default: model max',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'deepseek_models',
    description: 'List available DeepSeek models with capabilities, context windows, and descriptions',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function handleToolCall(name, args) {
  switch (name) {
    case 'deepseek': {
      const result = await callDeepSeek(args);
      const footer = buildFooter(result, args.model || getDefaultModel());
      return {
        content: [{ type: 'text', text: result.content + '\n' + footer }],
      };
    }
    case 'deepseek_models': {
      const models = listModels();
      const text = models
        .map(
          (m) =>
            `**${m.id}** — ${m.name}\n  Context: ${(m.contextWindow / 1024).toFixed(0)}K | Thinking: ${m.thinking ? 'on' : 'off'}\n  ${m.description}`
        )
        .join('\n\n');
      return { content: [{ type: 'text', text }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
