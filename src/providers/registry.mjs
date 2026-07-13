// Provider registry. Providers are catwalk-schema JSON files (vendored from
// charmbracelet/catwalk, MIT) in ./configs/, plus an optional user file at
// ~/.claude/delegator-providers.json that can add ANY OpenAI-compatible
// endpoint (ollama, vllm, a corporate proxy…) or override a vendored entry.
//
// Schema per provider (catwalk, kept verbatim so upstream can be re-vendored):
//   { name, id, type, api_key: "$ENV_VAR" | literal, api_endpoint,
//     default_large_model_id, default_small_model_id, default_headers?,
//     models: [{ id, name, cost_per_1m_in, cost_per_1m_out,
//                cost_per_1m_in_cached, cost_per_1m_out_cached,
//                context_window, default_max_tokens, can_reason, … }] }

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { paths } from '../paths.mjs';

const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'configs');

let cache = null;

function loadUserProviders() {
  const file = paths().providersJson;
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [data];
  } catch (e) {
    process.stderr.write(`WARNING: ${file} is not valid JSON — ignoring user providers (${e.message})\n`);
    return [];
  }
}

export function loadProviders({ fresh = false } = {}) {
  if (fresh) keyringCache = null;
  if (cache && !fresh) return cache;
  const providers = new Map();
  for (const f of readdirSync(CONFIG_DIR).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const p = JSON.parse(readFileSync(join(CONFIG_DIR, f), 'utf8'));
      if (p?.id && Array.isArray(p.models)) providers.set(p.id, p);
    } catch {
      // a malformed vendored file should never take the server down
    }
  }
  // user entries win entirely (merged by id, whole-object replacement)
  for (const p of loadUserProviders()) {
    if (p?.id && Array.isArray(p.models)) providers.set(p.id, p);
  }
  // v2 compat: DEEPSEEK_API_HOST overrode the DeepSeek hostname.
  if (process.env.DEEPSEEK_API_HOST && providers.has('deepseek')) {
    const ds = providers.get('deepseek');
    providers.set('deepseek', { ...ds, api_endpoint: `https://${process.env.DEEPSEEK_API_HOST}` });
  }
  cache = providers;
  return providers;
}

// Keys saved by init into the MCP entry's env block (the keyring), merged
// from both stores: ~/.claude.json (claude CLI user scope) and the mcp.json
// file fallback. Placeholders and ${VAR} self-references are excluded.
// Cached alongside the provider cache; loadProviders({fresh}) resets it.
let keyringCache = null;
export function storedMcpEnv() {
  if (keyringCache) return keyringCache;
  const p = paths();
  const merged = {};
  for (const file of [p.claudeJson, p.legacyMcpJson]) {
    try {
      if (existsSync(file)) {
        const servers = JSON.parse(readFileSync(file, 'utf8'))?.mcpServers || {};
        // v2 entry first so the current "delegate" entry wins on conflicts
        Object.assign(merged, servers.deepseek?.env || {}, servers.delegate?.env || {});
      }
    } catch {
      // a malformed config never takes key resolution down
    }
  }
  const keys = {};
  for (const [k, v] of Object.entries(merged)) {
    if (/_API_KEY$/.test(k) && typeof v === 'string' && v && !v.includes('REPLACE') && !v.startsWith('${')) keys[k] = v;
  }
  keyringCache = keys;
  return keys;
}

// "$DEEPSEEK_API_KEY" → the shell env wins, then the keyring stored in the
// MCP config; a literal value (no "$") is used as-is. This is THE answer to
// "can this provider be called right now" — everything (wizard hints, the
// mix-and-match menus, doctor, the server itself) goes through here, so a
// key saved for any provider counts everywhere.
export function resolveApiKey(provider) {
  const ref = provider?.api_key;
  if (typeof ref !== 'string' || ref.length === 0) return null;
  if (ref.startsWith('$')) {
    const envVar = ref.slice(1);
    return process.env[envVar] || storedMcpEnv()[envVar] || null;
  }
  return ref;
}

// The env var a provider reads its key from, for error messages and wiring.
export function keyEnvVar(provider) {
  const ref = provider?.api_key;
  return typeof ref === 'string' && ref.startsWith('$') ? ref.slice(1) : null;
}

export function getProvider(id) {
  return loadProviders().get(id) || null;
}

export function listProviders() {
  return [...loadProviders().values()].map((p) => ({ ...p, available: !!resolveApiKey(p) }));
}

export function findModel(provider, modelId) {
  return (provider?.models || []).find((m) => m.id === modelId) || null;
}

/**
 * Resolve a model spec into { provider, model }.
 * Spec forms:
 *   "provider:model-id" — explicit. The separator is ":" (never "/") because
 *                         openrouter model ids contain "/".
 *   "model-id"          — searched in the active provider first, then all.
 *   empty/null          — the active provider's default_large_model_id.
 */
export function resolveModel(spec, activeId = 'deepseek') {
  const providers = loadProviders();
  const active = providers.get(activeId);
  if (!active) {
    throw new Error(`Unknown provider "${activeId}". Available: ${[...providers.keys()].join(', ')}`);
  }

  if (!spec) {
    const model = findModel(active, active.default_large_model_id);
    if (!model) throw new Error(`Provider "${active.id}" has no model "${active.default_large_model_id}"`);
    return { provider: active, model };
  }

  const colon = spec.indexOf(':');
  if (colon !== -1) {
    const pid = spec.slice(0, colon);
    const mid = spec.slice(colon + 1);
    const provider = providers.get(pid);
    if (!provider) {
      throw new Error(`Unknown provider "${pid}" in "${spec}". Available: ${[...providers.keys()].join(', ')}`);
    }
    const model = findModel(provider, mid);
    if (!model) {
      throw new Error(`Unknown model "${mid}" on ${provider.name}. Available: ${(provider.models || []).map((m) => m.id).join(', ')}`);
    }
    return { provider, model };
  }

  const inActive = findModel(active, spec);
  if (inActive) return { provider: active, model: inActive };
  for (const provider of providers.values()) {
    const model = findModel(provider, spec);
    if (model) return { provider, model };
  }
  throw new Error(
    `Unknown model "${spec}". Use "provider:model-id" for cross-provider specs. ` +
    `Models on the active provider (${active.id}): ${(active.models || []).map((m) => m.id).join(', ')}`
  );
}
