// Proves the installed PreToolUse hooks actually FIRE — i.e. the delegation gate
// really happens, not just that a file was written. We run each hook's exact
// shell command with sample tool input and assert the gate output.

import { test } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHooks } from '../src/setup/wiring.mjs';

const hooks = managedHooks();
const readHook = hooks.find((h) => h.matcher === 'Read').hooks[0].command;
const skillHook = hooks.find((h) => h.matcher === 'Skill').hooks[0].command;

function fire(command, input) {
  const r = spawnSync('sh', ['-c', command], { input: JSON.stringify(input), encoding: 'utf8' });
  return { out: (r.stdout || '').trim(), status: r.status, err: r.stderr };
}

function fileWith(lines) {
  const f = join(mkdtempSync(join(tmpdir(), 'hk-')), 'f.txt');
  writeFileSync(f, Array.from({ length: lines }, (_, i) => `x${i}`).join('\n'));
  return f;
}

test('Read hook fires the gate on a file over 300 lines', () => {
  const { out } = fire(readHook, { tool_input: { file_path: fileWith(450) } });
  ok(out.length > 0, 'hook produced output');
  const parsed = JSON.parse(out);
  ok(parsed.hookSpecificOutput.additionalContext.includes('READ BLOCKED'));
  ok(parsed.hookSpecificOutput.additionalContext.includes('Delegate to DeepSeek?'));
  equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('Read hook stays SILENT on a small file (no false positives)', () => {
  const { out } = fire(readHook, { tool_input: { file_path: fileWith(42) } });
  equal(out, '', 'no gate for a small read');
});

test('Read hook is silent when there is no file_path', () => {
  const { out } = fire(readHook, { tool_input: {} });
  equal(out, '');
});

test('Skill hook fires the gate and names the skill', () => {
  const { out } = fire(skillHook, { tool_input: { skill: 'seo-audit' } });
  const parsed = JSON.parse(out);
  ok(parsed.hookSpecificOutput.additionalContext.includes('DEEPSEEK GATE'));
  ok(parsed.hookSpecificOutput.additionalContext.includes('seo-audit'));
  ok(parsed.hookSpecificOutput.additionalContext.includes('Delegate to DeepSeek?'));
});

test('hooks never crash on malformed stdin', () => {
  const r = spawnSync('sh', ['-c', skillHook], { input: 'not json at all', encoding: 'utf8' });
  equal(r.status, 0, 'exit 0 even on garbage input');
});
