/**
 * @meridian/adapter-argument — the enrichment-reliant AI-native domain
 * adapter (ROADMAP Phase 9). This barrel exports the deterministic skeleton
 * half only (ADR-0034): the plugin, its manifest, the segmentation, and the
 * document builder. AI enrichment (claims/premises/objections and the typed
 * argumentative relations) is not here — it lives in the composition root
 * and reaches the graph as proposals.
 */
export { argumentPlugin, manifest } from './plugin.js';
export { buildDocument, DOMAIN } from './document.js';
export { containsNul, parseEssay } from './parse.js';
export type { ParsedEssay, RawParagraph, RawSentence } from './parse.js';
export { ArgumentParseError } from './errors.js';
export type { ArgumentErrorLocation } from './errors.js';
