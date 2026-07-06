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

// The rules inserted between the sentinels in the user's CLAUDE.md. Written to
// be readable and honest: anyone opening their CLAUDE.md can see what it is, who
// added it, and how to remove it. Carries the knowledge-transfer instruction
// (files[] + synthesize) so delegation actually hands off context cleanly.
export const MANAGED_RULES = `## Delegate heavy work to DeepSeek

_Added by \`${PKG_NAME} init\`. Safe to delete this whole block, or run \`npx ${PKG_NAME} uninstall\`._

Before doing any of the following, STOP and ask the user, in these exact words: **"Delegate to DeepSeek? (y/n)"**

- reading or grepping more than ~300 lines total
- writing or editing more than ~200 lines of code
- producing more than ~500 words of docs, specs, or plans
- reviewing 3+ files at once, or any task whose answer would exceed ~4k tokens
- heavy reasoning (math, multi-step logic)

Print a one-line scope estimate first, then the question. Example:
\`\`\`
> This analyzes ~800 lines across 4 files.
> Delegate to DeepSeek? (y/n)
\`\`\`

- If the user says **y**: call the \`deepseek\` tool (model \`deepseek-v4-pro\`). Pass file paths in \`files[]\` so the bytes go straight to DeepSeek and never fill Claude's context. Then synthesize the result for the user; do not paste it back verbatim.
- If the user says **n**: do it yourself.
- Every \`deepseek\` result ends with a cost footer. When you reply, surface its savings line to the user (cost, savings vs Claude, tokens) — never silently drop it.`;

// The PreToolUse hooks (deterministic enforcement). Written as `node -e` one-
// liners so they need NO extra tooling: Node is already present (Claude Code
// runs on it), unlike `jq`, which macOS does not ship. The shell wraps the
// script in single quotes, so the script itself uses only double quotes.
// Tagged with _managedBy so uninstall removes exactly these.
const READ_HOOK_CMD = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s||"{}"),f=i.tool_input&&i.tool_input.file_path;if(!f)return;const fs=require("fs");if(!fs.existsSync(f))return;const n=fs.readFileSync(f,"utf8").split("\\n").length;if(n>300){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"NOTE: "+f+" is "+n+" lines — large enough to crowd Claude context. Before reading it, ask the user exactly: \\"Delegate to DeepSeek? (y/n)\\". If yes, pass the path in files[] to the deepseek tool so the bytes go straight to DeepSeek instead of being read into context."}}))}}catch(e){}})'`;

const SKILL_HOOK_CMD = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s||"{}"),k=(i.tool_input&&i.tool_input.skill)||"?";process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"NOTE: about to load skill \\""+k+"\\". If the resulting work is large (>200 lines of code, >3 files, >4k tokens of output, or heavy analysis), first ask the user exactly: \\"Delegate to DeepSeek? (y/n)\\" before proceeding."}}))}catch(e){}})'`;

// PostToolUse cost display: after every deepseek call, find the flat
// `deepseek-cost:{...}` marker the server appends to its footer (pricing.mjs)
// and surface its `line` as a systemMessage — the only hook channel Claude Code
// shows directly to the user, so the cost can never be silently dropped by the
// model. Collects every string in tool_response recursively, so it works for
// both the buffered shape (one text item) and the streamed shape (many).
const COST_HOOK_CMD = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s||"{}");const g=(o)=>typeof o==="string"?o:(o&&typeof o==="object"?Object.values(o).map(g).join("\\n"):"");const m=g(i.tool_response).match(/deepseek-cost:(\\{.*?\\})/);if(!m)return;const c=JSON.parse(m[1]);if(c&&typeof c.line==="string"&&c.line.length<400)process.stdout.write(JSON.stringify({systemMessage:c.line}))}catch(e){}})'`;

export function managedHooks() {
  return [
    { matcher: 'Read', _managedBy: MARKER, hooks: [{ type: 'command', command: READ_HOOK_CMD }] },
    { matcher: 'Skill', _managedBy: MARKER, hooks: [{ type: 'command', command: SKILL_HOOK_CMD }] },
  ];
}

export function managedPostHooks() {
  return [
    { matcher: '^mcp__deepseek__deepseek$', _managedBy: MARKER, hooks: [{ type: 'command', command: COST_HOOK_CMD }] },
  ];
}

// ── Paths ────────────────────────────────────────────────────────────────
// Resolve Claude Code's config directory, honoring the same overrides Claude
// Code itself uses, so we never write to the wrong place:
//   1. CLAUDE_DELEGATOR_HOME — test-only sandbox (treated as a fake $HOME)
//   2. CLAUDE_CONFIG_DIR     — Claude Code's official config relocation
//   3. ~/.claude             — the default
export function claudeDir() {
  if (process.env.CLAUDE_DELEGATOR_HOME) return join(process.env.CLAUDE_DELEGATOR_HOME, '.claude');
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return join(homedir(), '.claude');
}

export function paths() {
  const dir = claudeDir();
  return {
    claudeDir: dir,
    claudeMd: join(dir, 'CLAUDE.md'),
    settingsJson: join(dir, 'settings.json'),
    // file fallback target for MCP config when the `claude` CLI is unavailable
    legacyMcpJson: join(dir, 'mcp.json'),
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
  return (cmds.includes('Delegate to DeepSeek? (y/n)') || cmds.includes('deepseek-cost:')) && cmds.includes('node -e');
}

// Ensure settings contains exactly our managed hooks (idempotent), without
// disturbing any other hooks the user has. Mutates and returns a copy.
export function addHooks(settingsIn) {
  const settings = structuredClone(settingsIn || {});
  if (typeof settings.hooks !== 'object' || settings.hooks === null) settings.hooks = {};
  // drop any prior copies of ours, then add fresh — keeps it idempotent
  for (const [event, ours] of [['PreToolUse', managedHooks()], ['PostToolUse', managedPostHooks()]]) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event] = settings.hooks[event].filter((e) => !isOurs(e));
    settings.hooks[event].push(...ours);
  }
  return settings;
}

export function removeHooks(settingsIn) {
  const settings = structuredClone(settingsIn || {});
  let sawArray = false; // a pre-existing empty hooks:{} we never touched stays as-is
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const arr = settings?.hooks?.[event];
    if (!Array.isArray(arr)) continue;
    sawArray = true;
    settings.hooks[event] = arr.filter((e) => !isOurs(e));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (sawArray && settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
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
