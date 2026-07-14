/**
 * Per-format parser law (ROADMAP §9c; ADR-0034 — tiny, isolated parsers).
 * Format detection & isolation, object/array support, role normalization,
 * optional-field fallback, deterministic branch linearization, verbatim text,
 * located rejections (malformed JSON, unrecognized JSON, raw and decoded NUL),
 * and reuse after a rejection. Everything here is pure and offline.
 *
 * NUL construction note: to keep this source clean 7-bit ASCII, a real NUL is
 * built with `String.fromCharCode(0)`, and the JSON escape that decodes to a
 * NUL is assembled at runtime from a backslash char plus the letters "u0000"
 * (`BACKSLASH_U0000`), so no NUL-producing escape ever appears in this file.
 */
import { describe, expect, it } from 'vitest';
import {
  ConversationParseError,
  detectFormat,
  parseChatGpt,
  parseClaude,
  parseExport,
} from '../src/index.js';
import { containsNul, normalizeRole } from '../src/format/types.js';

const URI = 'export.json';
const NUL = String.fromCharCode(0);
/** The six characters backslash,u,0,0,0,0 — the JSON escape for U+0000. */
const BACKSLASH_U0000 = '\\' + 'u0000';

describe('detectFormat — isolation, object & array, conservative', () => {
  it('recognizes a Claude object and a Claude corpus array by chat_messages', () => {
    expect(detectFormat({ chat_messages: [] })).toBe('claude');
    expect(detectFormat([{ chat_messages: [] }])).toBe('claude');
  });

  it('recognizes a ChatGPT object and array by mapping', () => {
    expect(detectFormat({ mapping: {} })).toBe('chatgpt');
    expect(detectFormat([{ mapping: {} }])).toBe('chatgpt');
  });

  it('falls back to weak identifying signals only when the strong key is absent', () => {
    expect(detectFormat({ uuid: 'c1', name: 'Titled' })).toBe('claude');
    expect(detectFormat({ title: 'T', current_node: 'n0' })).toBe('chatgpt');
  });

  it('is conservative: arbitrary / signal-free JSON detects as no format', () => {
    expect(detectFormat({ hello: 'world' })).toBeUndefined();
    expect(detectFormat(42)).toBeUndefined();
    expect(detectFormat('a string')).toBeUndefined();
    expect(detectFormat(null)).toBeUndefined();
    expect(detectFormat([])).toBeUndefined(); // empty corpus: no head to sniff
  });

  it('only inspects the array head, not the tail (bounded)', () => {
    expect(detectFormat([{ mapping: {} }, { chat_messages: [] }])).toBe('chatgpt');
  });

  it('breaks a pathological hand-merged tie deterministically (Claude wins)', () => {
    expect(detectFormat({ chat_messages: [], mapping: {} })).toBe('claude');
  });
});

describe('format isolation — each parser reads only its own vocabulary', () => {
  it('the Claude parser ignores a ChatGPT-shaped blob rather than crashing', () => {
    const convs = parseClaude({ mapping: { n: {} }, title: 'T' }, URI);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.messages).toEqual([]);
  });

  it('the ChatGPT parser ignores a Claude-shaped blob rather than crashing', () => {
    const convs = parseChatGpt({ chat_messages: [{ sender: 'human', text: 'hi' }] }, URI);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.messages).toEqual([]);
  });
});

describe('normalizeRole — canonical role set with verbatim passthrough', () => {
  it('maps person, assistant, system, and tool synonyms', () => {
    expect(normalizeRole('human')).toBe('user');
    expect(normalizeRole('user')).toBe('user');
    expect(normalizeRole('assistant')).toBe('assistant');
    expect(normalizeRole('ai')).toBe('assistant');
    expect(normalizeRole('model')).toBe('assistant');
    expect(normalizeRole('system')).toBe('system');
    expect(normalizeRole('tool')).toBe('tool');
    expect(normalizeRole('function')).toBe('tool');
  });

  it('falls back to user for missing / non-string roles', () => {
    expect(normalizeRole(undefined)).toBe('user');
    expect(normalizeRole('')).toBe('user');
    expect(normalizeRole(123)).toBe('user');
  });

  it('preserves an unusual role verbatim, lowercased and trimmed', () => {
    expect(normalizeRole('  Developer ')).toBe('developer');
  });
});

