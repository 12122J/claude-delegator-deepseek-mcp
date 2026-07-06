import { test } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import {
  upsertBlock, removeBlock, hasBlock,
  addHooks, removeHooks, managedHooks, managedPostHooks,
  readJsonSafe, MARKER, BLOCK_BEGIN, BLOCK_END,
} from '../src/setup/wiring.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── CLAUDE.md block ────────────────────────────────────────────────────────

test('upsertBlock appends to existing content and preserves it', () => {
  const original = '# My rules\n\nSome important personal instructions.\n';
  const out = upsertBlock(original);
  ok(out.startsWith('# My rules'), 'keeps the user content at the top');
  ok(out.includes('Some important personal instructions.'), 'user text untouched');
  ok(hasBlock(out), 'block now present');
});

test('upsertBlock is idempotent — running twice does not duplicate', () => {
  const original = '# My rules\n';
  const once = upsertBlock(original);
  const twice = upsertBlock(once);
  equal(once, twice, 'second run is a no-op');
  equal(twice.split(BLOCK_BEGIN).length - 1, 1, 'exactly one begin marker');
  equal(twice.split(BLOCK_END).length - 1, 1, 'exactly one end marker');
});

test('upsertBlock replaces in place, never touching text around it', () => {
  const before = 'TOP CONTENT\n';
  const after = '\nBOTTOM CONTENT\n';
  const stale = `${before}${BLOCK_BEGIN}\nOLD STALE RULES\n${BLOCK_END}${after}`;
  const out = upsertBlock(stale);
  ok(out.includes('TOP CONTENT'), 'top preserved');
  ok(out.includes('BOTTOM CONTENT'), 'bottom preserved');
  ok(!out.includes('OLD STALE RULES'), 'stale rules replaced');
  ok(out.includes('Delegate to DeepSeek?'), 'fresh rules present');
});

test('upsertBlock works on a brand new (empty) file', () => {
  const out = upsertBlock('');
  ok(hasBlock(out));
});

test('removeBlock removes only our block and preserves the rest', () => {
  const out = upsertBlock('# Keep me\n\nKeep this line too.\n');
  const removed = removeBlock(out);
  ok(removed.includes('# Keep me'), 'user heading preserved');
  ok(removed.includes('Keep this line too.'), 'user line preserved');
  ok(!hasBlock(removed), 'block gone');
  ok(!removed.includes('Delegate to DeepSeek?'), 'rules gone');
});

test('removeBlock on text without our block leaves it untouched', () => {
  const text = '# Just my stuff\nnothing managed here\n';
  equal(removeBlock(text), text);
});

test('upsert then remove returns to original user content', () => {
  const original = '# Original\n\nLine A\nLine B\n';
  const round = removeBlock(upsertBlock(original));
  equal(round.trim(), original.trim());
});

// ── settings.json hooks ─────────────────────────────────────────────────────

test('addHooks adds our three hooks and preserves the user’s existing hooks', () => {
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
  const settings = { permissions: { allow: ['Bash'] }, hooks: { PreToolUse: [userHook] } };
  const out = addHooks(settings);
  equal(out.hooks.PreToolUse.length, 3, 'user hook + our two');
  ok(out.hooks.PreToolUse.some((e) => e.matcher === 'Bash'), 'user Bash hook kept');
  ok(out.hooks.PreToolUse.some((e) => e.matcher === 'Read' && e._managedBy === MARKER));
  ok(out.hooks.PreToolUse.some((e) => e.matcher === 'Skill' && e._managedBy === MARKER));
  equal(out.hooks.PostToolUse.length, 1, 'our cost hook');
  ok(out.hooks.PostToolUse.some((e) => e.matcher === '^mcp__deepseek__deepseek$' && e._managedBy === MARKER));
  deepEqual(out.permissions, { allow: ['Bash'] }, 'unrelated settings untouched');
});

test('addHooks is idempotent — twice still yields exactly our three', () => {
  const out = addHooks(addHooks({}));
  equal(out.hooks.PreToolUse.filter((e) => e._managedBy === MARKER).length, 2);
  equal(out.hooks.PostToolUse.filter((e) => e._managedBy === MARKER).length, 1);
});

test('addHooks preserves user PostToolUse hooks and untouched events', () => {
  const settings = { hooks: { PostToolUse: [{ matcher: 'X', hooks: [] }], Stop: [{ hooks: [] }] } };
  const out = addHooks(settings);
  equal(out.hooks.PostToolUse.length, 2, 'user PostToolUse hook + our cost hook');
  ok(out.hooks.PostToolUse.some((e) => e.matcher === 'X'), 'user PostToolUse hook kept');
  equal(out.hooks.Stop.length, 1, 'unmanaged events untouched');
  equal(out.hooks.PreToolUse.length, 2, 'PreToolUse got our two');
});

test('removeHooks removes only ours and keeps the user’s', () => {
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
  const installed = addHooks({ hooks: { PreToolUse: [userHook] } });
  const out = removeHooks(installed);
  equal(out.hooks.PreToolUse.length, 1, 'only user hook remains');
  equal(out.hooks.PreToolUse[0].matcher, 'Bash');
  equal(out.hooks.PostToolUse, undefined, 'our cost hook removed, empty array cleaned up');
});

test('removeHooks cleans up empty structures it created', () => {
  const out = removeHooks(addHooks({}));
  deepEqual(out, {}, 'no empty hooks/PreToolUse/PostToolUse left behind');
});

test('removeHooks leaves a pre-existing empty hooks object alone', () => {
  deepEqual(removeHooks({ hooks: {} }), { hooks: {} }, 'we never created it, we never delete it');
});

test('removeHooks also catches our hooks if the _managedBy tag was stripped', () => {
  const tagless = managedHooks().map(({ _managedBy, ...rest }) => rest); // eslint-disable-line no-unused-vars
  const taglessPost = managedPostHooks().map(({ _managedBy, ...rest }) => rest); // eslint-disable-line no-unused-vars
  const out = removeHooks({ hooks: { PreToolUse: tagless, PostToolUse: taglessPost } });
  equal(out.hooks?.PreToolUse?.length ?? 0, 0, 'signature match removed them');
  equal(out.hooks?.PostToolUse?.length ?? 0, 0, 'signature match removed the cost hook too');
});

// ── malformed JSON safety ───────────────────────────────────────────────────

test('readJsonSafe flags malformed JSON as not-ok (so caller never overwrites)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delg-'));
  const bad = join(dir, 'settings.json');
  writeFileSync(bad, '{ this is : not json, ');
  const res = readJsonSafe(bad);
  equal(res.ok, false);
  equal(res.existed, true);
  ok(res.raw.includes('not json'), 'raw preserved for the caller');
});

test('readJsonSafe treats a missing file as empty object', () => {
  const res = readJsonSafe(join(tmpdir(), 'definitely-missing-' + Date.now() + '.json'));
  equal(res.ok, true);
  equal(res.existed, false);
  deepEqual(res.data, {});
});
