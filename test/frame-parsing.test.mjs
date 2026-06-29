// Tests for newline-delimited JSON parsing — the MCP stdio transport framing.
// (MCP stdio: "Messages are delimited by newlines, and MUST NOT contain
// embedded newlines.")

import { test } from 'node:test';
import { parseLines } from '../src/framing.mjs';
import { equal, deepEqual } from 'node:assert/strict';

const obj = (o) => JSON.stringify(o);

test('single line is parsed and consumed', () => {
  const msg = obj({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const { consumed, remainder } = parseLines(msg + '\n');
  equal(consumed.length, 1);
  equal(consumed[0], msg);
  equal(remainder, '');
});

test('multiple lines in one buffer all parse', () => {
  const m1 = obj({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const m2 = obj({ jsonrpc: '2.0', method: 'tools/list', id: 2 });
  const { consumed, remainder } = parseLines(`${m1}\n${m2}\n`);
  equal(consumed.length, 2);
  equal(consumed[0], m1);
  equal(consumed[1], m2);
  equal(remainder, '');
});

test('a partial final line is preserved as remainder, not consumed', () => {
  const m1 = obj({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const partial = '{"jsonrpc":"2.0","method":"too';
  const { consumed, remainder } = parseLines(`${m1}\n${partial}`);
  equal(consumed.length, 1);
  equal(remainder, partial);
});

test('CRLF line endings are tolerated', () => {
  const msg = obj({ jsonrpc: '2.0', method: 'ping', id: 3 });
  const { consumed } = parseLines(`${msg}\r\n`);
  equal(consumed.length, 1);
  equal(consumed[0], msg);
});

test('blank lines are ignored', () => {
  const msg = obj({ jsonrpc: '2.0', method: 'ping', id: 4 });
  const { consumed } = parseLines(`\n\n${msg}\n\n`);
  equal(consumed.length, 1);
  equal(consumed[0], msg);
});

test('non-JSON lines are skipped without breaking later valid lines', () => {
  const good = obj({ jsonrpc: '2.0', method: 'ping', id: 5 });
  const { consumed } = parseLines(`this is not json\n${good}\n`);
  equal(consumed.length, 1);
  equal(consumed[0], good);
});

test('onMessage fires with the parsed object for each line', () => {
  const msgs = [];
  const m1 = obj({ jsonrpc: '2.0', method: 'a', id: 1 });
  const m2 = obj({ jsonrpc: '2.0', method: 'b', id: 2 });
  parseLines(`${m1}\n${m2}\n`, (m) => msgs.push(m));
  equal(msgs.length, 2);
  deepEqual(msgs[0], JSON.parse(m1));
  deepEqual(msgs[1], JSON.parse(m2));
});

test('messages split across chunks reassemble via the remainder', () => {
  const msg = obj({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const half = Math.floor(msg.length / 2);
  // first chunk: no newline yet
  let r = parseLines(msg.slice(0, half));
  equal(r.consumed.length, 0);
  // second chunk: remainder + rest + newline
  r = parseLines(r.remainder + msg.slice(half) + '\n');
  equal(r.consumed.length, 1);
  equal(r.consumed[0], msg);
});

test('no newline yet means nothing consumed, all held as remainder', () => {
  const msg = obj({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  const { consumed, remainder } = parseLines(msg);
  equal(consumed.length, 0);
  equal(remainder, msg);
});
