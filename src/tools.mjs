import { callDeepSeek } from './client.mjs';
import { listModels, getDefaultModel } from './models.mjs';
import { buildFooter } from './pricing.mjs';
import { color, bold, dim } from './colors.mjs';

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
    description: 'List available DeepSeek models with capabilities, context windows, and pricing',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function handleToolCall(name, args) {
  switch (name) {
    case 'deepseek': {
      const model = args.model || getDefaultModel();
      const result = await callDeepSeek(args);
      const header = [
        '',
        dim('─── deepseek-mcp'),
        `${color('green', '◆')} ${bold('delegated to')} ${color('cyan', 'DeepSeek')} ${dim('(' + model.replace('deepseek-', '') + ')')}`,
        '',
      ].join('\n');

      const footer = buildFooter(result, model);
      return {
        content: [{ type: 'text', text: header + result.content + footer }],
      };
    }
    case 'deepseek_models': {
      const models = listModels();
      const text = [
        dim('─── deepseek-mcp · available models ───'),
        '',
        ...models.map(
          (m) =>
            `${color('green', '●')} ${bold(m.id)} ${dim('— ' + m.name)}\n` +
            `  ${dim('context:')} ${(m.contextWindow / 1024).toFixed(0)}K  ${dim('thinking:')} ${m.thinking ? color('green', 'on') : color('yellow', 'off')}\n` +
            `  ${dim(m.description)}\n`
        ),
        dim('─────────────────────────────────────'),
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
