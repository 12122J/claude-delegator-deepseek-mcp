// User delegation config: ~/.claude/delegator.json (path override via
// DELEGATOR_CONFIG). Written by the init wizard, read by the server on every
// tool call so edits apply without a restart.
//
// Backwards compatibility is load-bearing: with NO config file present and
// only DEEPSEEK_API_KEY set, behavior must be identical to v2 — provider
// deepseek, deepseek-v4-pro for every task, savings measured against Opus.

import { existsSync, readFileSync } from 'node:fs';
import { paths } from './paths.mjs';

export const TASKS = ['read', 'write', 'reason'];

export const DEFAULT_CONFIG = Object.freeze({
  provider: 'deepseek',
  // 'auto': task routing picks the model. 'ask': the CLAUDE.md rules have
  // Claude present `shortlist` through AskUserQuestion (Claude Code's native
  // picker) at delegation time; the server just honors the chosen `model`.
  mode: 'auto',
  shortlist: Object.freeze([]),
  routing: Object.freeze({
    read: 'deepseek-v4-pro',
    write: 'deepseek-v4-pro',
    reason: 'deepseek-v4-pro',
  }),
  baseline: 'opus-4.8',
});

export function loadConfig() {
  const file = paths().delegatorJson;
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(`WARNING: ${file} is not valid JSON — using defaults (${e.message})\n`);
    return structuredClone(DEFAULT_CONFIG);
  }
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (typeof data.provider === 'string' && data.provider) cfg.provider = data.provider;
  if (data.mode === 'ask' || data.mode === 'auto') cfg.mode = data.mode;
  if (Array.isArray(data.shortlist)) cfg.shortlist = data.shortlist.filter((s) => typeof s === 'string' && s);
  if (data.routing && typeof data.routing === 'object') {
    for (const task of TASKS) {
      if (typeof data.routing[task] === 'string' && data.routing[task]) cfg.routing[task] = data.routing[task];
    }
  }
  if (typeof data.baseline === 'string' && data.baseline) cfg.baseline = data.baseline;
  return cfg;
}

export async function saveConfig(cfg) {
  const { atomicWrite } = await import('./setup/wiring.mjs');
  atomicWrite(paths().delegatorJson, JSON.stringify(cfg, null, 2) + '\n');
  return paths().delegatorJson;
}
