/**
 * A plugin manifest's declared vocabulary, shaped as the IR gate consumes it
 * (U8). Its own module so both conformance suites — the parser suite
 * ({@link ./index.js}) and the incremental suite ({@link ./incremental.js}) —
 * share it without an import cycle.
 */
import type { VocabularyRegistry } from '@meridian/graph-core';
import type { PluginManifest } from '@meridian/plugin-api';

export function vocabularyOf(manifest: PluginManifest): VocabularyRegistry {
  return {
    attrs: new Map(
      Object.entries(manifest.attrSchemas ?? {}).map(([key, schema]) => [key, schema.type]),
    ),
    kinds: new Set(manifest.kinds ?? []),
  };
}
