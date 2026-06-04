import { request } from 'https';
import { MODELS } from './models.mjs';

const API_HOST = process.env.DEEPSEEK_API_HOST || 'api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY;
const rawTimeout = parseInt(process.env.DEEPSEEK_TIMEOUT || '120000', 10);
const TIMEOUT_MS = rawTimeout > 0 ? rawTimeout : 120000;
const MAX_RETRIES = parseInt(process.env.DEEPSEEK_MAX_RETRIES || '2', 10);

class DeepSeekError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.data = data;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callWithRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries && (err.status >= 500 || err.status === 429)) {
        const delay = Math.min(1000 * 2 ** attempt, 16000);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

/**
 * Parse SSE (Server-Sent Events) stream from a response.
 * Reads lines from the stream, extracts `data:` lines, parses JSON,
 * and aggregates content deltas into an array of text chunks.
 */
function parseSSEStream(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let buffer = '';
    let model = null;
    let usage = null;
    let finishReason = 'unknown';

    res.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          if (json.error) {
            return reject(new DeepSeekError(json.error.message, res.statusCode, json.error));
          }
          const choice = json.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            chunks.push(delta.content);
          }
          if (!model && json.model) model = json.model;
          if (json.usage) {
            usage = {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens,
              totalTokens: json.usage.total_tokens,
            };
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        } catch {
          // Skip malformed SSE lines
        }
      }
    });

    res.on('end', () => {
      resolve({
        streamed: true,
        content: chunks,
        model,
        usage,
        finishReason,
      });
    });

    res.on('error', reject);
  });
}

export async function callDeepSeek({ prompt, system, model = 'deepseek-v4-pro', temperature = 0.3, maxTokens, stream = false }) {
  if (!API_KEY) throw new DeepSeekError('DEEPSEEK_API_KEY environment variable is not set', 401);

  const modelInfo = MODELS[model];
  if (!modelInfo) throw new DeepSeekError(`Unknown model: ${model}. Available: ${Object.keys(MODELS).join(', ')}`, 400);

  // --- Input parameter validation ---
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new DeepSeekError('prompt must be a non-empty string', 400);
  }

  if (typeof temperature === 'number') {
    if (temperature < 0 || temperature > 2) {
      throw new DeepSeekError(
        `temperature must be between 0 and 2 (got ${temperature})`,
        400
      );
    }
  }

  if (maxTokens !== undefined && maxTokens !== null) {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new DeepSeekError(
        `maxTokens must be a positive integer (got ${maxTokens})`,
        400
      );
    }
  }
  // --- End parameter validation ---

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens || modelInfo.maxOutputTokens,
    stream: stream || undefined,
  };

  // Streaming path: parse SSE, return array of content chunks
  if (stream) {
    body.stream = true;
    return callWithRetry(() => {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);

        const req = request(
          {
            hostname: API_HOST,
            path: '/v1/chat/completions',
            method: 'POST',
            timeout: TIMEOUT_MS,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${API_KEY}`,
              'Content-Length': Buffer.byteLength(payload),
              Accept: 'text/event-stream',
            },
          },
          (res) => {
            if (res.statusCode >= 400) {
              let data = '';
              res.on('data', (chunk) => (data += chunk));
              res.on('end', () => {
                try {
                  const json = JSON.parse(data);
                  reject(new DeepSeekError(json.error?.message || `HTTP ${res.statusCode}`, res.statusCode, json.error));
                } catch {
                  reject(new DeepSeekError(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`, res.statusCode));
                }
              });
              return;
            }
            parseSSEStream(res).then(resolve, reject);
          }
        );

        req.on('timeout', () => {
          req.destroy();
          reject(new DeepSeekError(`Request timed out after ${TIMEOUT_MS / 1000}s`, 408));
        });

        req.on('error', (err) => {
          reject(new DeepSeekError(err.message, 0));
        });

        req.write(payload);
        req.end();
      });
    });
  }

  // Non-streaming path (unchanged)
  return callWithRetry(() => {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);

      const req = request(
        {
          hostname: API_HOST,
          path: '/v1/chat/completions',
          method: 'POST',
          timeout: TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode >= 400) {
              return reject(new DeepSeekError(
                `DeepSeek API error (${res.statusCode}): ${data.slice(0, 200)}`,
                res.statusCode,
                { body: data.slice(0, 1000) }
              ));
            }
            try {
              const json = JSON.parse(data);
              if (json.error) {
                return reject(new DeepSeekError(json.error.message, res.statusCode, json.error));
              }
              const choice = json.choices?.[0];
              const message = choice?.message;
              resolve({
                content: message?.content ?? '(empty response)',
                model: json.model,
                usage: json.usage
                  ? {
                      promptTokens: json.usage.prompt_tokens,
                      completionTokens: json.usage.completion_tokens,
                      totalTokens: json.usage.total_tokens,
                    }
                  : null,
                finishReason: choice?.finish_reason ?? 'unknown',
              });
            } catch (e) {
              reject(new DeepSeekError(`Failed to parse response: ${e.message}`, res.statusCode, data));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new DeepSeekError(`Request timed out after ${TIMEOUT_MS / 1000}s`, 408));
      });

      req.on('error', (err) => {
        reject(new DeepSeekError(err.message, 0));
      });

      req.write(payload);
      req.end();
    });
  });
}
