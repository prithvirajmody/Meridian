/**
 * `classify` is the switchboard that makes "valid partial state" structural
 * (ADR-0032): budget → stop, refusal/schema-invalid → degrade this unit,
 * everything else → propagate (a real fault must not be silently floored).
 */
import { AiError } from '@meridian/ai';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/disposition.js';

describe('classify', () => {
  it('maps a budget trip to stop-budget', () => {
    expect(classify(new AiError('budget_exceeded', 'over'))).toBe('stop-budget');
  });

  it.each(['refusal', 'schema_invalid'] as const)('maps %s to degrade-unit', (kind) => {
    expect(classify(new AiError(kind, 'bad'))).toBe('degrade-unit');
  });

  it.each(['replay_miss', 'cancelled', 'config', 'provider_fatal', 'unsupported'] as const)(
    'propagates %s',
    (kind) => {
      expect(classify(new AiError(kind, 'x'))).toBe('propagate');
    },
  );

  it('propagates a non-AiError', () => {
    expect(classify(new Error('boom'))).toBe('propagate');
    expect(classify('not even an error')).toBe('propagate');
  });
});
