// Tests for models module — model registry completeness, consistency
// Requires: node --test test/models.test.mjs

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, match } from 'node:assert/strict';

import { MODELS, getDefaultModel, listModels } from '../src/models.mjs';
import { PRICING } from '../src/pricing.mjs';

describe('Models module (models.mjs)', () => {

  describe('MODELS registry', () => {
    it('contains all expected models', () => {
      ok(MODELS['deepseek-v4-pro']);
      ok(MODELS['deepseek-v4-flash']);
      ok(MODELS['deepseek-reasoner']);
    });

    it('each model has all required fields', () => {
      const requiredFields = ['name', 'contextWindow', 'maxOutputTokens', 'thinking', 'description'];
      for (const [id, model] of Object.entries(MODELS)) {
        for (const field of requiredFields) {
          ok(model[field] !== undefined,
            `${id} should have field '${field}'`);
        }
      }
    });

    it('contextWindow is a positive integer', () => {
      for (const [id, model] of Object.entries(MODELS)) {
        ok(Number.isInteger(model.contextWindow) && model.contextWindow > 0,
          `${id} contextWindow should be positive integer, got ${model.contextWindow}`);
      }
    });

    it('maxOutputTokens is a positive integer', () => {
      for (const [id, model] of Object.entries(MODELS)) {
        ok(Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0,
          `${id} maxOutputTokens should be positive integer, got ${model.maxOutputTokens}`);
      }
    });

    it('maxOutputTokens <= contextWindow', () => {
      for (const [id, model] of Object.entries(MODELS)) {
        ok(model.maxOutputTokens <= model.contextWindow,
          `${id} maxOutputTokens (${model.maxOutputTokens}) should be <= contextWindow (${model.contextWindow})`);
      }
    });

    it('thinking is a boolean', () => {
      for (const [id, model] of Object.entries(MODELS)) {
        ok(typeof model.thinking === 'boolean',
          `${id} thinking should be boolean`);
      }
    });

    it('name and description are non-empty strings', () => {
      for (const [id, model] of Object.entries(MODELS)) {
        ok(typeof model.name === 'string' && model.name.length > 0,
          `${id} name should be non-empty string`);
        ok(typeof model.description === 'string' && model.description.length > 0,
          `${id} description should be non-empty string`);
      }
    });

    it('every model in MODELS has a corresponding PRICING entry', () => {
      for (const id of Object.keys(MODELS)) {
        ok(PRICING[id], `Model '${id}' should have a pricing entry in PRICING`);
      }
    });
  });

  describe('getDefaultModel', () => {
    it('returns a valid model id', () => {
      const defaultModel = getDefaultModel();
      ok(MODELS[defaultModel], `Default model '${defaultModel}' should exist in MODELS`);
    });

    it('returns deepseek-v4-pro', () => {
      deepStrictEqual(getDefaultModel(), 'deepseek-v4-pro');
    });

    it('is consistent across calls', () => {
      deepStrictEqual(getDefaultModel(), getDefaultModel());
    });
  });

  describe('listModels', () => {
    it('returns an array with all models', () => {
      const models = listModels();
      ok(Array.isArray(models));
      deepStrictEqual(models.length, Object.keys(MODELS).length);
    });

    it('each listed model has id and name', () => {
      const models = listModels();
      for (const m of models) {
        ok(typeof m.id === 'string');
        ok(typeof m.name === 'string');
        ok(MODELS[m.id], `listed model id '${m.id}' should exist in MODELS`);
      }
    });

    it('includes contextWindow, maxOutputTokens, thinking, description', () => {
      const models = listModels();
      for (const m of models) {
        ok(Number.isInteger(m.contextWindow), `${m.id} should have contextWindow`);
        ok(Number.isInteger(m.maxOutputTokens), `${m.id} should have maxOutputTokens`);
        ok(typeof m.thinking === 'boolean', `${m.id} should have thinking`);
        ok(typeof m.description === 'string', `${m.id} should have description`);
      }
    });

    it('returns models in stable order', () => {
      const a = listModels();
      const b = listModels();
      deepStrictEqual(a.map(m => m.id), b.map(m => m.id));
    });

    it('contains deepseek-v4-pro first (as default model)', () => {
      const models = listModels();
      deepStrictEqual(models[0].id, 'deepseek-v4-pro');
    });
  });

  describe('MODELS ↔ PRICING sync check', () => {
    it('every PRICING key exists in MODELS', () => {
      for (const key of Object.keys(PRICING)) {
        ok(MODELS[key],
          `PRICING key '${key}' should have a corresponding MODELS entry`);
      }
    });

    it('MODELS and PRICING have the same keys', () => {
      const modelKeys = Object.keys(MODELS).sort();
      const pricingKeys = Object.keys(PRICING).sort();
      deepStrictEqual(modelKeys, pricingKeys,
        'MODELS and PRICING should have identical keys');
    });
  });
});
