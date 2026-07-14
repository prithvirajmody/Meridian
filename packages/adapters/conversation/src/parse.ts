/**
 * Text → IR: the one entry the skeleton pass calls (§7.1). It guards the three
 * ways external export data is not ingestible — binary (NUL) bytes, malformed
 * JSON, and JSON no per-format parser recognizes — each as a located
 * {@link ConversationParseError}, then dispatches to the format parser
 * {@link detectFormat} selected. An empty corpus array is benign, not an error:
 * it yields zero conversations (a valid, empty document), so re-exporting an
 * account with no chats still ingests deterministically.
 */
import { ConversationParseError } from './errors.js';
import { parseChatGpt } from './format/chatgpt.js';
import { parseClaude } from './format/claude.js';
import { detectFormat } from './format/detect.js';
import { asArray, containsNul, type RawConversation } from './format/types.js';

export function parseExport(text: string, uri: string): readonly RawConversation[] {
  if (containsNul(text)) {
    throw new ConversationParseError('source is not text (contains a NUL byte)', { uri });
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (e) {
    throw new ConversationParseError(`not valid JSON: ${(e as Error).message}`, { uri });
  }

  const format = detectFormat(value);
  if (format === undefined) {
    const arr = asArray(value);
    if (arr !== undefined && arr.length === 0) return []; // an empty export is legal
    throw new ConversationParseError(
      'unrecognized conversation export (neither Claude nor ChatGPT JSON)',
      { uri },
    );
  }

  return format === 'claude' ? parseClaude(value, uri) : parseChatGpt(value, uri);
}
