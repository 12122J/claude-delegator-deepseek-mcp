// Proves the installed PreToolUse hooks actually FIRE — i.e. the delegation gate
// really happens, not just that a file was written. We run each hook's exact
// shell command with sample tool input and assert the gate output.

import { test } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHooks, managedPostHooks } from '../src/setup/wiring.mjs';
import { buildFooter } from '../src/pricing.mjs';
import { resolveModel } from '../src/providers/registry.mjs';

// The real registry entry, so the footer round-trip uses real pricing.
const CTX = resolveModel('deepseek:deepseek-v4-pro');

const hooks = managedHooks();
const readHook = hooks.find((h) => h.matcher === 'Read').hooks[0].command;
const skillHook = hooks.find((h) => h.matcher === 'Skill').hooks[0].command;
const costHook = managedPostHooks()[0].hooks[0].command;

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
  ok(parsed.hookSpecificOutput.additionalContext.includes('Delegate to DeepSeek? (y/n)'));
  ok(parsed.hookSpecificOutput.additionalContext.includes('files[]'), 'tells Claude how to hand off');
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

test('Read hook is silent on binary files — "lines" mean nothing in a PNG', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'hk-')), 'img.png');
  // many newline bytes (>300 "lines") but with NUL bytes like any real binary
  writeFileSync(f, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(400, 0x0a), Buffer.from([0x00])]));
  const { out } = fire(readHook, { tool_input: { file_path: f } });
  equal(out, '', 'no gate for binary content');
});

test('Skill hook fires the gate and names the skill', () => {
  const { out } = fire(skillHook, { tool_input: { skill: 'seo-audit' } });
  const parsed = JSON.parse(out);
  ok(parsed.hookSpecificOutput.additionalContext.includes('seo-audit'), 'names the skill');
  ok(parsed.hookSpecificOutput.additionalContext.includes('Delegate to DeepSeek? (y/n)'));
});

test('hooks never crash on malformed stdin', () => {
  const r = spawnSync('sh', ['-c', skillHook], { input: 'not json at all', encoding: 'utf8' });
  equal(r.status, 0, 'exit 0 even on garbage input');
});

// ── PostToolUse cost display ────────────────────────────────────────────────
// End to end: the REAL footer produced by pricing.mjs (ANSI codes and all) must
// round-trip through the exact hook command stored in settings.json and come
// out as a user-visible systemMessage.

test('cost hook surfaces the real pricing.mjs footer as a systemMessage', () => {
  const footer = buildFooter(
    { usage: { promptTokens: 12345, completionTokens: 678, totalTokens: 13023 } },
    CTX
  );
  const { out } = fire(costHook, {
    tool_name: 'mcp__delegate__delegate',
    tool_response: { content: [{ type: 'text', text: 'the actual answer\n' + footer }] },
  });
  ok(out.length > 0, 'hook produced output');
  const parsed = JSON.parse(out);
  ok(typeof parsed.systemMessage === 'string', 'systemMessage present');
  ok(parsed.systemMessage.includes('saved'), 'mentions savings');
  ok(parsed.systemMessage.includes('13,023 tokens'), 'mentions token count');
  ok(parsed.systemMessage.includes('$'), 'mentions dollar cost');
  ok(!parsed.systemMessage.includes(String.fromCharCode(27)), 'no ANSI codes leak into the message');
});

test('cost hook handles the streamed shape (footer in the last content item)', () => {
  const footer = buildFooter(
    { usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
    CTX
  );
  const { out } = fire(costHook, {
    tool_response: { content: [{ type: 'text', text: 'chunk 1' }, { type: 'text', text: 'chunk 2' }, { type: 'text', text: footer }] },
  });
  const parsed = JSON.parse(out);
  ok(parsed.systemMessage.includes('150 tokens'));
});

test('cost hook stays silent when there is no cost marker', () => {
  const { out } = fire(costHook, {
    tool_response: { content: [{ type: 'text', text: 'an answer with no usage data' }] },
  });
  equal(out, '', 'no message without a marker');
});

test('cost hook stays silent when usage was missing (empty footer)', () => {
  const footer = buildFooter({ usage: null }, CTX);
  equal(footer, '', 'no footer without usage');
  const { out } = fire(costHook, {
    tool_response: { content: [{ type: 'text', text: 'answer' + footer }] },
  });
  equal(out, '');
});

test('cost hook never crashes on malformed stdin', () => {
  const r = spawnSync('sh', ['-c', costHook], { input: 'not json at all', encoding: 'utf8' });
  equal(r.status, 0, 'exit 0 even on garbage input');
});
