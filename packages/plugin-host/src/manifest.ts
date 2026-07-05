/**
 * Manifest schema-parsing (ARCHITECTURE.md §14.2): an invalid manifest never
 * loads. Structural rules live in zod; cross-field rules (duplicate
 * capabilities) are refinements. Errors are aggregated, not first-only.
 */
import {
  CAPABILITY_KINDS,
  NAMESPACED_KEY_PATTERN,
  type PluginManifest,
} from '@meridian/plugin-api';
import { z } from 'zod';
import { isValidRange } from './semver.js';

const SEMVER = /^\d+\.\d+\.\d+$/;

const namespacedKey = z
  .string()
  .regex(NAMESPACED_KEY_PATTERN, 'must be ns:name with [a-z][a-z0-9-]* parts (ADR-0003)')
  .refine((k) => !k.startsWith('core:'), {
    message: 'the core namespace is the platform’s, not a plugin’s (ADR-0003)',
  });

const manifestSchema = z
  .object({
    name: z.string().min(1).regex(/^\S+$/, 'must not contain whitespace'),
    version: z.string().regex(SEMVER, 'must be exact semver x.y.z'),
    apiVersion: z
      .string()
      .refine(isValidRange, 'must be an exact version or caret range, e.g. "^0.1.0" (ADR-0010)'),
    capabilities: z
      .array(z.object({ kind: z.enum(CAPABILITY_KINDS), id: z.string().min(1) }))
      .min(1),
    kinds: z.array(namespacedKey).optional(),
    attrSchemas: z
      .record(
        namespacedKey,
        z.object({
          type: z.enum([
            'string',
            'number',
            'boolean',
            'null',
            'string-array',
            'number-array',
            'boolean-array',
          ]),
          description: z.string().min(1),
        }),
      )
      .optional(),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const c of m.capabilities) {
      const key = `${c.kind}${c.id}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['capabilities'],
          message: `capability (${c.kind}, "${c.id}") is declared more than once`,
        });
      }
      seen.add(key);
    }
  });

export type ParsedManifest = PluginManifest;

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: ParsedManifest }
  | { readonly ok: false; readonly errors: readonly string[] };

export function parseManifest(input: unknown): ManifestParseResult {
  const r = manifestSchema.safeParse(input);
  if (r.success) return { ok: true, manifest: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
    ),
  };
}
