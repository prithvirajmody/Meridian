/**
 * @meridian/adapter-conversation — the reference AI-native domain adapter
 * (ROADMAP Phase 9). This barrel exports the deterministic skeleton half only
 * (ADR-0034): the plugin, its manifest, the document builder, the per-format
 * parsers, and the located error type. AI enrichment (topics/claims) is not
 * here — it lives in the composition root and reaches the graph as proposals.
 */
export { conversationPlugin, manifest } from './plugin.js';
export { buildDocument, DOMAIN } from './document.js';
export { groupExchanges } from './exchanges.js';
export { parseExport } from './parse.js';
export { detectFormat } from './format/detect.js';
export { parseClaude } from './format/claude.js';
export { parseChatGpt } from './format/chatgpt.js';
export { ConversationParseError } from './errors.js';
export type { ConversationErrorLocation } from './errors.js';
export type { ExportFormat, RawConversation, RawMessage } from './format/types.js';
