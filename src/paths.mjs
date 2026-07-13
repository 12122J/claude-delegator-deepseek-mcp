// Resolve Claude Code's config directory, honoring the same overrides Claude
// Code itself uses, so we never write to the wrong place:
//   1. CLAUDE_DELEGATOR_HOME — test-only sandbox (treated as a fake $HOME)
//   2. CLAUDE_CONFIG_DIR     — Claude Code's official config relocation
//   3. ~/.claude             — the default
//
// Lives outside setup/ because the runtime (registry, config) needs these
// paths too, not just the init/uninstall tooling.

import { homedir } from 'node:os';
import { join } from 'node:path';

export function claudeDir() {
  if (process.env.CLAUDE_DELEGATOR_HOME) return join(process.env.CLAUDE_DELEGATOR_HOME, '.claude');
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return join(homedir(), '.claude');
}

export function paths() {
  const dir = claudeDir();
  const homeBase = process.env.CLAUDE_DELEGATOR_HOME || homedir();
  return {
    claudeDir: dir,
    claudeMd: join(dir, 'CLAUDE.md'),
    settingsJson: join(dir, 'settings.json'),
    // file fallback target for MCP config when the `claude` CLI is unavailable
    legacyMcpJson: join(dir, 'mcp.json'),
    // where `claude mcp add --scope user` actually stores server entries
    claudeJson: join(homeBase, '.claude.json'),
    // v3: delegation config (active provider, task routing, savings baseline)
    delegatorJson: process.env.DELEGATOR_CONFIG || join(dir, 'delegator.json'),
    // v3: user-defined providers (any OpenAI-compatible endpoint)
    providersJson: join(dir, 'delegator-providers.json'),
  };
}
