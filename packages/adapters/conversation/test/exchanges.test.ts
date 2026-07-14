/**
 * The exchange grouping rule (§7.2.1) — pure, total, format-independent. An
 * exchange is a `user` prompt plus every reply up to (not including) the next
 * `user` prompt; leading non-user messages form the first exchange; the rule
 * reads only role and order, never parent pointers. Every shape 9B must handle
 * is pinned here: empty, one-message, alternating, leading system, consecutive
 * user, branched (sibling replies), and missing parents.
 */
import { describe, expect, it } from 'vitest';
import { groupExchanges } from '../src/index.js';
import type { RawMessage } from '../src/format/types.js';

const msg = (role: string, text: string, extra: Partial<RawMessage> = {}): RawMessage => ({
  role,
  text,
  ...extra,
});

/** Compact view of a grouping: the role sequence of each exchange. */
const roles = (groups: RawMessage[][]): string[][] => groups.map((g) => g.map((m) => m.role));

describe('groupExchanges', () => {
  it('empty conversation → no exchanges', () => {
    expect(groupExchanges([])).toEqual([]);
  });

  it('one message → a single exchange holding it (whatever its role)', () => {
    expect(roles(groupExchanges([msg('user', 'hi')]))).toEqual([['user']]);
    expect(roles(groupExchanges([msg('assistant', 'greeting')]))).toEqual([['assistant']]);
  });

  it('alternating user/assistant → one exchange per user turn', () => {
    const groups = groupExchanges([
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
      msg('assistant', 'a2'),
    ]);
    expect(roles(groups)).toEqual([
      ['user', 'assistant'],
      ['user', 'assistant'],
    ]);
  });

  it('leading system/assistant preamble stays in the first exchange until the first user turn', () => {
    const groups = groupExchanges([
      msg('system', 'you are helpful'),
      msg('assistant', 'hello!'),
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
    ]);
    expect(roles(groups)).toEqual([
      ['system', 'assistant'],
      ['user', 'assistant'],
      ['user'],
    ]);
  });

  it('consecutive user messages each open a new exchange', () => {
    const groups = groupExchanges([msg('user', 'a'), msg('user', 'b'), msg('user', 'c')]);
    expect(roles(groups)).toEqual([['user'], ['user'], ['user']]);
  });

  it('branched replies (siblings of one prompt) all land in that prompt exchange, in order', () => {
    // A linearized ChatGPT regeneration: prompt then two assistant answers.
    const groups = groupExchanges([
      msg('user', 'Q'),
      msg('assistant', 'A1'),
      msg('assistant', 'A2'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((m) => m.text)).toEqual(['Q', 'A1', 'A2']);
  });

  it('ignores parent pointers entirely: grouping is by role and position only', () => {
    const withParents = [
      msg('user', 'q', { refId: 'u', parentRef: 'ghost' }),
      msg('assistant', 'a', { refId: 'a', parentRef: 'missing' }),
    ];
    const withoutParents = [msg('user', 'q'), msg('assistant', 'a')];
    expect(roles(groupExchanges(withParents))).toEqual(roles(groupExchanges(withoutParents)));
    expect(roles(groupExchanges(withParents))).toEqual([['user', 'assistant']]);
  });

  it('does not mutate the input array', () => {
    const input = [msg('user', 'a'), msg('assistant', 'b')];
    const snapshot = [...input];
    groupExchanges(input);
    expect(input).toEqual(snapshot);
  });
});
