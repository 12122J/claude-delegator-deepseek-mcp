import { test } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, BLOCK_BEGIN } from '../src/setup/wiring.mjs';

const INDEX = fileURLToPath(new URL('../src/index.mjs', import.meta.url));

const USER_CLAUDE_MD = '# My personal rules\n\nNever touch my secrets.\nAlways be concise.\n';
const USER_SETTINGS = {
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
};

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'delg-e2e-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), USER_CLAUDE_MD);
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(USER_SETTINGS, null, 2));
  return home;
}

function run(home, args) {
  return spawnSync(process.execPath, [INDEX, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_DELEGATOR_HOME: home,
      CLAUDE_DELEGATOR_FORCE_FILE: '1', // never touch a real claude config via CLI
      DEEPSEEK_API_KEY: 'sk-test-key',
    },
  });
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('init wires everything without clobbering user content', () => {
  const home = setupHome();
  const claudeMd = join(home, '.claude', 'CLAUDE.md');
  const settings = join(home, '.claude', 'settings.json');
  const mcp = join(home, '.claude', 'mcp.json');

  const r = run(home, ['init', '--yes']);
  equal(r.status, 0, r.stderr || r.stdout);

  const md = readFileSync(claudeMd, 'utf8');
  ok(md.includes('# My personal rules'), 'user heading preserved');
  ok(md.includes('Never touch my secrets.'), 'user content preserved');
  ok(md.includes(BLOCK_BEGIN), 'managed block installed');
  ok(md.includes('Delegate to DeepSeek?'), 'rules present');

  const s = readJson(settings);
  equal(s.permissions.allow[0], 'Bash(ls:*)', 'unrelated settings preserved');
  ok(s.hooks.PreToolUse.some((e) => e.matcher === 'Bash'), 'user hook preserved');
  equal(s.hooks.PreToolUse.filter((e) => e._managedBy === MARKER).length, 2, 'two managed gate hooks');
  equal(s.hooks.PostToolUse.filter((e) => e._managedBy === MARKER).length, 1, 'cost display hook installed');

  ok(existsSync(mcp), 'mcp.json written (file fallback)');
  const m = readJson(mcp);
  equal(m.mcpServers.delegate.command, 'npx');
  ok(m.mcpServers.delegate.args.includes('claude-code-deepseek-delegator'));

  const backups = readdirSync(join(home, '.claude')).filter((f) => f.includes('.deepseek-bak-'));
  ok(backups.length >= 2, 'backups created for changed files');
});

test('init is idempotent — second run does not duplicate', () => {
  const home = setupHome();
  run(home, ['init', '--yes']);
  run(home, ['init', '--yes']);
  const md = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
  equal(md.split(BLOCK_BEGIN).length - 1, 1, 'exactly one managed block');
  const s = readJson(join(home, '.claude', 'settings.json'));
  equal(s.hooks.PreToolUse.filter((e) => e._managedBy === MARKER).length, 2, 'still exactly two managed gate hooks');
  equal(s.hooks.PostToolUse.filter((e) => e._managedBy === MARKER).length, 1, 'still exactly one cost display hook');
});

test('uninstall removes only ours and restores user content', () => {
  const home = setupHome();
  run(home, ['init', '--yes']);
  const r = run(home, ['uninstall']);
  equal(r.status, 0, r.stderr || r.stdout);

  const md = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
  ok(md.includes('# My personal rules'), 'user content intact after uninstall');
  ok(!md.includes(BLOCK_BEGIN), 'managed block removed');
  ok(!md.includes('Delegate to DeepSeek?'), 'rules removed');

  const s = readJson(join(home, '.claude', 'settings.json'));
  ok(s.hooks.PreToolUse.some((e) => e.matcher === 'Bash'), 'user hook still there');
  equal(s.hooks.PreToolUse.filter((e) => e._managedBy === MARKER).length, 0, 'managed hooks gone');
  equal(s.hooks.PostToolUse, undefined, 'cost display hook gone, empty array cleaned up');

  const m = readJson(join(home, '.claude', 'mcp.json'));
  ok(!m.mcpServers || (!('deepseek' in m.mcpServers) && !('delegate' in m.mcpServers)), 'mcp entry removed (both keys)');
});

test('dry-run writes nothing', () => {
  const home = setupHome();
  const before = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
  const r = run(home, ['init', '--yes', '--dry-run']);
  equal(r.status, 0);
  equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), before, 'CLAUDE.md untouched');
  ok(!existsSync(join(home, '.claude', 'mcp.json')), 'no mcp.json written');
  const backups = readdirSync(join(home, '.claude')).filter((f) => f.includes('.deepseek-bak-'));
  equal(backups.length, 0, 'no backups in dry run');
});

test('switching providers keeps the previous provider key (the keyring bug)', () => {
  const home = setupHome();
  const mcp = join(home, '.claude', 'mcp.json');

  // 1st init: deepseek, env-ref (DEEPSEEK_API_KEY exported in run()'s env)
  run(home, ['init', '--yes']);
  equal(readJson(mcp).mcpServers.delegate.env.DEEPSEEK_API_KEY, '${DEEPSEEK_API_KEY}');

  // 2nd init: switch to moonshot with a pasted key — deepseek's must survive
  run(home, ['init', '--yes', '--provider', 'moonshot', '--key', 'sk-moon-test']);
  const env = readJson(mcp).mcpServers.delegate.env;
  equal(env.MOONSHOT_API_KEY, 'sk-moon-test', 'new provider key saved');
  equal(env.DEEPSEEK_API_KEY, '${DEEPSEEK_API_KEY}', 'previous key NOT clobbered');

  // 3rd init back to moonshot with NO key flag and no env var: the stored
  // key must be reused, not lost to a placeholder
  run(home, ['init', '--yes', '--provider', 'moonshot']);
  const env2 = readJson(mcp).mcpServers.delegate.env;
  equal(env2.MOONSHOT_API_KEY, 'sk-moon-test', 'stored key reused on re-init');
});

test('--provider accepts a comma list; first is primary, all keys enroll', () => {
  const home = setupHome();
  run(home, ['init', '--yes', '--provider', 'deepseek,moonshot']);
  const cfg = readJson(join(home, '.claude', 'delegator.json'));
  equal(cfg.provider, 'deepseek', 'first listed provider is primary');
  const env = readJson(join(home, '.claude', 'mcp.json')).mcpServers.delegate.env;
  equal(env.DEEPSEEK_API_KEY, '${DEEPSEEK_API_KEY}', 'primary key enrolled (env-ref)');
  ok(!('MOONSHOT_API_KEY' in env), 'no moonshot key available ⇒ nothing stored, no placeholder');
});

test('malformed settings.json is never overwritten', () => {
  const home = setupHome();
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, '{ broken json ');
  const r = run(home, ['init', '--yes']);
  equal(r.status, 0, 'init still succeeds for the other steps');
  equal(readFileSync(settings, 'utf8'), '{ broken json ', 'malformed file left exactly as-is');
});
