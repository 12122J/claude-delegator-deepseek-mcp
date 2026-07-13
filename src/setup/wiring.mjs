// Safe, idempotent primitives for wiring the delegator into a user's Claude
// Code config. Everything here follows three rules:
//   1. Never overwrite a user file — only merge (JSON) or append a delimited
//      block (CLAUDE.md). Anything we did not write, we do not touch.
//   2. Back up any file before changing it, and write atomically.
//   3. Tag everything we add so uninstall can remove exactly our parts.
//
// Zero dependencies — Node.js built-ins only.

import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync,
} from 'node:fs';
// Path resolution moved to src/paths.mjs (the runtime needs it too);
// re-exported here so existing imports keep working.
export { claudeDir, paths } from '../paths.mjs';

export const PKG_NAME = 'claude-code-deepseek-delegator';
export const MARKER = 'claude-code-deepseek-delegator';
export const REPO_URL = 'https://github.com/12122J/claude-delegator-deepseek-mcp';
export const AUTHOR = 'Javi (@12122J)';

// Sentinels that fence our managed block inside CLAUDE.md. We only ever touch
// text between these two lines.
export const BLOCK_BEGIN = '<!-- >>> claude-code-deepseek-delegator >>> (managed block, do not edit by hand) -->';
export const BLOCK_END = '<!-- <<< claude-code-deepseek-delegator <<< -->';

// The rules inserted between the sentinels in the user's CLAUDE.md. Written to
// be readable and honest: anyone opening their CLAUDE.md can see what it is, who
// added it, and how to remove it. Carries the knowledge-transfer instruction
// (files[] + synthesize) so delegation actually hands off context cleanly.
// Provider display names land inside shell-single-quoted `node -e` scripts and
// double-quoted JS strings — restrict to characters safe in both.
export function safeProviderName(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9 ._-]/g, '').trim();
  return cleaned || 'DeepSeek';
}

// opts.shortlist: [{ spec, hint }] — when present (ask mode), the rules have
// Claude surface the choice through AskUserQuestion, which renders Claude
// Code's native picker (the same UI as /model), instead of routing silently.
export function managedRules(providerName = 'DeepSeek', opts = {}) {
  const name = safeProviderName(providerName);
  const yesBullet = Array.isArray(opts.shortlist) && opts.shortlist.length > 0
    ? `- If the user says **y**: first ask which model with the AskUserQuestion tool (header "Delegate", one option per model below, its price as the description), then call the \`delegate\` tool with \`model\` set to the choice:
${opts.shortlist.map((s) => `  - \`${s.spec}\`${s.hint ? ` — ${s.hint}` : ''}`).join('\n')}
  Pass file paths in \`files[]\` so the bytes go straight to the delegate and never fill Claude's context. Then synthesize the result for the user; do not paste it back verbatim.`
    : `- If the user says **y**: call the \`delegate\` tool. Set \`task\` to "read" (summarize/analyze large inputs), "write" (generate code/docs), or "reason" (math, logic, architecture) so routing picks the right model. Pass file paths in \`files[]\` so the bytes go straight to the delegate and never fill Claude's context. Then synthesize the result for the user; do not paste it back verbatim.`;
  return `## Delegate heavy work to ${name}

_Added by \`${PKG_NAME} init\`. Safe to delete this whole block, or run \`npx ${PKG_NAME} uninstall\`._

Before doing any of the following, STOP and ask the user, in these exact words: **"Delegate to ${name}? (y/n)"**

- reading or grepping more than ~300 lines total
- writing or editing more than ~200 lines of code
- producing more than ~500 words of docs, specs, or plans
- reviewing 3+ files at once, or any task whose answer would exceed ~4k tokens
- heavy reasoning (math, multi-step logic)

Print a one-line scope estimate first, then the question. Example:
\`\`\`
> This analyzes ~800 lines across 4 files.
> Delegate to ${name}? (y/n)
\`\`\`

${yesBullet}
- If the user says **n**: do it yourself.
- Every \`delegate\` result ends with a cost footer. When you reply, surface its savings line to the user (cost, savings, tokens) — never silently drop it.`;
}

// Default rendering, used by upsertBlock when no provider was chosen (and by
// tests). Named DeepSeek so a v2 install upgraded in place reads the same.
export const MANAGED_RULES = managedRules();

