// `claude-code-deepseek-delegator doctor` — verify a real install end to end.
// Goes beyond "files exist": it actually FIRES the installed hooks with sample
// input and confirms the gate text comes out, and resolves every configured
// routing target against the provider registry. That is the closest thing to
// a deterministic "the delegation gate works" check without a live model.

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readJsonSafe, hasBlock, MARKER, PKG_NAME } from './wiring.mjs';
import { getProvider, resolveApiKey, keyEnvVar, resolveModel } from '../providers/registry.mjs';
import { loadConfig, TASKS } from '../config.mjs';
import { intro, outro, bar } from './tui.mjs';
import { color, dim } from '../colors.mjs';

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

// The gate question names whatever provider the user chose — match its shape.
const gateFired = (out) => out.includes('Delegate to ') && out.includes('? (y/n)');

export async function runDoctor() {
  const p = paths();
  const results = [];
  const add = (ok, label, hint) => results.push({ ok, label, hint });

  console.log('');
  intro(`${PKG_NAME} ${dim('· doctor')}`, `config dir: ${p.claudeDir}`);

  // 1) Node present (the hooks need it)
  add(has('node'), 'Node.js available on PATH (required for the hooks)', 'Install Node 20+ and ensure `node` is on PATH.');

  // 2) delegation config + registry resolution
  const cfg = loadConfig();
  const provider = getProvider(cfg.provider);
  add(!!provider, `Active provider "${cfg.provider}" exists in the registry`, `Run: npx ${PKG_NAME} init`);
  if (provider) {
    for (const task of TASKS) {
      let ok = true; let why = '';
      try { resolveModel(cfg.routing[task], cfg.provider); } catch (e) { ok = false; why = e.message; }
      add(ok, `Routing "${task}" → ${cfg.routing[task]} resolves`, why || 'Fix the model id in delegator.json.');
    }
    for (const spec of cfg.shortlist) {
      let ok = true; let why = '';
      try { resolveModel(spec, cfg.provider); } catch (e) { ok = false; why = e.message; }
      add(ok, `Shortlist "${spec}" resolves`, why || 'Fix the entry in delegator.json.');
    }
    const envVar = keyEnvVar(provider);
    add(!!resolveApiKey(provider), `${provider.name} API key is set${envVar ? ` (${envVar})` : ''}`,
      `Export ${envVar || 'the key'} in your shell profile, or re-run init.`);
  }

  // 3) MCP server registered (CLI-authoritative, with file fallback check)
  let mcpOk = false;
  if (has('claude')) {
    mcpOk = spawnSync('claude', ['mcp', 'get', 'deepseek'], { stdio: 'ignore' }).status === 0;
  }
  if (!mcpOk) {
    const res = readJsonSafe(p.legacyMcpJson);
    mcpOk = !!(res.ok && res.data?.mcpServers?.deepseek);
  }
  add(mcpOk, 'MCP server "deepseek" registered with Claude Code', `Run: npx ${PKG_NAME} init`);

  // 4) CLAUDE.md rules present
  const md = existsSync(p.claudeMd) ? readFileSync(p.claudeMd, 'utf8') : '';
  add(hasBlock(md), 'Auto-delegation rules present in CLAUDE.md', `Run: npx ${PKG_NAME} init`);

  // 5) Hooks present in settings.json
  const sres = readJsonSafe(p.settingsJson);
  const installedHooks = sres.ok ? (sres.data?.hooks?.PreToolUse || []).filter((e) => e._managedBy === MARKER) : [];
  const installedPostHooks = sres.ok ? (sres.data?.hooks?.PostToolUse || []).filter((e) => e._managedBy === MARKER) : [];
  if (!sres.ok) add(false, 'settings.json is valid JSON', `Fix ${p.settingsJson} (it is currently malformed), then re-run init.`);
  add(installedHooks.length === 2, `PreToolUse hooks installed (found ${installedHooks.length}/2)`, `Run: npx ${PKG_NAME} init`);
  add(installedPostHooks.length === 1, `PostToolUse cost hook installed (found ${installedPostHooks.length}/1)`, `Run: npx ${PKG_NAME} init`);

  // 6) THE KEY CHECK — fire the installed hooks and confirm the gate fires.
  if (installedHooks.length) {
    const read = installedHooks.find((e) => e.matcher === 'Read');
    const skill = installedHooks.find((e) => e.matcher === 'Skill');
    if (read) {
      const out = fireHook(read.hooks[0].command, JSON.stringify({ tool_input: { file_path: bigFile(301) } }));
      add(gateFired(out), 'Read gate FIRES on a >300-line file (live test)', 'The hook command did not emit the gate. Ensure `node` runs from a plain shell.');
    }
    if (skill) {
      const out = fireHook(skill.hooks[0].command, JSON.stringify({ tool_input: { skill: 'demo' } }));
      add(gateFired(out), 'Skill gate FIRES on skill load (live test)', 'The hook command did not emit the gate. Ensure `node` runs from a plain shell.');
    }
  }
  if (installedPostHooks.length) {
    const sample = {
      tool_name: 'mcp__deepseek__delegate',
      tool_response: { content: [{ type: 'text', text: 'deepseek-cost:{"v":2,"line":"cost display self-test"}' }] },
    };
    const out = fireHook(installedPostHooks[0].hooks[0].command, JSON.stringify(sample));
    add(out.includes('systemMessage') && out.includes('cost display self-test'),
      'Cost display FIRES after a delegate call (live test)',
      'The cost hook did not emit a systemMessage. Ensure `node` runs from a plain shell.');
  }

  // Report
  let allGreen = true;
  for (const r of results) {
    bar(`${r.ok ? color('green', '✓') : color('red', '✗')} ${r.label}`);
    if (!r.ok) { bar(`    ${color('yellow', '→')} ${dim(r.hint)}`); allGreen = false; }
  }
  bar();
  if (allGreen) {
    outro(`${color('green', 'All green.')} The delegation gate is wired and firing. ${dim('Restart Claude Code if you have not since installing.')}`);
    return 0;
  }
  outro(`${color('yellow', 'Some checks failed')} ${dim('(see → hints above). Fix them and re-run doctor.')}`);
  return 1;
}
