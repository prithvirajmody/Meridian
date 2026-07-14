import { z } from 'zod';
import type { JsonSchema } from './types.js';

/**
 * Derive the JSON Schema a provider needs for structured output from the
 * caller's zod schema. zod is the single source of truth for shape; providers
 * never see zod, only the JSON Schema this produces.
 */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-07' }) as JsonSchema;
}
