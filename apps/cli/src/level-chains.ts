/**
 * Manifest-declared semantic-zoom chains for the CLI composition root
 * (ADR-0047 §6): a domain that declares `levelChain` in its plugin manifest
 * gets its named ladder (`org → team → role …`) instead of the synthesized
 * `level-0…N`. The core stays domain-blind — `buildLevelChain` just receives
 * the spec the selected domain declared; this lookup is composition-root
 * wiring, exactly like the temporal hints (ADR-0037). The code adapter is
 * absent because constructing it needs a parse worker and it declares no
 * chain; scanning the static Tier-0 manifests keeps `cut`/`layout` free of
 * worker lifecycle.
 */
import { maxDepth } from '@meridian/abstraction';
import { argumentPlugin } from '@meridian/adapter-argument';
import { conversationPlugin } from '@meridian/adapter-conversation';
import { markdownPlugin } from '@meridian/adapter-markdown';
import { orgPlugin } from '@meridian/adapter-org';
import type { GraphSpace } from '@meridian/graph-core';
import type { LevelChainSpec } from '@meridian/plugin-api';

const MANIFESTS = [
  markdownPlugin.manifest,
  conversationPlugin.manifest,
  argumentPlugin.manifest,
  orgPlugin.manifest,
];

/** The level-chain spec declared by the plugin claiming the space's root
 * domain — but only while the space still fits inside it. A document that has
 * outgrown its declared skeleton (AI enrichment inserts levels, e.g. the
 * conversation topic pass) falls back to the synthesized depth chain rather
 * than letting a stale declaration hide its deepest level. */
export function chainSpecFor(space: GraphSpace): LevelChainSpec | undefined {
  const rootId = space.roots[0];
  const domain = rootId === undefined ? undefined : space.graphs.get(rootId)?.meta.domain;
  if (domain === undefined) return undefined;
  for (const manifest of MANIFESTS) {
    const claims = manifest.capabilities.some(
      (capability) => capability.kind === 'domain-parser' && capability.id === domain,
    );
    if (claims && manifest.levelChain !== undefined) {
      return maxDepth(space) + 1 <= manifest.levelChain.levels.length
        ? manifest.levelChain
        : undefined;
    }
  }
  return undefined;
}