describe('Claude parser — text extraction & optional-field fallback', () => {
  it('concatenates content text blocks, else falls back to a flat text string', () => {
    const [conv] = parseClaude(
      {
        chat_messages: [
          { sender: 'assistant', content: [{ type: 'text', text: 'Hello, ' }, { type: 'text', text: 'world' }] },
          { sender: 'assistant', content: [{ type: 'tool_use', name: 'x' }], text: 'fallback body' },
          { sender: 'human', text: 'plain' },
        ],
      },
      URI,
    );
    expect(conv!.messages.map((m) => m.text)).toEqual(['Hello, world', 'fallback body', 'plain']);
  });

  it('carries source ids, parent pointers, and timestamps when present', () => {
    const [conv] = parseClaude(
      {
        uuid: 'conv-x',
        name: 'Titled',
        created_at: '2026-01-01T00:00:00Z',
        chat_messages: [
          { uuid: 'a', sender: 'human', text: 'q', created_at: 1735689600 },
          { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', text: 'r' },
        ],
      },
      URI,
    );
    expect(conv!.sourceId).toBe('conv-x');
    expect(conv!.title).toBe('Titled');
    expect(conv!.createdAt).toBe('2026-01-01T00:00:00Z');
    const [first, second] = conv!.messages;
    expect(first).toMatchObject({ refId: 'a', sourceId: 'a', role: 'user', createdAt: '1735689600' });
    expect(second).toMatchObject({ refId: 'b', parentRef: 'a', role: 'assistant' });
  });

  it('degrades missing optional fields to deterministic absence, not error', () => {
    const [conv] = parseClaude({ chat_messages: [{ sender: 'human', text: 'x' }] }, URI);
    const msg = conv!.messages[0]!;
    expect(msg).toEqual({ role: 'user', text: 'x' });
    expect(msg.refId).toBeUndefined();
    expect(msg.sourceId).toBeUndefined();
    expect(msg.parentRef).toBeUndefined();
    expect(msg.createdAt).toBeUndefined();
    expect(conv!.sourceId).toBeUndefined();
  });

  it('preserves message text verbatim (unicode, emoji, fenced code)', () => {
    const body = "```python\nprint('Héllo, 世界! 🌍')\n```";
    const [conv] = parseClaude({ chat_messages: [{ sender: 'assistant', text: body }] }, URI);
    expect(conv!.messages[0]!.text).toBe(body);
  });
});

describe('ChatGPT parser — text extraction & deterministic linearization', () => {
  it('joins string parts with newlines and reads multimodal object parts', () => {
    const [conv] = parseChatGpt(
      {
        mapping: {
          n1: {
            id: 'n1',
            message: { author: { role: 'user' }, content: { parts: ['line one', { text: 'line two' }, 3] } },
            parent: null,
            children: [],
          },
        },
      },
      URI,
    );
    expect(conv!.messages[0]!.text).toBe('line one\nline two');
  });

  it('linearizes a branch pre-order: prompt, then sibling replies in source order', () => {
    const [conv] = parseChatGpt(
      {
        mapping: {
          root: { id: 'root', message: null, parent: null, children: ['u1'] },
          u1: { id: 'u1', message: { author: { role: 'user' }, content: { parts: ['Q'] } }, parent: 'root', children: ['a1', 'a2'] },
          a1: { id: 'a1', message: { author: { role: 'assistant' }, content: { parts: ['A1'] } }, parent: 'u1', children: [] },
          a2: { id: 'a2', message: { author: { role: 'assistant' }, content: { parts: ['A2'] } }, parent: 'u1', children: [] },
        },
      },
      URI,
    );
    expect(conv!.messages.map((m) => m.refId)).toEqual(['u1', 'a1', 'a2']);
    expect(conv!.messages.map((m) => m.text)).toEqual(['Q', 'A1', 'A2']);
  });

  it('visits multiple roots in ascending id order', () => {
    const [conv] = parseChatGpt(
      {
        mapping: {
          z1: { id: 'z1', message: { author: { role: 'user' }, content: { parts: ['Z'] } }, parent: null, children: [] },
          a1: { id: 'a1', message: { author: { role: 'user' }, content: { parts: ['A'] } }, parent: null, children: [] },
        },
      },
      URI,
    );
    expect(conv!.messages.map((m) => m.text)).toEqual(['A', 'Z']);
  });

  it('terminates on a cycle and still sweeps every message-bearing node', () => {
    const [conv] = parseChatGpt(
      {
        mapping: {
          x: { id: 'x', message: { author: { role: 'user' }, content: { parts: ['X'] } }, parent: 'y', children: ['y'] },
          y: { id: 'y', message: { author: { role: 'assistant' }, content: { parts: ['Y'] } }, parent: 'x', children: ['x'] },
        },
      },
      URI,
    );
    expect(conv!.messages.map((m) => m.text).sort()).toEqual(['X', 'Y']);
  });

  it('uses the message id as source id, falling back to the mapping-node id', () => {
    const [conv] = parseChatGpt(
      {
        mapping: {
          n1: { id: 'n1', message: { id: 'msg-1', author: { role: 'user' }, content: { parts: ['a'] } }, parent: null, children: [] },
          n2: { id: 'n2', message: { author: { role: 'assistant' }, content: { parts: ['b'] } }, parent: 'n1', children: [] },
        },
      },
      URI,
    );
    expect(conv!.messages[0]!.sourceId).toBe('msg-1');
    expect(conv!.messages[1]!.sourceId).toBe('n2');
  });
});

describe('parseExport — dispatch, empties, and located rejections', () => {
  it('parses a single object and a corpus array alike', () => {
    expect(parseExport('{"chat_messages":[]}', URI)).toHaveLength(1);
    expect(parseExport('[{"chat_messages":[]},{"chat_messages":[]}]', URI)).toHaveLength(2);
  });

  it('treats an empty export array as zero conversations, not an error', () => {
    expect(parseExport('[]', URI)).toEqual([]);
  });

  it('rejects malformed JSON with a located error naming the uri', () => {
    let err: unknown;
    try {
      parseExport('{ not json', URI);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConversationParseError);
    expect((err as ConversationParseError).uri).toBe(URI);
    expect((err as Error).message).toContain('not valid JSON');
  });

  it('rejects JSON no parser recognizes', () => {
    expect(() => parseExport('{"unrelated":true}', URI)).toThrow(ConversationParseError);
  });

  it('rejects raw text carrying a real NUL byte before parsing', () => {
    const raw = 'a' + NUL + 'b';
    expect(containsNul(raw)).toBe(true);
    expect(() => parseExport(raw, URI)).toThrow(/not text/);
  });

  it('rejects a decoded-NUL Claude message with format & locator', () => {
    // The raw source holds the escape (no real NUL); JSON.parse decodes a NUL.
    const raw =
      '[{"uuid":"c","name":"n","chat_messages":[{"sender":"human","text":"a' + BACKSLASH_U0000 + 'b"}]}]';
    expect(containsNul(raw)).toBe(false);
    let err: unknown;
    try {
      parseExport(raw, URI);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConversationParseError);
    expect((err as ConversationParseError).format).toBe('claude');
    expect((err as Error).message).toContain('NUL');
  });

  it('rejects a decoded-NUL ChatGPT message', () => {
    const raw =
      '{"title":"t","current_node":"n1","mapping":{"n1":{"id":"n1","message":{"author":{"role":"user"},"content":{"parts":["a' +
      BACKSLASH_U0000 +
      'b"]}},"parent":null,"children":[]}}}';
    expect(containsNul(raw)).toBe(false);
    expect(() => parseExport(raw, URI)).toThrow(/NUL/);
  });

  it('stays usable after a rejection (pure, no poisoned state)', () => {
    expect(() => parseExport('{ bad', URI)).toThrow();
    expect(parseExport('{"chat_messages":[]}', URI)).toHaveLength(1);
  });
});

describe('located errors — conversation & message coordinates', () => {
  it('names the conversation index for a non-object conversation', () => {
    let err: unknown;
    try {
      parseClaude([{ chat_messages: [] }, 5], URI);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConversationParseError);
    expect((err as ConversationParseError).at).toBe('[1]');
    expect((err as ConversationParseError).format).toBe('claude');
  });

  it('names the message path for a non-object chat message', () => {
    let err: unknown;
    try {
      parseClaude([{ chat_messages: [{ sender: 'human', text: 'ok' }, 7] }], URI);
    } catch (e) {
      err = e;
    }
    expect((err as ConversationParseError).at).toBe('[0].chat_messages[1]');
  });
});
