// Safe, idempotent primitives for wiring the delegator into a user's Claude
// Code config. Everything here follows three rules:
//   1. Never overwrite a user file — only merge (JSON) or append a delimited
//      block (CLAUDE.md). Anything we did not write, we do not touch.
//   2. Back up any file before changing it, and write atomically.
//   3. Tag everything we add so uninstall can remove exactly our parts.
//
// Zero dependencies — Node.js built-ins only.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync,
} from 'node:fs';

export const PKG_NAME = 'claude-code-deepseek-delegator';
export const MARKER = 'claude-code-deepseek-delegator';

// Sentinels that fence our managed block inside CLAUDE.md. We only ever touch
// text between these two lines.
export const BLOCK_BEGIN = '<!-- >>> claude-code-deepseek-delegator >>> (managed block, do not edit by hand) -->';
export const BLOCK_END = '<!-- <<< claude-code-deepseek-delegator <<< -->';

// The MCP tool's auto-delegation rules. This is the body inserted between the
// sentinels in the user's CLAUDE.md. Kept in sync with DELEGATION.md.
export const MANAGED_RULES = `## DeepSeek Delegation (auto-installed by ${PKG_NAME})

**Estimate scope FIRST — before invoking any skill, writing any code, or reading any files.** The gate fires on intent, not on output.

Before ANY of the following, you MUST stop and ask: **"Delegate to DeepSeek? (y/n)"**

- Invoking a skill whose resulting work would exceed the thresholds below
- Read/analyze/grep files > 300 lines total
- Write/edit/create > 200 lines of code
- Generate specs, docs, plans, or architecture > 500 words
- Multi-file codebase review (3+ files)
- Web fetch with > 5,000 chars response
- Complex reasoning (math, logic, multi-step deduction)
- Any task where your response would exceed ~4k tokens

**Format:** print the scope estimate, then ask. Example:
\`\`\`
> This task analyzes ~800 lines across 4 files.
> Delegate to DeepSeek? (y/n)
\`\`\`

**If y/yes:** call the \`deepseek\` tool with model \`deepseek-v4-pro\`. Pass file paths via \`files[]\` so bytes never enter Claude's context. Synthesize the result, do not echo it verbatim.

**If n/no:** proceed yourself.

**Never skip the prompt.** Use \`deepseek-v4-flash\` only for quick summaries where speed beats depth.`;

// The PreToolUse hooks (stronger, non-bypassable enforcement). These require
// `jq` on PATH. Tagged with _managedBy so uninstall removes exactly these.
const READ_HOOK_CMD = `jq -r '.tool_input.file_path // empty' | { read -r f; if [ -z "$f" ]; then exit 0; fi; lines=$(wc -l < "$f" 2>/dev/null | tr -d ' '); if [ "$lines" -gt 300 ]; then jq -n --argjson l "$lines" --arg p "$f" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:("READ BLOCKED: "+$p+" is "+($l|tostring)+" lines. Do NOT read this file into context. Estimate scope and ask the user: Delegate to DeepSeek? (y/n). If yes, pass the path via files[] to deepseek() — never load large files into Claude context first.")}}'; fi; }`;

const SKILL_HOOK_CMD = `jq '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: ("DEEPSEEK GATE — skill: " + (.tool_input.skill // "?") + ". Estimate total token cost BEFORE loading this skill. If the resulting work involves >200 lines of code, >3 files, >4k tokens output, or analysis of large content — STOP and ask the user: Delegate to DeepSeek? (y/n). This is mandatory.")}}'`;

export function managedHooks() {
  return [
    { matcher: 'Read', _managedBy: MARKER, hooks: [{ type: 'command', command: READ_HOOK_CMD }] },
    { matcher: 'Skill', _managedBy: MARKER, hooks: [{ type: 'command', command: SKILL_HOOK_CMD }] },
  ];
}