// The PreToolUse hooks (deterministic enforcement). Written as `node -e` one-
// liners so they need NO extra tooling: Node is already present (Claude Code
// runs on it), unlike `jq`, which macOS does not ship. The shell wraps the
// script in single quotes, so the script itself uses only double quotes.
// Tagged with _managedBy so uninstall removes exactly these.
const readHookCmd = (name) => `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s||"{}"),f=i.tool_input&&i.tool_input.file_path;if(!f)return;const fs=require("fs");if(!fs.existsSync(f))return;const n=fs.readFileSync(f,"utf8").split("\\n").length;if(n>300){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"NOTE: "+f+" is "+n+" lines — large enough to crowd Claude context. Before reading it, ask the user exactly: \\"Delegate to ${name}? (y/n)\\". If yes, pass the path in files[] to the delegate tool so the bytes go straight to the delegate instead of being read into context."}}))}}catch(e){}})'`;

const skillHookCmd = (name) => `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s||"{}"),k=(i.tool_input&&i.tool_input.skill)||"?";process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"NOTE: about to load skill \\""+k+"\\". If the resulting work is large (>200 lines of code, >3 files, >4k tokens of output, or heavy analysis), first ask the user exactly: \\"Delegate to ${name}? (y/n)\\" before proceeding."}}))}catch(e){}})'`;

// PostToolUse cost display: after every deepseek call, find the flat
// `deepseek-cost:{...}` marker the server appends to its footer (pricing.mjs)
// and surface its `line` as a systemMessage — the only hook channel Claude Code
// shows directly to the user, so the cost can never be silently dropped by the
// model. Collects every string in tool_response recursively, so it works for
// both the buffered shape (one text item) and the streamed shape (many).
const COST_HOOK_CMD = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s||"{}");const g=(o)=>typeof o==="string"?o:(o&&typeof o==="object"?Object.values(o).map(g).join("\\n"):"");const m=g(i.tool_response).match(/deepseek-cost:(\\{.*?\\})/);if(!m)return;const c=JSON.parse(m[1]);if(c&&typeof c.line==="string"&&c.line.length<400)process.stdout.write(JSON.stringify({systemMessage:c.line}))}catch(e){}})'`;

export function managedHooks(providerName = 'DeepSeek') {
  const name = safeProviderName(providerName);
  return [
    { matcher: 'Read', _managedBy: MARKER, hooks: [{ type: 'command', command: readHookCmd(name) }] },
    { matcher: 'Skill', _managedBy: MARKER, hooks: [{ type: 'command', command: skillHookCmd(name) }] },
  ];
}

export function managedPostHooks() {
  return [
    // Both tool names: `delegate` (v3 canonical) and `deepseek` (v2 alias).
    { matcher: '^mcp__deepseek__(deepseek|delegate)$', _managedBy: MARKER, hooks: [{ type: 'command', command: COST_HOOK_CMD }] },
  ];
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

function renderBlock(rules = MANAGED_RULES) {
  return `${BLOCK_BEGIN}\n${rules}\n${BLOCK_END}`;
}

// Append our block, or replace it in place if already present. Never alters
// anything outside the sentinels. Returns the new full text.
export function upsertBlock(text, rules = MANAGED_RULES) {
  const block = renderBlock(rules);
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
  // The gate text names whatever provider the user chose, so match its shape.
  const cmds = (entry?.hooks || []).map((h) => h?.command || '').join('\n');
  return ((cmds.includes('Delegate to ') && cmds.includes('? (y/n)')) || cmds.includes('deepseek-cost:')) && cmds.includes('node -e');
}

// Ensure settings contains exactly our managed hooks (idempotent), without
// disturbing any other hooks the user has. Mutates and returns a copy.
export function addHooks(settingsIn, providerName = 'DeepSeek') {
  const settings = structuredClone(settingsIn || {});
  if (typeof settings.hooks !== 'object' || settings.hooks === null) settings.hooks = {};
  // drop any prior copies of ours, then add fresh — keeps it idempotent
  for (const [event, ours] of [['PreToolUse', managedHooks(providerName)], ['PostToolUse', managedPostHooks()]]) {
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
// The server key stays "deepseek" in mcpServers regardless of provider —
// renaming it would orphan every existing install's config entry.
export function mcpEntry(apiKeyValue, envVar = 'DEEPSEEK_API_KEY') {
  return {
    command: 'npx',
    args: ['-y', PKG_NAME],
    env: { [envVar]: apiKeyValue },
  };
}
