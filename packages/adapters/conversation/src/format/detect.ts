/**
 * The pure format dispatcher (ROADMAP §9c): given already-parsed JSON, decide
 * which per-format parser owns it — or none. Deterministic, finite, bounded
 * (it inspects only the first element of a corpus array and a fixed set of
 * keys, never the whole export), and conservative (a shape lacking a clear
 * signal returns `undefined`, so the caller rejects it with a located error
 * rather than guessing). Strong signals are the structural keys unique to each
 * export — Claude's `chat_messages` array, ChatGPT's `mapping` object; weak
 * signals (identifying key pairs) only break ties when the strong key is
 * absent.
 */
import { asArray, asObject, asNonEmptyString, type ExportFormat, type JsonObject } from './types.js';

/** The first conversation-shaped object to sniff, or undefined. Bounded: only
 * the array's head is examined, never its tail. */
function sample(value: unknown): JsonObject | undefined {
  const arr = asArray(value);
  if (arr !== undefined) return arr.length > 0 ? asObject(arr[0]) : undefined;
  return asObject(value);
}

function looksClaude(o: JsonObject): boolean {
  if (asArray(o.chat_messages) !== undefined) return true;
  return asNonEmptyString(o.uuid) !== undefined && asNonEmptyString(o.name) !== undefined;
}

function looksChatGpt(o: JsonObject): boolean {
  if (asObject(o.mapping) !== undefined) return true;
  return asNonEmptyString(o.title) !== undefined && o.current_node !== undefined;
}

/**
 * Which format, if any, this parsed JSON export is. Claude is tested first;
 * the two strong keys (`chat_messages`, `mapping`) are mutually exclusive in
 * real exports, so order only matters for pathological hand-merged blobs, where
 * "Claude wins" is an arbitrary-but-fixed, documented tie-break.
 */
export function detectFormat(value: unknown): ExportFormat | undefined {
  const head = sample(value);
  if (head === undefined) return undefined;
  if (looksClaude(head)) return 'claude';
  if (looksChatGpt(head)) return 'chatgpt';
  return undefined;
}
