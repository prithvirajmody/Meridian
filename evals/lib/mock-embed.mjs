/**
 * The offline mock embedding provider for the eval harness (Phase 8F).
 *
 * A real embedding model maps text → a vector where semantically similar texts
 * land close together. In the no-key/offline path we stand in a *deterministic*
 * embedder that reproduces that essential property for the soup fixture: it
 * reads the stable `[t{topic}]` token, places the node near that topic's fixed
 * centroid, and adds a small deterministic per-text jitter so points are
 * distinct but separable. It is a pure function of the input strings — exactly
 * the contract `session.embed` passes to a provider — so replay is byte-stable.
 *
 * This proves the clustering *plumbing and determinism* offline. Clustering
 * quality against a REAL embedder is the live/nightly recorded path
 * (see evals/README.md); the mock never claims to measure model quality.
 */
import { MockProvider } from '../../packages/ai/dist/index.js';
import { mulberry32, hashSeed } from './prng.mjs';

const DIM = 16;
const TOPIC_SLOTS = DIM; // one basis direction per topic slot, wraps if topics > DIM

/** Deterministic unit-ish vector for a text: topic centroid + small jitter. */
function embedText(text) {
  const vec = new Array(DIM).fill(0);
  const match = /\[t(\d+)\]/.exec(text);
  const topic = match ? Number(match[1]) % TOPIC_SLOTS : 0;
  vec[topic] = 1; // dominant topic direction
  // Deterministic jitter keyed by the full text so nodes are distinct.
  const rng = mulberry32(hashSeed(text));
  for (let d = 0; d < DIM; d++) vec[d] += (rng() - 0.5) * 0.12;
  return vec;
}

/**
 * A MockProvider that embeds only (no completion). `onEmbed` must return one
 * vector per input string, in input order (the gateway sorts by index).
 */
export function mockEmbedProvider(id = 'mock-embed', model = 'mock-embed-1') {
  return new MockProvider({
    id,
    capabilities: {
      completion: false,
      embedding: true,
      models: { [model]: { inputPerMTok: 0.02, outputPerMTok: 0 } },
    },
    onEmbed: (request) => request.input.map((text) => embedText(text)),
  });
}

export const MOCK_EMBED_MODEL = 'mock-embed-1';
export const MOCK_EMBED_PROVIDER_ID = 'mock-embed';
