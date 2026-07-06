// `claude-code-deepseek-delegator uninstall` — remove exactly what init added,
// and nothing else. Removes the managed CLAUDE.md block, our hooks (PreToolUse
// gates + PostToolUse cost display), and the MCP server registration. User
// content and unrelated config are left fully intact. Backs up every file it
// changes.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  paths, backupFile, atomicWrite, readJsonSafe,
  removeBlock, removeHooks,
} from './wiring.mjs';

function has(cmd, args = ['--version']) {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; }
}

function cliAvailable() {
  return process.env.CLAUDE_DELEGATOR_FORCE_FILE !== '1' && has('claude');
}

function unwireMcpViaFile(p, dryRun) {
  const res = readJsonSafe(p.legacyMcpJson);
  if (!res.ok) return { changed: false, detail: `${p.legacyMcpJson} not valid JSON — left untouched` };
  const data = res.data || {};
  if (!data.mcpServers || !('deepseek' in data.mcpServers)) {
    return { changed: false, detail: 'no deepseek entry in file' };
  }
  delete data.mcpServers.deepseek;
  if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  if (!dryRun) {
    const bak = backupFile(p.legacyMcpJson);
    atomicWrite(p.legacyMcpJson, JSON.stringify(data, null, 2) + '\n');
    return { changed: true, detail: `removed from ${p.legacyMcpJson}`, backup: bak };
  }
  return { changed: true, detail: `would remove from ${p.legacyMcpJson}` };
}

export async function runUninstall(argv = []) {
  const dryRun = argv.includes('--dry-run');
  const p = paths();
  const backups = [];

  console.log(`\nclaude-code-deepseek-delegator · uninstall${dryRun ? '  (dry run — no files will be written)' : ''}\n`);

  // 1) MCP server
  let mcpDetail;
  if (cliAvailable()) {
    if (dryRun) {
      mcpDetail = 'would run `claude mcp remove deepseek --scope user`';
    } else {
      const r = spawnSync('claude', ['mcp', 'remove', 'deepseek', '--scope', 'user'], { encoding: 'utf8' });
      mcpDetail = r.status === 0 ? 'removed via `claude mcp remove`' : 'not registered (nothing to remove)';
    }
  } else {
    const r = unwireMcpViaFile(p, dryRun);
    mcpDetail = r.detail;
    if (r.backup) backups.push(r.backup);
  }
  console.log(`  ✓ MCP server   ${mcpDetail}`);

  // 2) CLAUDE.md block
  const curMd = existsSync(p.claudeMd) ? readFileSync(p.claudeMd, 'utf8') : '';
  const nextMd = removeBlock(curMd);
  const mdChanged = nextMd !== curMd;
  if (mdChanged && !dryRun) {
    const bak = backupFile(p.claudeMd);
    if (bak) backups.push(bak);
    atomicWrite(p.claudeMd, nextMd);
  }
  console.log(`  ✓ CLAUDE.md    ${mdChanged ? (dryRun ? 'would remove' : 'removed') : 'no managed block found'} the delegation rules`);

  // 3) settings.json hooks
  const res = readJsonSafe(p.settingsJson);
  if (!res.ok) {
    console.log(`  ✗ hooks        ${p.settingsJson} is not valid JSON — left untouched`);
  } else {
    const next = removeHooks(res.data);
    const changed = JSON.stringify(next) !== JSON.stringify(res.data);
    if (changed && !dryRun) {
      const bak = backupFile(p.settingsJson);
      if (bak) backups.push(bak);
      atomicWrite(p.settingsJson, JSON.stringify(next, null, 2) + '\n');
    }
    console.log(`  ✓ hooks        ${changed ? (dryRun ? 'would remove' : 'removed') : 'no managed hooks found'}`);
  }

  console.log('');
  if (backups.length) {
    console.log('  Backups written:');
    for (const b of backups) console.log(`    - ${b}`);
    console.log('');
  }
  console.log(`  ${dryRun ? 'Dry run complete.' : 'Done — the delegator is fully unwired from Claude Code.'}`);
  console.log('  Older .deepseek-bak-* backups are left in place; delete them whenever you like.\n');
  return 0;
}
