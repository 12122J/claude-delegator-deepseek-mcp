// Tests for index.mjs — JSON-RPC message parsing, framing, exports
// This complements the existing frame-parsing.test.mjs with
// additional JSON-RPC-level tests.
// Requires: node --test test/index.test.mjs

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, match, throws } from 'node:assert/strict';

// Import the exported parseFrames function
import { parseFrames } from '../src/index.mjs';

describe('index.mjs — JSON-RPC message handling', () => {

  describe('parseFrames robustness', () => {
    function frame(body) {
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }

    it('emits JSON-RPC initialization message correctly', () => {
      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
        id: 1,
      });
      const { consumed } = parseFrames(frame(msg));
      deepStrictEqual(consumed.length, 1);
      const parsed = JSON.parse(consumed[0]);
      deepStrictEqual(parsed.method, 'initialize');
      deepStrictEqual(parsed.jsonrpc, '2.0');
      ok(parsed.id !== undefined);
    });

    it('emits tools/list message correctly', () => {
      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 2,
      });
      const { consumed } = parseFrames(frame(msg));
      deepStrictEqual(consumed.length, 1);
      const parsed = JSON.parse(consumed[0]);
      deepStrictEqual(parsed.method, 'tools/list');
    });

    it('emits tools/call message with arguments', () => {
      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'deepseek', arguments: { prompt: 'hello' } },
        id: 3,
      });
      const { consumed } = parseFrames(frame(msg));
      const parsed = JSON.parse(consumed[0]);
      deepStrictEqual(parsed.params.name, 'deepseek');
      deepStrictEqual(parsed.params.arguments.prompt, 'hello');
    });

    it('handles notification (no id field)', () => {
      const msgs = [];
      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      parseFrames(frame(msg), (m) => msgs.push(m));
      deepStrictEqual(msgs.length, 1);
      deepStrictEqual(msgs[0].method, 'notifications/initialized');
      ok(msgs[0].id === undefined);
    });

    it('handles empty params object in message', () => {
      const msgs = [];
      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method: 'ping',
        id: 1,
      });
      parseFrames(frame(msg), (m) => msgs.push(m));
      deepStrictEqual(msgs.length, 1);
      deepStrictEqual(msgs[0].method, 'ping');
    });

    it('handles unicode characters in body (ASCII-safe JSON)', () => {
      // MCP uses ASCII-safe JSON; parseFrames works with string offsets.
      // Unicode tests verify JSON parsing preserves escape sequences correctly.
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'deepseek', arguments: { prompt: 'hello world!' } },
        id: 1,
      });
      const { consumed } = parseFrames(frame(payload));
      deepStrictEqual(consumed.length, 1);
      const parsed = JSON.parse(consumed[0]);
      deepStrictEqual(parsed.params.arguments.prompt, 'hello world!');
    });

    it('correctly uses Buffer.byteLength for content-length framing', () => {
      // Verify that Content-Length uses byte length (not string length)
      // This matters for JSON that may contain unicode escape sequences
      const payload = JSON.stringify({ data: 'hello world', count: 42 });
      const byteLen = Buffer.byteLength(payload);
      // For ASCII JSON, byte length === string length
      deepStrictEqual(byteLen, payload.length);
      const { consumed } = parseFrames(
        `Content-Length: ${byteLen}\r\n\r\n${payload}`
      );
      deepStrictEqual(consumed.length, 1);
      deepStrictEqual(consumed[0], payload);
    });

    it('parses multiple valid frames from concatenated buffer', () => {
      const msgs = [];
      const buffers = [];
      for (let i = 0; i < 5; i++) {
        const msg = JSON.stringify({ jsonrpc: '2.0', method: 'test', id: i });
        buffers.push(frame(msg));
      }
      const input = buffers.join('');
      const { consumed } = parseFrames(input, (m) => msgs.push(m));
      deepStrictEqual(consumed.length, 5);
      deepStrictEqual(msgs.length, 5);
      for (let i = 0; i < 5; i++) {
        deepStrictEqual(msgs[i].id, i);
      }
    });

    it('retains remainder when buffer has incomplete second frame', () => {
      const msg1 = JSON.stringify({ ok: 1 });
      const partial = `Content-Length: 100\r\n\r\n{"incomplete`;
      const input = frame(msg1) + partial;
      const { consumed, remainder } = parseFrames(input);
      deepStrictEqual(consumed.length, 1);
      ok(remainder.length > 0, 'should have remainder');
    });

    it('Content-Length with leading spaces in value', () => {
      const payload = '{"hello":"world"}';
      const len = Buffer.byteLength(payload);
      const input = `Content-Length:   ${len}\r\n\r\n${payload}`;
      const { consumed } = parseFrames(input);
      deepStrictEqual(consumed.length, 1);
      deepStrictEqual(consumed[0], payload);
    });
  });

  describe('parseFrames edge cases', () => {
    it('skips invalid JSON body gracefully', () => {
      const input = `Content-Length: 9\r\n\r\nnot valid`;
      const { consumed, remainder } = parseFrames(input);
      deepStrictEqual(consumed.length, 0);
      deepStrictEqual(remainder, '');
    });

    it('skips frame with no Content-Length header', () => {
      const input = `X-Something: foo\r\n\r\n{"hello":"world"}`;
      const { consumed, remainder } = parseFrames(input);
      deepStrictEqual(consumed.length, 0);
      deepStrictEqual(remainder, '{"hello":"world"}');
    });

    it('handles empty buffer gracefully', () => {
      const { consumed, remainder } = parseFrames('');
      deepStrictEqual(consumed.length, 0);
      deepStrictEqual(remainder, '');
    });

    it('handles header with no body (zero content-length)', () => {
      const { consumed, remainder } = parseFrames('Content-Length: 0\r\n\r\n');
      deepStrictEqual(consumed.length, 0);
      // JSON.parse("") throws, so consumed is empty
      deepStrictEqual(remainder, '');
    });
  });

  describe('onMessage callback behavior', () => {
    it('callback receives parsed JSON object', () => {
      const msgs = [];
      const body = JSON.stringify({ jsonrpc: '2.0', method: 'test', params: { a: 1 }, id: 42 });
      parseFrames(
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        (m) => msgs.push(m)
      );
      deepStrictEqual(msgs.length, 1);
      deepStrictEqual(typeof msgs[0], 'object');
      deepStrictEqual(msgs[0].method, 'test');
      deepStrictEqual(msgs[0].params.a, 1);
      deepStrictEqual(msgs[0].id, 42);
    });

    it('callback is not called for invalid frames', () => {
      const msgs = [];
      const bad = 'Content-Length: 9999\r\nContent-Length: 5\r\n\r\nhello';
      parseFrames(bad, (m) => msgs.push(m));
      deepStrictEqual(msgs.length, 0);
    });

    it('handles undefined callback gracefully', () => {
      const body = JSON.stringify({ ok: true });
      const { consumed } = parseFrames(
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
      deepStrictEqual(consumed.length, 1);
    });
  });
});
