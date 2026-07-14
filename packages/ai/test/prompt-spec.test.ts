import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from '../src/schema.js';
import { summarySchema, summarySpec } from './helpers.js';

describe('PromptSpec', () => {
  it('renders deterministically as a pure function of input', () => {
    const a = summarySpec.render({ nodeId: 'n1', text: 'hello' });
    const b = summarySpec.render({ nodeId: 'n1', text: 'hello' });
    expect(a).toEqual(b);
    expect(a.system).toBe('You summarize graph nodes.');
    expect(a.messages[0]?.content).toContain('n1');
  });

  it('carries an explicit version and task class', () => {
    expect(summarySpec.version).toBe('1');
    expect(summarySpec.taskClass).toBe('summarization');
  });
});

describe('zodToJsonSchema', () => {
  it('produces an object JSON Schema with the declared properties', () => {
    const schema = zodToJsonSchema(summarySchema);
    expect(schema['type']).toBe('object');
    expect(Object.keys(schema['properties'] as Record<string, unknown>)).toEqual(['name', 'summary']);
  });
});
