/**
 * The one internal representation both export formats normalize to (§7.1:
 * source in, IR out). A `RawConversation` is deliberately format-neutral — the
 * document builder (`../document.ts`) never learns whether a Claude or a
 * ChatGPT parser produced it. Message text is carried verbatim; every optional
 * source datum (ids, timestamps, reply pointers) is preserved when present and
 * simply absent when not, so benign hand edits degrade to deterministic
 * fallbacks rather than errors.
 */

/**
 * One normalized message in thread/chronological order. `refId`/`parentRef`
 * live in a single format's own id space (Claude message uuids; ChatGPT
 * mapping-node ids), so the builder can resolve a reply to its parent *within*
 * a conversation without the two formats' identifiers ever mixing.
 */
export interface RawMessage {
  /** How other messages of this conversation reference me as a parent. */
  readonly refId?: string;
  /** The `refId` of my parent message, as the source recorded it. */
  readonly parentRef?: string;
  /** A stable source identifier for me (→ `conv:source-id`). */
  readonly sourceId?: string;
  /** Normalized role: user | assistant | system | tool | <verbatim token>. */
  readonly role: string;
  /** Verbatim message text (NFC-normalized downstream at the codec gate). */
  readonly text: string;
  /** Source timestamp as written — ISO string or epoch seconds stringified. */
  readonly createdAt?: string;
}

export interface RawConversation {
  /** The conversation's own stable source id (uuid / conversation id). */
  readonly sourceId?: string;
  /** The conversation title/name as written. */
  readonly title?: string;
  /** Source timestamp of the conversation as written. */
  readonly createdAt?: string;
  /** Messages in thread order; empty is legal (→ a session-only document). */
  readonly messages: readonly RawMessage[];
}

export type ExportFormat = 'claude' | 'chatgpt';

// --------------------------------------------------------------- JSON guards

/** A parsed-JSON object (not array, not null). */
export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** A non-empty string, or undefined — the shape every optional field wants. */
export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A finite number rendered as a stable decimal string (timestamps). */
export function numberToString(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

const NUL = String.fromCharCode(0);

/**
 * Does a decoded string contain an actual NUL (U+0000)? A JSON source may
 * legally escape one (a backslash-u-0000 sequence); once decoded it is a
 * control byte that marks the text as binary, and the ingest rejects it
 * (§7.4). Defined here at the IR gate so both format parsers share one
 * definition of "not text".
 */
export function containsNul(text: string): boolean {
  return text.includes(NUL);
}

/**
 * Normalize a source role token to Meridian's canonical set. Claude's `human`
 * and ChatGPT's `user` both mean the person; everything else passes through
 * lowercased so an unusual role is preserved rather than dropped. A missing
 * role deterministically falls back to `user`.
 */
export function normalizeRole(raw: unknown): string {
  const token = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (token) {
    case '':
      return 'user';
    case 'human':
    case 'user':
      return 'user';
    case 'ai':
    case 'model':
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
    case 'function':
      return 'tool';
    default:
      return token;
  }
}
