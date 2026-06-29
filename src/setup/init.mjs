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
  MANAGED_RULES, BLOCK_BEGIN, BLOCK_END,
} from './wiring.mjs';
import { color, bold, dim } from '../colors.mjs';

const PLACEHOLDER_KEY = 'sk-REPLACE_WITH_YOUR_DEEPSEEK_KEY';

// Console styling helpers — keep init output clean and consistent.
const RULE = dim('─'.repeat(64));
const OK = color('green', '✓');
const NO = color('red', '✗');
const SKIP = dim('•');
// One aligned status line: mark, bold fixed-width label, then detail.
function row(mark, label, detail) {
  return `  ${mark} ${bold(label.padEnd(10))} ${detail}`;
}

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

// Like ask(), but does NOT echo what's typed — for pasting a secret so the
// key never lands in the terminal scrollback.
function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {}; // swallow the echoed keystrokes
    rl.question('', (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve((a || '').trim());
    });
  });
}

async function resolveApiKey({ assumeYes }) {
  // Best path: the key is already exported — reference it so no secret is
  // written to disk and it's available to every tool, not just this one.
  if (process.env.DEEPSEEK_API_KEY) {
    return { value: '${DEEPSEEK_API_KEY}', mode: 'env-ref' };
  }
  // Otherwise, let the user paste it right here. Input is hidden.
  if (!assumeYes && process.stdin.isTTY) {
    console.log('');
    console.log(dim('  No DEEPSEEK_API_KEY in your environment. Get a key at'));
    console.log(dim('  https://platform.deepseek.com/api_keys'));
    const pasted = await askSecret('  Paste your DeepSeek API key (hidden), or press Enter to add it later: ');
    if (pasted) {
      if (!pasted.startsWith('sk-')) {
        console.log(`  ${color('yellow', '!')} ${dim('that doesn\'t look like a DeepSeek key (they start with "sk-") — saving it anyway')}`);
      }
      return { value: pasted, mode: 'literal' };
    }
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

  console.log('');
  console.log(`${color('cyan', '◆')} ${bold('claude-code-deepseek-delegator')} ${dim('· init')}${dryRun ? dim('   (dry run — nothing will be written)') : ''}`);
  console.log(RULE);
  console.log('');

  // ── Full disclosure: show EXACTLY what will be added, then ask. Nothing is
  //    written before this point. The user sees every change up front. ──
  console.log(bold('This makes 3 changes to your Claude Code config:'));
  console.log('');
  console.log(`  ${bold('1.')} ${bold('CLAUDE.md')}   ${dim(p.claudeMd)}`);
  console.log(`     Appends the block below. Your existing file is untouched ${dim('— nothing is overwritten.')}`);
  console.log('');
  for (const line of `${BLOCK_BEGIN}\n${MANAGED_RULES}\n${BLOCK_END}`.split('\n')) {
    console.log(`${dim('     │')} ${line}`);
  }
  console.log('');
  console.log(`  ${bold('2.')} ${bold('settings.json')}   ${dim(p.settingsJson)}`);
  if (noHooks) {
    console.log(`     ${dim('skipped — you passed --no-hooks')}`);
  } else {
    console.log('     Adds two PreToolUse hooks that nudge "Delegate to DeepSeek? (y/n)" before');
    console.log(`     large file reads and skill loads. They only ${bold('add context')} — they never`);
    console.log(`     block, delete, or modify your tool calls. Plain ${dim('node')}, no ${dim('jq')}.`);
  }
  console.log('');
  console.log(`  ${bold('3.')} ${bold('MCP server')}   registers "deepseek" ${dim('(npx -y claude-code-deepseek-delegator)')}`);
  console.log('');
  console.log(dim('  Reversible anytime:  npx claude-code-deepseek-delegator uninstall'));
  console.log(dim('  A timestamped backup is written before any file changes.'));
  console.log('');

  if (!dryRun && !assumeYes) {
    if (!process.stdin.isTTY) {
      console.log('Not an interactive terminal. Re-run with --yes to apply, or --dry-run to preview only.\n');
      return 1;
    }
    const answer = (await ask('Apply these changes? (y/N): ')).toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('\nCancelled. Nothing was changed.\n');
      return 1;
    }
    console.log('');
  }

  // 1) API key
  const key = await resolveApiKey({ assumeYes });
  const entry = mcpEntry(key.value);

  console.log(bold(dryRun ? 'Would apply:' : 'Applying:'));

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
  console.log(row(mcp.ok ? OK : NO, 'MCP server', mcp.detail));
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
  console.log(row(OK, 'CLAUDE.md', `${dryRun ? 'would install' : mdChanged ? 'installed' : 'already up to date'} the delegation rules  ${dim('(' + p.claudeMd + ')')}`));

  // 4) settings.json hooks
  if (noHooks) {
    console.log(row(SKIP, 'hooks', dim('skipped (--no-hooks)')));
  } else {
    const res = readJsonSafe(p.settingsJson);
    if (!res.ok) {
      console.log(row(NO, 'hooks', `${dim(p.settingsJson)} is not valid JSON — left untouched, hooks NOT installed`));
      notes.push(`Fix ${p.settingsJson} then re-run init to enable hard enforcement.`);
    } else {
      const next = addHooks(res.data);
      const changed = JSON.stringify(next) !== JSON.stringify(res.data);
      if (changed && !dryRun) {
        const bak = backupFile(p.settingsJson);
        if (bak) backups.push(bak);
        atomicWrite(p.settingsJson, JSON.stringify(next, null, 2) + '\n');
      }
      console.log(row(OK, 'hooks', `${dryRun ? 'would install' : changed ? 'installed' : 'already up to date'} Read + Skill PreToolUse hooks  ${dim('(' + p.settingsJson + ')')}`));
      if (!has('node')) notes.push('`node` was not found on PATH — the PreToolUse hooks run via node, so make sure node is on PATH.');
    }
  }

  // Key guidance
  if (key.mode === 'env-ref') notes.push('MCP config references ${DEEPSEEK_API_KEY}. Make sure that variable is exported in your shell profile so Claude Code can read it.');
  if (key.mode === 'literal') notes.push('Your API key was saved into the MCP config. To keep it out of that file (and share it with other tools), export DEEPSEEK_API_KEY in your shell profile and re-run init.');
  if (key.mode === 'placeholder') notes.push(`No API key set. Replace "${PLACEHOLDER_KEY}" in your MCP config, or set DEEPSEEK_API_KEY and re-run init.`);

  // Report
  console.log('');
  console.log(RULE);
  if (backups.length) {
    console.log(dim('  Backups (restore to undo manually):'));
    for (const b of backups) console.log(dim(`    ${b}`));
    console.log('');
  }
  if (notes.length) {
    console.log(`  ${color('yellow', 'Notes')}`);
    for (const n of notes) console.log(`    ${color('yellow', '!')} ${n}`);
    console.log('');
  }
  if (dryRun) {
    console.log(`  ${bold('Dry run complete.')} Re-run without ${dim('--dry-run')} to apply.`);
  } else {
    console.log(`  ${color('green', 'Done.')} Restart Claude Code — heavy tasks will then prompt ${bold('"Delegate to DeepSeek? (y/n)"')}.`);
    console.log(dim('  Remove everything later:  npx claude-code-deepseek-delegator uninstall'));
  }
  console.log('');
  return 0;
}