// ── Paths ────────────────────────────────────────────────────────────────
// `home` is injectable so tests can run against a temp directory.
export function paths(home = process.env.CLAUDE_DELEGATOR_HOME || homedir()) {
  const claudeDir = join(home, '.claude');
  return {
    home,
    claudeDir,
    claudeMd: join(claudeDir, 'CLAUDE.md'),
    settingsJson: join(claudeDir, 'settings.json'),
    // file fallback target for MCP config when the `claude` CLI is unavailable
    legacyMcpJson: join(claudeDir, 'mcp.json'),
  };
}

// ── Safe file IO ─────────────────────────────────────────────────────────
export function backupFile(file) {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.deepseek-bak-${stamp}`;
  copyFileSync(file, dest);
  return dest;
}

export function atomicWrite(file, content) {
  const dir = file.slice(0, file.lastIndexOf('/')) || '.';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.deepseek-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file); // rename is atomic on the same filesystem
}

// Returns { ok, data, raw }. ok:false means the file exists but is not valid
// JSON — callers must NOT overwrite it in that case.
export function readJsonSafe(file) {
  if (!existsSync(file)) return { ok: true, data: {}, raw: null, existed: false };
  const raw = readFileSync(file, 'utf8');
  if (raw.trim() === '') return { ok: true, data: {}, raw, existed: true };
  try {
    return { ok: true, data: JSON.parse(raw), raw, existed: true };
  } catch (e) {
    return { ok: false, data: null, raw, existed: true, error: e.message };
  }
}

// ── CLAUDE.md managed block ──────────────────────────────────────────────
export function hasBlock(text) {
  return text.includes(BLOCK_BEGIN) && text.includes(BLOCK_END);
}

function renderBlock() {
  return `${BLOCK_BEGIN}\n${MANAGED_RULES}\n${BLOCK_END}`;
}

// Append our block, or replace it in place if already present. Never alters
// anything outside the sentinels. Returns the new full text.
export function upsertBlock(text) {
  const block = renderBlock();
  if (hasBlock(text)) {
    const start = text.indexOf(BLOCK_BEGIN);
    const end = text.indexOf(BLOCK_END) + BLOCK_END.length;
    if (start < end) return text.slice(0, start) + block + text.slice(end);
  }
  const base = text.replace(/\s+$/, '');
  return base.length ? `${base}\n\n${block}\n` : `${block}\n`;
}

// Remove our block (and tidy the seam). Returns the new full text. If our block
// isn't present, returns the input unchanged.
export function removeBlock(text) {
  if (!hasBlock(text)) return text;
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END) + BLOCK_END.length;
  if (start >= end) return text;
  const out = (text.slice(0, start) + text.slice(end)).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  return out.length ? `${out}\n` : '';
}

// ── settings.json hooks ──────────────────────────────────────────────────
function isOurs(entry) {
  if (entry && entry._managedBy === MARKER) return true;
  // Defensive fallback: identify by our signature even if the tag was stripped.
  const cmds = (entry?.hooks || []).map((h) => h?.command || '').join('\n');
  return cmds.includes('Delegate to DeepSeek?') &&
    (cmds.includes('READ BLOCKED') || cmds.includes('DEEPSEEK GATE'));
}

// Ensure settings contains exactly our managed PreToolUse hooks (idempotent),
// without disturbing any other hooks the user has. Mutates and returns a copy.
export function addHooks(settingsIn) {
  const settings = structuredClone(settingsIn || {});
  if (typeof settings.hooks !== 'object' || settings.hooks === null) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
  // drop any prior copies of ours, then add fresh — keeps it idempotent
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((e) => !isOurs(e));
  settings.hooks.PreToolUse.push(...managedHooks());
  return settings;
}

export function removeHooks(settingsIn) {
  const settings = structuredClone(settingsIn || {});
  const pre = settings?.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return settings;
  settings.hooks.PreToolUse = pre.filter((e) => !isOurs(e));
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

// ── MCP server entry ─────────────────────────────────────────────────────
export function mcpEntry(apiKeyValue) {
  return {
    command: 'npx',
    args: ['-y', PKG_NAME],
    env: { DEEPSEEK_API_KEY: apiKeyValue },
  };
}
