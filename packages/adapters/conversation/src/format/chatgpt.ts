/**
 * ChatGPT JSON export → the format-neutral IR (§7.1). A tiny, isolated parser
 * (ROADMAP §9c). Real ChatGPT exports are a bare array of conversation objects
 * (or one such object), each `{ title, create_time, current_node, mapping }`.
 * `mapping` is an id-keyed **tree** of nodes `{ id, message, parent, children }`;
 * a node's `message` is `{ author: { role }, content: { parts | text },
 * create_time }` or null for the synthetic root. Branches (regenerations,
 * edits) mean the tree is not a line, so we linearize it deterministically —
 * pre-order from the root(s), children in source order, a visited guard making
 * the walk finite and bounded even on a malformed cyclic export — and sweep any
 * unreachable message-bearing node afterward so no text is silently dropped.
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

interface MapNode {
  readonly id: string;
  readonly message: JsonObject | undefined;
  readonly parent: string | undefined;
  readonly children: readonly string[];
}

/**
 * Message text as written. ChatGPT text lives in `content.parts` (an array of
 * strings, occasionally multimodal objects with their own `text`); we keep the
 * string parts joined by newlines, then fall back to `content.text`, then to
 * empty. Non-string parts (images, audio) carry no skeleton text.
 */
function chatgptText(message: JsonObject): string {
  const content = asObject(message.content);
  if (content === undefined) return '';
  const parts = asArray(content.parts);
  if (parts !== undefined) {
    const out: string[] = [];
    for (const part of parts) {
      if (typeof part === 'string') out.push(part);
      else {
        const o = asObject(part);
        if (o !== undefined && typeof o.text === 'string') out.push(o.text);
      }
    }
    return out.join('\n');
  }
  return typeof content.text === 'string' ? content.text : '';
}

function readMapNode(id: string, raw: JsonObject): MapNode {
  const message = asObject(raw.message);
  const parent = asNonEmptyString(raw.parent);
  const childArr = asArray(raw.children) ?? [];
  const children: string[] = [];
  for (const c of childArr) {
    const cid = asNonEmptyString(c);
    if (cid !== undefined) children.push(cid);
  }
  return { id, message, parent, children };
}

/**
 * Deterministic thread order over the mapping tree. Roots (no parent, or a
 * parent absent from the mapping) are visited in ascending id order; each
 * node's children in their source array order; a visited set makes the walk
 * terminate on cycles. A final ascending-id sweep appends any message node the
 * traversal could not reach, so a detached branch still contributes its text.
 */
function linearize(mapping: JsonObject): MapNode[] {
  const nodes = new Map<string, MapNode>();
  for (const key of Object.keys(mapping).sort()) {
    const raw = asObject(mapping[key]);
    if (raw !== undefined) nodes.set(key, readMapNode(key, raw));
  }

  const rootIds: string[] = [];
  for (const node of nodes.values()) {
    if (node.parent === undefined || !nodes.has(node.parent)) rootIds.push(node.id);
  }
  rootIds.sort();

  const order: MapNode[] = [];
  const visited = new Set<string>();
  const stack = [...rootIds].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (node === undefined) continue;
    order.push(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i] as string;
      if (!visited.has(child) && nodes.has(child)) stack.push(child);
    }
  }
  // Sweep unreachable message-bearing nodes so no content is lost.
  for (const id of [...nodes.keys()].sort()) {
    if (!visited.has(id)) order.push(nodes.get(id) as MapNode);
  }
  return order;
}

function chatgptConversation(raw: unknown, uri: string, at: string): RawConversation {
  const conv = asObject(raw);
  if (conv === undefined) {
    throw new ConversationParseError('conversation is not a JSON object', {
      uri,
      format: 'chatgpt',
      at,
    });
  }
  const messages: RawMessage[] = [];
  const mapping = asObject(conv.mapping);
  if (mapping !== undefined) {
    for (const node of linearize(mapping)) {
      if (node.message === undefined) continue; // synthetic/structural node
      const text = chatgptText(node.message);
      if (containsNul(text)) {
        throw new ConversationParseError('message text is binary (contains a NUL byte)', {
          uri,
          format: 'chatgpt',
          at: `${at}.mapping[${node.id}]`,
        });
      }
      const author = asObject(node.message.author);
      const sourceId = asNonEmptyString(node.message.id) ?? node.id;
      const createdAt =
        numberToString(node.message.create_time) ?? asNonEmptyString(node.message.create_time);
      messages.push({
        refId: node.id,
        role: normalizeRole(author?.role),
        text,
        sourceId,
        ...(node.parent !== undefined ? { parentRef: node.parent } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
      });
    }
  }
  const sourceId = asNonEmptyString(conv.id) ?? asNonEmptyString(conv.conversation_id);
  const title = asNonEmptyString(conv.title);
  const createdAt = numberToString(conv.create_time) ?? asNonEmptyString(conv.create_time);
  return {
    messages,
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/**
 * Parse a ChatGPT export (already selected by {@link detectFormat}) into the
 * IR. A bare array is a corpus of conversations; a bare object is one.
 */
export function parseChatGpt(value: unknown, uri: string): readonly RawConversation[] {
  const arr = asArray(value);
  if (arr !== undefined) {
    return arr.map((c, i) => chatgptConversation(c, uri, `[${i}]`));
  }
  return [chatgptConversation(value, uri, '(root)')];
}
