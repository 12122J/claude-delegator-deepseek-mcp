// Tests for DeepSeek client — validation, error handling
// Tests validation logic that runs before HTTP requests.
// Requires: node --test test/client.test.mjs

import { describe, it, before } from 'node:test';
import { deepStrictEqual, ok, match } from 'node:assert/strict';

// We test validation logic by importing the module with a known-dummy API key.
// Validation checks run BEFORE network calls, so we can test them in isolation.
// Tests that would hit the network are skipped or handled gracefully.

describe('DeepSeek client validation (client.mjs)', () => {
  let callDeepSeek;

  before(() => {
    // We import the module to access callDeepSeek.
    // Validation is tested below — network calls are avoided by using
    // invalid parameters that trigger validation errors first.
  });

  // ── prompt validation (runs before network) ──

  it('rejects missing prompt', async () => {
    // Dynamic import gets a fresh module view
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({});
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('prompt must be a non-empty string'));
      deepStrictEqual(err.status, 400);
      deepStrictEqual(err.name, 'DeepSeekError');
    }
  });

  it('rejects empty string prompt', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: '' });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('prompt must be a non-empty string'));
      deepStrictEqual(err.status, 400);
    }
  });

  it('rejects whitespace-only prompt', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: '   ' });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('prompt must be a non-empty string'));
    }
  });

  it('rejects non-string prompt', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: 123 });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('prompt must be a non-empty string'));
    }
  });

  // ── model validation (runs before network) ──

  it('rejects unknown model with helpful message', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: 'test', model: 'nonexistent-model-xyz' });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('Unknown model'));
      ok(err.message.includes('nonexistent-model-xyz'));
      ok(err.message.includes('deepseek-v4-pro'));
      ok(err.message.includes('deepseek-v4-flash'));
      ok(err.message.includes('deepseek-reasoner'));
      deepStrictEqual(err.status, 400);
    }
  });

  // ── temperature validation (runs before network) ──

  it('rejects temperature below 0', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: 'test', temperature: -0.1 });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('temperature must be between 0 and 2'));
      ok(err.message.includes('-0.1'));
    }
  });

  it('rejects temperature above 2', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: 'test', temperature: 2.1 });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('temperature must be between 0 and 2'));
      ok(err.message.includes('2.1'));
    }
  });

  // ── maxTokens validation (runs before network) ──

  it('rejects maxTokens = 0', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: 'test', maxTokens: 0 });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('maxTokens must be a positive integer'));
      ok(err.message.includes('0'));
    }
  });

  it('rejects negative maxTokens', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: 'test', maxTokens: -5 });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('maxTokens must be a positive integer'));
      ok(err.message.includes('-5'));
    }
  });

  it('rejects non-integer maxTokens', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: 'test', maxTokens: 1.5 });
      ok(false, 'should have thrown');
    } catch (err) {
      ok(err.message.includes('maxTokens must be a positive integer'));
      ok(err.message.includes('1.5'));
    }
  });

  // ── DeepSeekError class behavior ──

  it('DeepSeekError has expected shape (status, name, message)', async () => {
    const mod = await import('../src/client.mjs');
    try {
      await mod.callDeepSeek({ prompt: '' });
      ok(false, 'should have thrown');
    } catch (err) {
      deepStrictEqual(err.name, 'DeepSeekError');
      ok(typeof err.status === 'number');
      ok(typeof err.message === 'string');
      ok(err.message.length > 0);
    }
  });
});
