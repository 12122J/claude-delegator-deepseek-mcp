// Tests for tools module — tool schema validation, handler structure
// Requires: node --test test/tools.test.mjs

import { describe, it, before } from 'node:test';
import { deepStrictEqual, ok, match, throws } from 'node:assert/strict';

import { TOOLS, handleToolCall } from '../src/tools.mjs';
import { MODELS, getDefaultModel } from '../src/models.mjs';

describe('Tools module (tools.mjs)', () => {

  describe('TOOLS array', () => {
    it('is a non-empty array', () => {
      ok(Array.isArray(TOOLS));
      ok(TOOLS.length > 0);
    });

    it('contains deepseek tool', () => {
      const ds = TOOLS.find(t => t.name === 'deepseek');
      ok(ds, 'deepseek tool should exist');
    });

    it('contains deepseek_models tool', () => {
      const dm = TOOLS.find(t => t.name === 'deepseek_models');
      ok(dm, 'deepseek_models tool should exist');
    });

    it('each tool has name, description, inputSchema', () => {
      for (const tool of TOOLS) {
        ok(typeof tool.name === 'string' && tool.name.length > 0,
          `Tool should have a name`);
        ok(typeof tool.description === 'string' && tool.description.length > 0,
          `Tool '${tool.name}' should have a description`);
        ok(tool.inputSchema && typeof tool.inputSchema === 'object',
          `Tool '${tool.name}' should have an inputSchema`);
      }
    });
  });

  describe('deepseek tool schema', () => {
    let schema;

    before(() => {
      schema = TOOLS.find(t => t.name === 'deepseek');
    });

    it('has inputSchema with type object', () => {
      deepStrictEqual(schema.inputSchema.type, 'object');
    });

    it('has prompt as required', () => {
      ok(Array.isArray(schema.inputSchema.required));
      ok(schema.inputSchema.required.includes('prompt'));
    });

    it('has all expected properties', () => {
      const props = schema.inputSchema.properties;
      ok(props.prompt, 'should have prompt property');
      ok(props.system, 'should have system property');
      ok(props.model, 'should have model property');
      ok(props.temperature, 'should have temperature property');
      ok(props.maxTokens, 'should have maxTokens property');
      ok(props.stream, 'should have stream property');
      ok(props.files, 'should have files property');
    });

    it('prompt property type is string', () => {
      deepStrictEqual(schema.inputSchema.properties.prompt.type, 'string');
    });

    it('model property has default value', () => {
      ok(schema.inputSchema.properties.model.default);
      deepStrictEqual(schema.inputSchema.properties.model.default, getDefaultModel());
    });

    it('temperature property has default and range info', () => {
      const temp = schema.inputSchema.properties.temperature;
      deepStrictEqual(temp.type, 'number');
      deepStrictEqual(temp.default, 0.3);
      ok(temp.description.toLowerCase().includes('0'));
      ok(temp.description.toLowerCase().includes('2'));
    });

    it('maxTokens property type is number', () => {
      deepStrictEqual(schema.inputSchema.properties.maxTokens.type, 'number');
    });

    it('stream property type is boolean with default false', () => {
      const stream = schema.inputSchema.properties.stream;
      deepStrictEqual(stream.type, 'boolean');
      deepStrictEqual(stream.default, false);
    });

    it('files property is array of strings', () => {
      const files = schema.inputSchema.properties.files;
      deepStrictEqual(files.type, 'array');
      deepStrictEqual(files.items.type, 'string');
    });

    it('only prompt is required (not optional params)', () => {
      const required = schema.inputSchema.required;
      ok(required.includes('prompt'));
      ok(!required.includes('system'));
      ok(!required.includes('model'));
      ok(!required.includes('temperature'));
      ok(!required.includes('maxTokens'));
    });
  });

  describe('deepseek_models tool schema', () => {
    let schema;

    before(() => {
      schema = TOOLS.find(t => t.name === 'deepseek_models');
    });

    it('has inputSchema with type object', () => {
      deepStrictEqual(schema.inputSchema.type, 'object');
    });

    it('has no required fields', () => {
      ok(!schema.inputSchema.required || schema.inputSchema.required.length === 0);
    });

    it('has empty properties or no properties', () => {
      const props = schema.inputSchema.properties;
      ok(!props || Object.keys(props).length === 0);
    });
  });

  describe('handleToolCall', () => {
    it('rejects unknown tool name', async () => {
      try {
        await handleToolCall('nonexistent_tool', {});
        ok(false, 'should have thrown');
      } catch (err) {
        ok(err.message.includes('Unknown tool'));
        ok(err.message.includes('nonexistent_tool'));
      }
    });

    it('rejects unknown tool with empty args', async () => {
      try {
        await handleToolCall('', {});
        ok(false, 'should have thrown');
      } catch (err) {
        ok(err.message.includes('Unknown tool'));
      }
    });

    it('deepseek_models returns content with model info (no API key needed)', async () => {
      // deepseek_models does NOT require an API key — it just lists models
      const result = await handleToolCall('deepseek_models', {});
      ok(result.content, 'should have content');
      ok(Array.isArray(result.content));
      ok(result.content.length > 0);
      ok(result.content[0].type === 'text');
    });

    it('deepseek_models content includes model names', async () => {
      const result = await handleToolCall('deepseek_models', {});
      const text = result.content[0].text;
      ok(text.includes('deepseek-v4-pro'), 'should list v4-pro');
      ok(text.includes('deepseek-v4-flash'), 'should list v4-flash');
    });

    it('deepseek_models returns text type content items', async () => {
      const result = await handleToolCall('deepseek_models', {});
      for (const item of result.content) {
        deepStrictEqual(item.type, 'text');
        ok(typeof item.text === 'string');
      }
    });
  });
});
