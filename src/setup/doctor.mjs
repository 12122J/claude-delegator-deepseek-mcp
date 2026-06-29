// `claude-code-deepseek-delegator doctor` — verify a real install end to end.
// Goes beyond "files exist": it actually FIRES the installed hooks with sample
// input and confirms the gate text comes out. That is the closest thing to a
// deterministic "the delegation gate works" check without a live model.

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readJsonSafe, hasBlock, MARKER } from './wiring.mjs';

function has(cmd, args = ['--version']) {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; }
}

// Run a hook's shell command with `input` on stdin; return its stdout.
function fireHook(command, input) {
  const r = spawnSync('sh', ['-c', command], { input, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function bigFile(lines) {
  const f = join(mkdtempSync(join(tmpdir(), 'delg-doc-')), 'big.txt');
  writeFileSync(f, Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n'));
  return f;
}

export async function runDoctor() {
  const p = paths();
  const results = [];
  const add = (ok, label, hint) => results.push({ ok, label, hint });

  console.log('\nclaude-code-deepseek-delegator · doctor\n');
  console.log(`  config dir: ${p.claudeDir}\n`);

  // 1) Node present (the hooks need it)
  add(has('node'), 'Node.js available on PATH (required for the hooks)', 'Install Node 20+ and ensure `node` is on PATH.');

  // 2) MCP server registered (CLI-authoritative, with file fallback check)
  let mcpOk = false;
  if (has('claude')) {
    mcpOk = spawnSync('claude', ['mcp', 'get', 'deepseek'], { stdio: 'ignore' }).status === 0;
  }
  if (!mcpOk) {
    const res = readJsonSafe(p.legacyMcpJson);
    mcpOk = !!(res.ok && res.data?.mcpServers?.deepseek);
  }
  add(mcpOk, 'MCP server "deepseek" registered with Claude Code', 'Run: npx claude-code-deepseek-delegator init');

  // 3) CLAUDE.md rules present
  const md = existsSync(p.claudeMd) ? readFileSync(p.claudeMd, 'utf8') : '';
  add(hasBlock(md), 'Auto-delegation rules present in CLAUDE.md', 'Run: npx claude-code-deepseek-delegator init');

  // 4) Hooks present in settings.json
  const sres = readJsonSafe(p.settingsJson);
  const installedHooks = sres.ok ? (sres.data?.hooks?.PreToolUse || []).filter((e) => e._managedBy === MARKER) : [];
  if (!sres.ok) add(false, 'settings.json is valid JSON', `Fix ${p.settingsJson} (it is currently malformed), then re-run init.`);
  add(installedHooks.length === 2, `PreToolUse hooks installed (found ${installedHooks.length}/2)`, 'Run: npx claude-code-deepseek-delegator init');

  // 5) THE KEY CHECK — fire the installed hooks and confirm the gate fires.
  if (installedHooks.length) {
    const read = installedHooks.find((e) => e.matcher === 'Read');
    const skill = installedHooks.find((e) => e.matcher === 'Skill');
    if (read) {
      const out = fireHook(read.hooks[0].command, JSON.stringify({ tool_input: { file_path: bigFile(301) } }));
      add(out.includes('READ BLOCKED'), 'Read gate FIRES on a >300-line file (live test)', 'The hook command did not emit the gate. Ensure `node` runs from a plain shell.');
    }
    if (skill) {
      const out = fireHook(skill.hooks[0].command, JSON.stringify({ tool_input: { skill: 'demo' } }));
      add(out.includes('DEEPSEEK GATE'), 'Skill gate FIRES on skill load (live test)', 'The hook command did not emit the gate. Ensure `node` runs from a plain shell.');
    }
  }

  // 6) API key resolvable at runtime
  const envKey = !!process.env.DEEPSEEK_API_KEY;
  const fileRes = readJsonSafe(p.legacyMcpJson);
  const literalKey = (() => {
    const v = fileRes.ok ? fileRes.data?.mcpServers?.deepseek?.env?.DEEPSEEK_API_KEY : null;
    return typeof v === 'string' && v.startsWith('sk-') && !v.includes('REPLACE');
  })();
  add(envKey || literalKey, 'DeepSeek API key is set (env var or embedded in config)',
    'Set DEEPSEEK_API_KEY in your shell profile, or paste the key into the MCP config env block.');

  // Report
  console.log('  Checks:');
  let allCritical = true;
  for (const r of results) {
    console.log(`    ${r.ok ? '✓' : '✗'} ${r.label}`);
    if (!r.ok) { console.log(`        → ${r.hint}`); allCritical = false; }
  }
  console.log('');
  if (allCritical) {
    console.log('  All green. The delegation gate is wired and firing. Restart Claude Code if you have not since installing.\n');
    return 0;
  }
  console.log('  Some checks failed (see → hints above). Fix them and re-run `doctor`.\n');
  return 1;
}
