// Tests for pricing module — cost calculations, formatting, savings
// Requires: node --test test/pricing.test.mjs

import { describe, it, beforeEach } from 'node:test';
import { deepStrictEqual, ok, match } from 'node:assert/strict';

// Import module under test
import { PRICING, CLAUDE_PRICING, calculateCost, formatCost, formatSavings, buildFooter } from '../src/pricing.mjs';

describe('Pricing module (pricing.mjs)', () => {

  describe('PRICING registry', () => {
    it('has entries for all supported models', () => {
      ok(PRICING['deepseek-v4-pro']);
      ok(PRICING['deepseek-v4-flash']);
      ok(PRICING['deepseek-reasoner']);
    });

    it('each pricing entry has input and output rates', () => {
      for (const [key, val] of Object.entries(PRICING)) {
        ok(typeof val.input === 'number' && val.input > 0,
          `${key} should have positive input price`);
        ok(typeof val.output === 'number' && val.output > 0,
          `${key} should have positive output price`);
      }
    });

    it('pro is more expensive than flash', () => {
      ok(PRICING['deepseek-v4-pro'].input > PRICING['deepseek-v4-flash'].input,
        'pro input should cost more than flash input');
      ok(PRICING['deepseek-v4-pro'].output > PRICING['deepseek-v4-flash'].output,
        'pro output should cost more than flash output');
    });

    it('reasoner has highest output price (specialized)', () => {
      ok(PRICING['deepseek-reasoner'].output > PRICING['deepseek-v4-pro'].output,
        'reasoner output should cost more than pro');
    });
  });

  describe('CLAUDE_PRICING baseline', () => {
    it('has input and output rates', () => {
      ok(typeof CLAUDE_PRICING.input === 'number');
      ok(typeof CLAUDE_PRICING.output === 'number');
    });

    it('Claude is more expensive than any DeepSeek model', () => {
      for (const [key, val] of Object.entries(PRICING)) {
        ok(CLAUDE_PRICING.input > val.input,
          `Claude input should cost more than ${key} input`);
        ok(CLAUDE_PRICING.output > val.output,
          `Claude output should cost more than ${key} output`);
      }
    });
  });

  describe('calculateCost', () => {
    it('returns 0 for zero tokens', () => {
      deepStrictEqual(calculateCost(0, 0, { input: 0.435, output: 0.87 }), 0);
    });

    it('calculates cost correctly for known values', () => {
      // 1M input tokens at $0.435/M = $0.435
      const cost = calculateCost(1_000_000, 0, { input: 0.435, output: 0.87 });
      deepStrictEqual(cost, 0.435);
    });

    it('calculates output cost correctly', () => {
      // 500K output tokens at $0.87/M = $0.435
      const cost = calculateCost(0, 500_000, { input: 0.435, output: 0.87 });
      deepStrictEqual(cost, 0.435);
    });

    it('handles combined input + output', () => {
      // 1M input ($0.435) + 1M output ($0.87) = $1.305
      const cost = calculateCost(1_000_000, 1_000_000, { input: 0.435, output: 0.87 });
      deepStrictEqual(cost, 1.305);
    });

    it('handles fractional token counts', () => {
      // 1000 tokens at $0.435/M = $0.000435
      const cost = calculateCost(1000, 0, { input: 0.435, output: 0.87 });
      ok(cost > 0 && cost < 0.01);
      // 1000 * 0.435 / 1_000_000 = 0.000435
      deepStrictEqual(cost, 0.000435);
    });

    it('is linear — doubling tokens doubles cost', () => {
      const cost1 = calculateCost(500_000, 500_000, { input: 0.435, output: 0.87 });
      const cost2 = calculateCost(1_000_000, 1_000_000, { input: 0.435, output: 0.87 });
      deepStrictEqual(cost2, cost1 * 2);
    });

    it('handles large token counts without overflow', () => {
      const cost = calculateCost(10_000_000, 10_000_000, { input: 0.435, output: 0.87 });
      ok(Number.isFinite(cost));
      ok(cost > 0);
    });

    it('pricing is symmetric — switching input/output pricing swaps costs', () => {
      const pricing = { input: 0.5, output: 1.0 };
      const costAB = calculateCost(1_000_000, 500_000, pricing);
      const costBA = calculateCost(500_000, 1_000_000, pricing);
      // A=1M*0.5 + 500K*1.0 = 0.5 + 0.5 = 1.0
      // B=500K*0.5 + 1M*1.0 = 0.25 + 1.0 = 1.25
      ok(costAB !== costBA, 'swapping input/output tokens changes cost');
    });
  });

  describe('formatCost', () => {
    it('formats amounts < $0.01 with 4 decimal places', () => {
      const result = formatCost(0.000435);
      match(result, /^\$0\.000[4-5]/);
      ok(result.includes('.'));
    });

    it('formats amounts < $1 with 3 decimal places', () => {
      deepStrictEqual(formatCost(0.435), '$0.435');
    });

    it('formats amounts >= $1 with 2 decimal places', () => {
      deepStrictEqual(formatCost(1.50), '$1.50');
    });

    it('formats zero cost', () => {
      deepStrictEqual(formatCost(0), '$0.0000');
    });

    it('formats large amounts', () => {
      const result = formatCost(99.99);
      deepStrictEqual(result, '$99.99');
    });

    it('all results start with $', () => {
      const costs = [0.0001, 0.5, 5.0, 100];
      for (const c of costs) {
        ok(formatCost(c).startsWith('$'));
      }
    });
  });

  describe('formatSavings', () => {
    it('calculates savings and percentage', () => {
      const { saved, pct } = formatSavings(1.305, 45.0);
      ok(saved > 0);
      ok(pct > 0);
      // saved = 45.0 - 1.305 = 43.695
      deepStrictEqual(saved, 43.695);
    });

    it('returns 0% when costs are equal', () => {
      const { saved, pct } = formatSavings(5.0, 5.0);
      deepStrictEqual(saved, 0);
      deepStrictEqual(pct, 0);
    });

    it('returns 100% when DeepSeek is free', () => {
      const { saved, pct } = formatSavings(0, 10.0);
      deepStrictEqual(saved, 10.0);
      deepStrictEqual(pct, 100);
    });

    it('handles typical savings scenario', () => {
      // 1M prompt + 500K completion
      const dsCost = calculateCost(1_000_000, 500_000, PRICING['deepseek-v4-pro']);
      const claudeCost = calculateCost(1_000_000, 500_000, CLAUDE_PRICING);
      const { saved, pct } = formatSavings(dsCost, claudeCost);
      ok(saved > 0, 'should have savings');
      ok(pct > 0, 'should have positive percentage');
      ok(pct <= 100, 'percentage should not exceed 100');
    });
  });

  describe('buildFooter', () => {
    const sampleResult = {
      usage: {
        promptTokens: 100000,
        completionTokens: 50000,
        totalTokens: 150000,
      },
    };

    it('returns empty string when usage is null', () => {
      deepStrictEqual(buildFooter({}, 'deepseek-v4-pro'), '');
    });

    it('returns empty string when usage is undefined', () => {
      deepStrictEqual(buildFooter({ usage: null }, 'deepseek-v4-pro'), '');
    });

    it('returns cost footer for deepseek-v4-pro', () => {
      const footer = buildFooter(sampleResult, 'deepseek-v4-pro');
      ok(typeof footer === 'string');
      ok(footer.includes('deepseek'));
      ok(footer.includes('claude sonnet 4'));
      ok(footer.includes('saved'));
      ok(footer.includes('tokens'));
      ok(footer.includes('150,000'), 'should format total tokens');
    });

    it('returns cost footer for deepseek-v4-flash', () => {
      const footer = buildFooter(sampleResult, 'deepseek-v4-flash');
      ok(typeof footer === 'string');
      ok(footer.includes('flash'));
    });

    it('falls back to v4-pro pricing for unknown model', () => {
      const footer = buildFooter(sampleResult, 'unknown-model');
      ok(typeof footer === 'string');
      ok(footer.length > 0);
    });

    it('includes token breakdown', () => {
      const footer = buildFooter(sampleResult, 'deepseek-v4-pro');
      ok(footer.includes('100,000'), 'should include prompt tokens');
      ok(footer.includes('50,000'), 'should include completion tokens');
    });

    it('footer is non-empty and well-formed', () => {
      const footer = buildFooter(sampleResult, 'deepseek-v4-pro');
      ok(footer.trim().length > 0);
      ok(footer.includes('───'));
    });
  });
});
