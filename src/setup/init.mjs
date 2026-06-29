// `claude-code-deepseek-delegator init` — wire the tool fully into Claude Code:
//   1. register the MCP server (so the deepseek tool exists)
//   2. install the auto-delegation rules into CLAUDE.md (so Claude offers to delegate)
//   3. install the PreToolUse hooks into settings.json (so the gate can't be skipped)
//
// Safe by construction: backs up every file it changes, writes atomically, never
// overwrites user content, and is fully reversible with `uninstall`.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  paths, backupFile, atomicWrite, readJsonSafe,
  upsertBlock, addHooks, mcpEntry,
} from './wiring.mjs';

const PLACEHOLDER_KEY = 'sk-REPLACE_WITH_YOUR_DEEPSEEK_KEY';

function has(cmd, args = ['--version']) {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; }
}

// CLI-first for MCP wiring, unless the user (or a test) forces the file path.
function cliAvailable() {
  return process.env.CLAUDE_DELEGATOR_FORCE_FILE !== '1' && has('claude');
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve((a || '').trim()); });
  });
}

async function resolveApiKey({ assumeYes }) {
  // Best: reference the env var so no secret is written to disk.
  if (process.env.DEEPSEEK_API_KEY) {
    return { value: '${DEEPSEEK_API_KEY}', mode: 'env-ref' };
  }
  // Interactive: let the user paste it now.
  if (!assumeYes && process.stdin.isTTY) {
    const pasted = await ask('Paste your DeepSeek API key (or press Enter to fill in later): ');
    if (pasted) return { value: pasted, mode: 'literal' };
  }
  return { value: PLACEHOLDER_KEY, mode: 'placeholder' };
}

function wireMcpViaCli(entry) {
  // remove-then-add keeps it idempotent and ensures the latest config sticks
  spawnSync('claude', ['mcp', 'remove', 'deepseek', '--scope', 'user'], { stdio: 'ignore' });
  const r = spawnSync('claude', ['mcp', 'add-json', 'deepseek', JSON.stringify(entry), '--scope', 'user'], { encoding: 'utf8' });
  return { ok: r.status === 0, detail: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function wireMcpViaFile(p, entry, dryRun) {
  const res = readJsonSafe(p.legacyMcpJson);
  if (!res.ok) return { ok: false, detail: `${p.legacyMcpJson} is not valid JSON — left untouched` };
  const data = res.data || {};
  if (typeof data.mcpServers !== 'object' || data.mcpServers === null) data.mcpServers = {};
  data.mcpServers.deepseek = entry;
  if (!dryRun) {
    const bak = backupFile(p.legacyMcpJson);
    atomicWrite(p.legacyMcpJson, JSON.stringify(data, null, 2) + '\n');
    return { ok: true, detail: `merged into ${p.legacyMcpJson}`, backup: bak };
  }
  return { ok: true, detail: `would merge into ${p.legacyMcpJson}` };
}

export async function runInit(argv = []) {
  const dryRun = argv.includes('--dry-run');
  const noHooks = argv.includes('--no-hooks');
  const assumeYes = argv.includes('--yes') || argv.includes('-y');
  const p = paths();
  const notes = [];
  const backups = [];

  console.log(`\nclaude-code-deepseek-delegator · init${dryRun ? '  (dry run — no files will be written)' : ''}\n`);

  // 1) API key
  const key = await resolveApiKey({ assumeYes });
  const entry = mcpEntry(key.value);

  // 2) MCP server registration
  let mcp;
  if (cliAvailable()) {
    mcp = dryRun
      ? { ok: true, detail: 'would register via `claude mcp add-json deepseek --scope user`' }
      : wireMcpViaCli(entry);
    if (!mcp.ok) {
      notes.push('`claude mcp add-json` failed; fell back to file merge.');
      mcp = wireMcpViaFile(p, entry, dryRun);
    }
  } else {
    notes.push('`claude` CLI not found on PATH; used file fallback for MCP config.');
    mcp = wireMcpViaFile(p, entry, dryRun);
  }
  console.log(`  ${mcp.ok ? '✓' : '✗'} MCP server   ${mcp.detail}`);
  if (mcp.backup) backups.push(mcp.backup);

  // 3) CLAUDE.md rules
  const curMd = existsSync(p.claudeMd) ? readFileSync(p.claudeMd, 'utf8') : '';
  const nextMd = upsertBlock(curMd);
  const mdChanged = nextMd !== curMd;
  if (mdChanged && !dryRun) {
    const bak = backupFile(p.claudeMd);
    if (bak) backups.push(bak);
    atomicWrite(p.claudeMd, nextMd);
  }
  console.log(`  ✓ CLAUDE.md    ${dryRun ? 'would install' : mdChanged ? 'installed' : 'already up to date'} the delegation rules  (${p.claudeMd})`);

  // 4) settings.json hooks
  if (noHooks) {
    console.log('  • hooks        skipped (--no-hooks)');
  } else {
    const res = readJsonSafe(p.settingsJson);
    if (!res.ok) {
      console.log(`  ✗ hooks        ${p.settingsJson} is not valid JSON — left untouched, hooks NOT installed`);
      notes.push(`Fix ${p.settingsJson} then re-run init to enable hard enforcement.`);
    } else {
      const next = addHooks(res.data);
      const changed = JSON.stringify(next) !== JSON.stringify(res.data);
      if (changed && !dryRun) {
        const bak = backupFile(p.settingsJson);
        if (bak) backups.push(bak);
        atomicWrite(p.settingsJson, JSON.stringify(next, null, 2) + '\n');
      }
      console.log(`  ✓ hooks        ${dryRun ? 'would install' : changed ? 'installed' : 'already up to date'} Read + Skill PreToolUse hooks  (${p.settingsJson})`);
      if (!has('jq')) notes.push('`jq` is NOT installed — the PreToolUse hooks need it. Install jq (e.g. `brew install jq`) or they will silently no-op.');
    }
  }

  // Key guidance
  if (key.mode === 'env-ref') notes.push('MCP config references ${DEEPSEEK_API_KEY}. Make sure that variable is exported in your shell profile so Claude Code can read it.');
  if (key.mode === 'placeholder') notes.push(`No API key set. Replace "${PLACEHOLDER_KEY}" in your MCP config, or set DEEPSEEK_API_KEY and re-run init.`);

  // Report
  console.log('');
  if (backups.length) {
    console.log('  Backups written (restore these to undo manually):');
    for (const b of backups) console.log(`    - ${b}`);
    console.log('');
  }
  if (notes.length) {
    console.log('  Notes:');
    for (const n of notes) console.log(`    ! ${n}`);
    console.log('');
  }
  if (dryRun) {
    console.log('  Dry run complete. Re-run without --dry-run to apply.\n');
  } else {
    console.log('  Done. Restart Claude Code, then heavy tasks will prompt: "Delegate to DeepSeek? (y/n)".');
    console.log('  To remove everything cleanly later:  npx claude-code-deepseek-delegator uninstall\n');
  }
  return 0;
}
