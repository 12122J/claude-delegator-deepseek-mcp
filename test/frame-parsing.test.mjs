// Tests for Content-Length frame parsing — issue #24
// Verifies single header accepted, duplicate headers rejected,
// Content-Length anchored with ^, and edge cases handled correctly.

import { parseFrames } from '../src/index.mjs';
import { ok, equal, deepEqual } from 'node:assert/strict';

function frame(body) {
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(`  ${e.message}`);
  }
}

// ── single Content-Length header ──
test('single Content-Length header accepted', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const { consumed, remainder } = parseFrames(frame(msg));
  equal(consumed.length, 1);
  equal(consumed[0], msg);
  equal(remainder, '');
});

// ── duplicate Content-Length headers: rejected ──
test('duplicate CL headers — first wrong, second correct — rejected', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const len = Buffer.byteLength(msg);
  const badFrame = `Content-Length: 9999\r\nContent-Length: ${len}\r\n\r\n${msg}`;
  const { consumed, remainder } = parseFrames(badFrame);
  equal(consumed.length, 0);
  equal(remainder, msg);
});

// ── duplicate with different values: rejected ──
test('duplicate CL headers — first correct, second wrong — rejected', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const len = Buffer.byteLength(msg);
  const badFrame = `Content-Length: ${len}\r\nContent-Length: 99999\r\n\r\n${msg}`;
  const { consumed, remainder } = parseFrames(badFrame);
  equal(consumed.length, 0);
  equal(remainder, msg);
});

// ── three Content-Length headers: rejected ──
test('three Content-Length headers all rejected', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const len = Buffer.byteLength(msg);
  const badFrame = `Content-Length: ${len}\r\nContent-Length: ${len}\r\nContent-Length: 99999\r\n\r\n${msg}`;
  const { consumed, remainder } = parseFrames(badFrame);
  equal(consumed.length, 0);
  equal(remainder, msg);
});

// ── duplicate Content-Length with same value: also rejected ──
test('duplicate CL with same value still rejected', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const len = Buffer.byteLength(msg);
  const badFrame = `Content-Length: ${len}\r\nContent-Length: ${len}\r\n\r\n${msg}`;
  const { consumed, remainder } = parseFrames(badFrame);
  equal(consumed.length, 0);
  equal(remainder, msg);
});

// ── case-insensitive match ──
test('uppercase CONTENT-LENGTH accepted', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 });
  const upper = `CONTENT-LENGTH: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
  const { consumed } = parseFrames(upper);
  equal(consumed.length, 1);
  equal(consumed[0], msg);
});

// ── mixed case ──
test('mixed-case Content-length accepted', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 });
  const mixed = `Content-length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
  const { consumed } = parseFrames(mixed);
  equal(consumed.length, 1);
  equal(consumed[0], msg);
});

// ── no Content-Length header: discarded ──
test('missing Content-Length header discarded', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const badFrame = `X-Foo: bar\r\n\r\n${msg}`;
  const { consumed, remainder } = parseFrames(badFrame);
  equal(consumed.length, 0);
  equal(remainder, msg);
});

// ── Content-Length with leading whitespace (^ anchor robustness) ──
test('leading whitespace before Content-Length — ^ anchor rejects it', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const len = Buffer.byteLength(msg);
  const badFrame = ` Content-Length: ${len}\r\n\r\n${msg}`;
  const { consumed } = parseFrames(badFrame);
  equal(consumed.length, 0);
});

// ── duplicate mixed case ──
test('duplicate Content-Length mixed case rejected', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const len = Buffer.byteLength(msg);
  const badFrame = `content-length: 9999\r\nContent-Length: ${len}\r\n\r\n${msg}`;
  const { consumed, remainder } = parseFrames(badFrame);
  equal(consumed.length, 0);
  equal(remainder, msg);
});

// ── multiple frames in one buffer ──
test('two valid frames parsed from single buffer', () => {
  const msg1 = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const msg2 = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 });
  const input = frame(msg1) + frame(msg2);
  const { consumed, remainder } = parseFrames(input);
  equal(consumed.length, 2);
  equal(consumed[0], msg1);
  equal(consumed[1], msg2);
  equal(remainder, '');
});

// ── partial frame remainder ──
test('partial body not consumed, remainder preserved', () => {
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const len = Buffer.byteLength(msg);
  const partial = `Content-Length: ${len}\r\n\r\n${msg.substring(0, 10)}`;
  const { consumed, remainder: rem } = parseFrames(partial);
  equal(consumed.length, 0);
  ok(rem.length > 0);
});

// ── good frame then bad (duplicate CL) ──
test('good frame consumed, bad duplicate-CL frame skipped', () => {
  const msg1 = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const badBody = JSON.stringify({ jsonrpc: '2.0', method: 'bad', id: 99 });
  const bad = `Content-Length: 9999\r\nContent-Length: ${Buffer.byteLength(badBody)}\r\n\r\n${badBody}`;
  const input = frame(msg1) + bad;
  const { consumed, remainder } = parseFrames(input);
  equal(consumed.length, 1);
  equal(consumed[0], msg1);
  equal(remainder, badBody);
});

// ── onMessage callback fires for valid frames ──
test('onMessage callback fires for valid frame', () => {
  const msgs = [];
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  parseFrames(frame(msg), (m) => msgs.push(m));
  equal(msgs.length, 1);
  deepEqual(msgs[0], JSON.parse(msg));
});

// ── onMessage NOT fired for duplicate CL frame ──
test('onMessage callback NOT fired for duplicate CL frame', () => {
  const msgs = [];
  const msg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const len = Buffer.byteLength(msg);
  const bad = `Content-Length: 9999\r\nContent-Length: ${len}\r\n\r\n${msg}`;
  parseFrames(bad, (m) => msgs.push(m));
  equal(msgs.length, 0);
});

// ── non-JSON body skipped ──
test('non-JSON body gracefully skipped', () => {
  const bad = `Content-Length: 5\r\n\r\nhello`;
  const { consumed, remainder } = parseFrames(bad + frame(JSON.stringify({ ok: true })));
  equal(consumed.length, 1);
  equal(remainder, '');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
