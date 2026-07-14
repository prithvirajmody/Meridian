/**
 * Claude JSON export → the format-neutral IR (§7.1). A tiny, isolated parser
 * (ROADMAP §9c): it knows one wire shape and nothing about graphs. Real Claude
 * exports are either a bare array of conversation objects or a single such
 * object, each with `uuid`/`name`/`chat_messages`; a message carries `sender`,
 * a `text` string and/or a `content` block array, `uuid`, an optional
 * `parent_message_uuid`, and `created_at`. Every optional datum degrades to a
 * deterministic absence; only a shape that cannot be a message at all is a
 * located rejection (ADR-0009 — external data fails honestly, never silently).
 */
import { ConversationParseError } from '../errors.js';
import {
  asArray,
  asNonEmptyString,
  asObject,
  containsNul,
  type JsonObject,
  normalizeRole,
  numberToString,
  type RawConversation,
  type RawMessage,
} from './types.js';

/** An actual NUL byte inside a decoded string is binary, not text (§7.4). */
function rejectBinary(text: string, uri: string, at: string): void {
  if (containsNul(text)) {
    throw new ConversationParseError('message text is binary (contains a NUL byte)', {
      uri,
      format: 'claude',
      at,
    });
  }
}

/**
 * Message text as written. Claude puts the body in a `content` block array
 * (`{ type: 'text', text }`) on newer exports and/or a flat `text` string on
 * older ones; we concatenate every text block, then fall back to `text`, then
 * to empty. Non-text blocks (tool use, images) contribute no text at the
 * skeleton floor — enrichment, not the skeleton, interprets them.
 */
function claudeText(msg: JsonObject): string {
  const blocks = asArray(msg.content);
  if (blocks !== undefined) {
    let out = '';
    for (const block of blocks) {
      const o = asObject(block);
      if (o !== undefined && typeof o.text === 'string') out += o.text;
    }
    if (out.length > 0) return out;
  }
  return typeof msg.text === 'string' ? msg.text : '';
}

function claudeMessage(raw: unknown, uri: string, at: string): RawMessage {
  const msg = asObject(raw);
  if (msg === undefined) {
    throw new ConversationParseError('chat message is not a JSON object', {
      uri,
      format: 'claude',
      at,
    });
  }
  const text = claudeText(msg);
  rejectBinary(text, uri, at);
  const refId = asNonEmptyString(msg.uuid);
  const parentRef = asNonEmptyString(msg.parent_message_uuid);
  const createdAt = asNonEmptyString(msg.created_at) ?? numberToString(msg.created_at);
  return {
    role: normalizeRole(msg.sender),
    text,
    ...(refId !== undefined ? { refId, sourceId: refId } : {}),
    ...(parentRef !== undefined ? { parentRef } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function claudeConversation(raw: unknown, uri: string, at: string): RawConversation {
  const conv = asObject(raw);
  if (conv === undefined) {
    throw new ConversationParseError('conversation is not a JSON object', {
      uri,
      format: 'claude',
      at,
    });
  }
  const rawMessages = asArray(conv.chat_messages) ?? [];
  const messages = rawMessages.map((m, i) => claudeMessage(m, uri, `${at}.chat_messages[${i}]`));
  const sourceId = asNonEmptyString(conv.uuid);
  const title = asNonEmptyString(conv.name);
  const createdAt = asNonEmptyString(conv.created_at) ?? numberToString(conv.created_at);
  return {
    messages,
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/**
 * Parse a Claude export (already selected by {@link detectFormat}) into the IR.
 * A bare array is a corpus of conversations; a bare object is one conversation.
 */
export function parseClaude(value: unknown, uri: string): readonly RawConversation[] {
  const arr = asArray(value);
  if (arr !== undefined) {
    return arr.map((c, i) => claudeConversation(c, uri, `[${i}]`));
  }
  return [claudeConversation(value, uri, '(root)')];
}
