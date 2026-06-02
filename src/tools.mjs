import { readFile, stat } from 'fs/promises';
import { basename, extname } from 'path';
import { callDeepSeek } from './client.mjs';
import { MODELS, listModels, getDefaultModel } from './models.mjs';
import { buildFooter } from './pricing.mjs';
import { color, bold, dim } from './colors.mjs';

export const TOOLS = [
  {
    name: 'deepseek',
    description:
      'Delegate heavy, token-intensive tasks from Claude Code to DeepSeek. ' +
      'Use when: analyzing large files (>300 lines), ' +
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
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute file paths to read and include in the prompt. ' +
            'The MCP server reads them directly — file contents never pass through Claude\'s context window. ' +
            'Use this instead of reading files with Read/ctx_read and embedding them in prompt.',
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

      // Read files server-side — bytes stay in the MCP process, never in Claude's context
      let resolvedArgs = args;
      const filePaths = Array.isArray(args.files) ? args.files.filter((p) => typeof p === 'string') : [];
      if (filePaths.length > 0) {
        const modelInfo = MODELS[model] || MODELS[getDefaultModel()];
        // Rough guard: ~3 chars per token; leave half the context for output + prompt
        const maxFileBytes = Math.floor((modelInfo.contextWindow / 2) * 3);
        let totalBytes = 0;

        const sections = await Promise.all(
          filePaths.map(async (p) => {
            try {
              const size = (await stat(p)).size;
              if (totalBytes + size > maxFileBytes) {
                return `### ${p}\n(skipped: would exceed context window — ${(size / 1024).toFixed(1)}KB)`;
              }
              totalBytes += size;
              const ext = extname(basename(p)).replace(/^\./, '');
              return `### ${p}\n\`\`\`${ext}\n${await readFile(p, 'utf8')}\n\`\`\``;
            } catch (e) {
              return `### ${p}\n(error: ${e.message})`;
            }
          })
        );
        resolvedArgs = {
          ...args,
          prompt: args.prompt + '\n\n## FILES:\n\n' + sections.join('\n\n'),
        };
      }

      const result = await callDeepSeek(resolvedArgs);
      const header = [
        '',
        dim('─── claude-code-deepseek-delegator'),
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
        dim('─── claude-code-deepseek-delegator · models ───'),
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
